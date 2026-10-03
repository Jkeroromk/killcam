//! Turning recorded sessions into matches, highlights, clips and exports.

use crate::ffmpeg::{self, IDLE_PRIORITY_CLASS};
use crate::gamelog;
use crate::pubg;
use crate::recorder::{self, now_ms, Segment, SessionMeta};
use crate::settings::{EventRules, Settings};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GameEvent {
    pub id: String,
    /// kill | knock | death | knocked | win | manual
    pub kind: String,
    /// seconds into the match video
    pub t: f64,
    pub wall_ms: i64,
    pub victim: Option<String>,
    pub weapon: Option<String>,
    pub distance_m: Option<f64>,
    pub headshot: bool,
    /// telemetry | hotkey
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Highlight {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub kinds: Vec<String>,
    pub title: String,
    /// clip file inside the match folder (highlights mode)
    pub file: Option<String>,
    /// match time of the clip's first frame (stream-copy cuts start on the keyframe before `start`)
    pub file_start: Option<f64>,
    /// still image for the highlight list
    pub thumb: Option<String>,
    /// range the rules picked, kept once the user trims start / end
    pub orig_start: Option<f64>,
    pub orig_end: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MatchStats {
    pub kills: u32,
    pub knocks: u32,
    pub damage: f64,
    pub place: u32,
    pub teams: u32,
    pub headshots: u32,
    pub longest_kill: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MatchRecord {
    pub id: String,
    /// match | session
    pub kind: String,
    pub pubg_match_id: Option<String>,
    pub created_at_ms: i64,
    pub map_name: String,
    pub map_label: String,
    pub game_mode: String,
    pub duration_s: f64,
    pub video: Option<String>,
    pub video_start_ms: i64,
    pub events: Vec<GameEvent>,
    pub highlights: Vec<Highlight>,
    pub stats: Option<MatchStats>,
    pub favorite: bool,
    pub thumbnail: Option<String>,
    pub size_bytes: u64,
    pub has_game_audio: bool,
    pub has_mic: bool,
    pub width: u32,
    pub height: u32,
    pub encoder: String,
    /// absolute folder, filled in when loading
    pub dir: String,
    /// absolute folder of the still images, filled in when loading
    pub thumb_dir: String,
    /// built from screen reading right after the game; PUBG's match data
    /// (map, placement, exact events) replaces it when it arrives
    pub pending_api: bool,
}

pub struct Lib {
    pub root: PathBuf,
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = fs::read_dir(p) {
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                total += dir_size(&e.path());
            } else {
                total += md.len();
            }
        }
    }
    total
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

fn local_stamp(ms: i64, fmt: &str) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).format(fmt).to_string())
        .unwrap_or_else(|| "unknown".into())
}

pub fn kind_label(k: &str) -> &'static str {
    match k {
        "kill" => "击杀",
        "knock" => "击倒",
        "death" => "阵亡",
        "knocked" => "被击倒",
        "win" => "吃鸡",
        "manual" => "手动标记",
        _ => "事件",
    }
}

impl Lib {
    pub fn new(root: &Path) -> Self {
        let lib = Self {
            root: root.to_path_buf(),
        };
        for d in ["matches", "_sessions", "exports", "_cache", "_tmp"] {
            let _ = fs::create_dir_all(lib.root.join(d));
        }
        lib
    }
    pub fn matches_dir(&self) -> PathBuf {
        self.root.join("matches")
    }
    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("_sessions")
    }
    pub fn exports_dir(&self) -> PathBuf {
        self.root.join("exports")
    }
    pub fn tmp_dir(&self) -> PathBuf {
        self.root.join("_tmp")
    }

    pub fn list(&self) -> Vec<MatchRecord> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(self.matches_dir()) {
            for e in rd.flatten() {
                if let Some(m) = self.load_dir(&e.path()) {
                    out.push(m);
                }
            }
        }
        out.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
        out
    }

    fn load_dir(&self, dir: &Path) -> Option<MatchRecord> {
        let s = fs::read_to_string(dir.join("match.json")).ok()?;
        let mut m: MatchRecord = serde_json::from_str(&s).ok()?;
        m.dir = dir.to_string_lossy().to_string();
        let name = dir.file_name()?.to_string_lossy().to_string();
        m.thumb_dir = self.thumbs_dir(&name).to_string_lossy().to_string();
        Some(m)
    }

    pub fn get(&self, id: &str) -> Option<MatchRecord> {
        self.load_dir(&self.matches_dir().join(id))
    }

    pub fn save(&self, m: &MatchRecord) -> Result<(), String> {
        let dir = self.matches_dir().join(&m.id);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut copy = m.clone();
        copy.dir = String::new();
        copy.thumb_dir = String::new();
        let j = serde_json::to_string_pretty(&copy).map_err(|e| e.to_string())?;
        fs::write(dir.join("match.json"), j).map_err(|e| e.to_string())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
            return Err("bad id".into());
        }
        let _ = fs::remove_dir_all(self.thumbs_dir(id));
        fs::remove_dir_all(self.matches_dir().join(id)).map_err(|e| e.to_string())
    }

    /// Hide KillCam's working folders in Explorer; only `matches` and `exports`
    /// are meant for people.
    pub fn hide_internal_dirs(&self) {
        #[cfg(windows)]
        for d in ["_cache", "_sessions", "_tmp"] {
            let p = self.root.join(d);
            if p.exists() {
                let _ = ffmpeg::hidden("attrib").arg("+h").arg(&p).status();
            }
        }
    }

    /// Still images live outside the match folder, so that folder only holds
    /// the videos (and match.json).
    pub fn thumbs_dir(&self, id: &str) -> PathBuf {
        self.root.join("_cache").join("thumbs").join(id)
    }

    /// Move stills left in match folders by older versions into the cache.
    pub fn migrate_thumbs(&self) {
        let Ok(rd) = fs::read_dir(self.matches_dir()) else {
            return;
        };
        for e in rd.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            let Ok(files) = fs::read_dir(&dir) else {
                continue;
            };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if !name.to_ascii_lowercase().ends_with(".jpg") {
                    continue;
                }
                let to = self.thumbs_dir(&id);
                if fs::create_dir_all(&to).is_ok() {
                    let _ = fs::rename(f.path(), to.join(&name));
                }
            }
        }
    }

    /// Short folder name for a match: `261001-2130`, `-2`, `-3`… on a clash.
    pub fn new_id(&self, created_ms: i64) -> String {
        let base = local_stamp(created_ms, "%y%m%d-%H%M");
        let mut id = base.clone();
        let mut n = 2;
        while self.matches_dir().join(&id).exists() {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }

    /// Rename folders from the old long format (`20261001-213012_ab12cd34`).
    pub fn migrate_ids(&self) {
        let mut all = self.list();
        all.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms));
        for m in all {
            if !m.id.contains('_') {
                continue;
            }
            let new = self.new_id(m.created_at_ms);
            if fs::rename(&m.dir, self.matches_dir().join(&new)).is_ok() {
                let _ = fs::rename(self.thumbs_dir(&m.id), self.thumbs_dir(&new));
                let mut r = m.clone();
                r.id = new;
                let _ = self.save(&r);
            }
        }
    }

    pub fn has_pubg_match(&self, pubg_id: &str) -> bool {
        self.list()
            .iter()
            .any(|m| m.pubg_match_id.as_deref() == Some(pubg_id))
    }

    pub fn usage_bytes(&self) -> u64 {
        dir_size(&self.matches_dir())
            + dir_size(&self.sessions_dir())
            + dir_size(&self.exports_dir())
    }

    /// Delete the oldest non-favorite matches until under the limit.
    pub fn enforce_limit(&self, limit_gb: u32) -> u32 {
        if limit_gb == 0 {
            return 0;
        }
        let limit = limit_gb as u64 * 1024 * 1024 * 1024;
        let mut used = self.usage_bytes();
        let mut removed = 0;
        let mut all = self.list();
        all.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms));
        for m in all {
            if used <= limit {
                break;
            }
            if m.favorite {
                continue;
            }
            let sz = dir_size(Path::new(&m.dir));
            if self.delete(&m.id).is_ok() {
                used = used.saturating_sub(sz);
                removed += 1;
            }
        }
        removed
    }
}

// ---------------------------------------------------------------------------
// highlights

pub fn compute_highlights(
    events: &[GameEvent],
    rules: &EventRules,
    duration: f64,
) -> Vec<Highlight> {
    let mut wins: Vec<(f64, f64, String)> = Vec::new();
    for e in events {
        let Some(r) = rules.get(&e.kind) else {
            continue;
        };
        // a hotkey press is an explicit request: always keep it
        if !r.enabled && e.kind != "manual" {
            continue;
        }
        let a = (e.t - r.pre).max(0.0);
        let b = (e.t + r.post).min(if duration > 0.0 { duration } else { f64::MAX });
        if b > a {
            wins.push((a, b, e.kind.clone()));
        }
    }
    wins.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<(f64, f64, Vec<String>)> = Vec::new();
    for (a, b, k) in wins {
        if let Some(last) = merged.last_mut() {
            if a <= last.1 + 2.0 {
                last.1 = last.1.max(b);
                last.2.push(k);
                continue;
            }
        }
        merged.push((a, b, vec![k]));
    }
    merged
        .into_iter()
        .enumerate()
        .map(|(i, (a, b, kinds))| Highlight {
            id: format!("h{:02}", i + 1),
            start: a,
            end: b,
            title: highlight_title(&kinds),
            kinds,
            file: None,
            file_start: None,
            thumb: None,
            orig_start: None,
            orig_end: None,
        })
        .collect()
}

pub fn highlight_title(kinds: &[String]) -> String {
    let order = ["win", "kill", "knock", "manual", "knocked", "death"];
    let mut parts = Vec::new();
    for k in order {
        let n = kinds.iter().filter(|x| x.as_str() == k).count();
        if n == 0 {
            continue;
        }
        if k == "win" {
            parts.push("吃鸡".to_string());
        } else if n == 1 {
            parts.push(kind_label(k).to_string());
        } else {
            parts.push(format!("{} {}", n, kind_label(k)));
        }
    }
    if parts.is_empty() {
        "高光".into()
    } else {
        parts.join(" + ")
    }
}

// ---------------------------------------------------------------------------
// building a match out of session segments

fn write_concat_list(session_dir: &Path, segs: &[&Segment], name: &str) -> Result<PathBuf, String> {
    let mut s = String::from("ffconcat version 1.0\n");
    for seg in segs {
        s.push_str(&format!("file '{}'\n", seg.file.replace('\'', "'\\''")));
        // explicit durations: probed TS durations run ~0.04 s long each, which
        // adds up to seconds of drift over a match
        s.push_str(&format!(
            "duration {:.6}\n",
            (seg.end - seg.start).max(0.01)
        ));
    }
    let p = session_dir.join(name);
    fs::write(&p, s).map_err(|e| e.to_string())?;
    Ok(p)
}

/// Map a wall-clock time onto the concatenated video. Times that fall into a
/// gap between parts snap to the start of the next recorded segment.
fn wall_to_t(chosen: &[&Segment], start_ms: i64, wall: i64) -> f64 {
    let w = wall as f64;
    let mut acc = 0.0;
    for s in chosen {
        let a = start_ms as f64 + s.start * 1000.0;
        let b = start_ms as f64 + s.end * 1000.0;
        if w < a {
            return acc;
        }
        if w <= b {
            return acc + (w - a) / 1000.0;
        }
        acc += s.end - s.start;
    }
    acc
}

/// Stream-copy segments into one mp4 with: v, mix, game, mic.
fn remux(
    ffmpeg_path: &Path,
    session_dir: &Path,
    list: &Path,
    out: &Path,
    meta: &SessionMeta,
) -> Result<(), String> {
    let s = |v: &str| v.to_string();
    let mut a: Vec<String> = vec![
        s("-hide_banner"),
        s("-loglevel"),
        s("error"),
        s("-y"),
        s("-f"),
        s("concat"),
        s("-safe"),
        s("0"),
        s("-i"),
        list.to_string_lossy().to_string(),
    ];
    let tracks = (meta.has_game_audio as u8) + (meta.has_mic as u8);
    match tracks {
        2 => {
            a.extend([
                s("-filter_complex"),
                s("[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0[mix]"),
                s("-map"),
                s("0:v:0"),
                s("-map"),
                s("[mix]"),
                s("-map"),
                s("0:a:0"),
                s("-map"),
                s("0:a:1"),
                s("-c:v"),
                s("copy"),
                s("-c:a:0"),
                s("aac"),
                s("-b:a:0"),
                s("192k"),
                s("-c:a:1"),
                s("copy"),
                s("-c:a:2"),
                s("copy"),
                s("-metadata:s:a:0"),
                s("title=混音"),
                s("-metadata:s:a:1"),
                s("title=游戏"),
                s("-metadata:s:a:2"),
                s("title=麦克风"),
            ]);
        }
        1 => {
            a.extend([
                s("-map"),
                s("0:v:0"),
                s("-map"),
                s("0:a:0"),
                s("-c"),
                s("copy"),
            ]);
        }
        _ => {
            a.extend([s("-map"), s("0:v:0"), s("-c"), s("copy")]);
        }
    }
    if meta.encoder.starts_with("hevc") {
        a.extend([s("-tag:v"), s("hvc1")]);
    }
    a.extend([
        s("-movflags"),
        s("+faststart"),
        out.to_string_lossy().to_string(),
    ]);
    let mut cmd = ffmpeg::command(ffmpeg_path, IDLE_PRIORITY_CLASS);
    cmd.args(&a).current_dir(session_dir);
    let o = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(())
    } else {
        Err(format!(
            "合并录像失败：{}",
            ffmpeg::tail(&String::from_utf8_lossy(&o.stderr), 6)
        ))
    }
}

fn make_thumb(ffmpeg_path: &Path, video: &Path, t: f64, out: &Path) {
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{:.2}", t.max(0.0)),
        "-i".into(),
        video.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        // 16:9 centre crop so ultrawide recordings fill the cards
        "crop=w='min(iw,ih*16/9)':h=ih,scale=640:-2".into(),
        "-q:v".into(),
        "4".into(),
        out.to_string_lossy().to_string(),
    ];
    let _ = ffmpeg::run(ffmpeg_path, &args, IDLE_PRIORITY_CLASS);
}

/// Stream-copy a range (keyframe aligned) — cheap enough to run while gaming.
fn cut_copy(
    ffmpeg_path: &Path,
    src: &Path,
    start: f64,
    end: f64,
    out: &Path,
) -> Result<(), String> {
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{:.3}", start.max(0.0)),
        "-i".into(),
        src.to_string_lossy().to_string(),
        "-t".into(),
        format!("{:.3}", (end - start).max(0.5)),
        "-map".into(),
        "0".into(),
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        out.to_string_lossy().to_string(),
    ];
    ffmpeg::run_ok(ffmpeg_path, &args, IDLE_PRIORITY_CLASS)
}

/// Remux just the segments around [a, b] (match time on the concatenated
/// timeline) and stream-copy the range out of that.
#[allow(clippy::too_many_arguments)]
fn cut_highlight(
    ffmpeg_path: &Path,
    session_dir: &Path,
    chosen: &[&Segment],
    meta: &SessionMeta,
    tag: &str,
    a: f64,
    b: f64,
    out: &Path,
) -> Result<(), String> {
    let mut acc = 0.0;
    let mut offset: Option<f64> = None;
    let mut pick: Vec<&Segment> = Vec::new();
    for seg in chosen {
        let len = seg.end - seg.start;
        // every segment starts on a keyframe, so starting at the one holding `a` is enough
        if acc + len > a && acc < b {
            if offset.is_none() {
                offset = Some(acc);
            }
            pick.push(*seg);
        }
        acc += len;
    }
    let off = offset.ok_or("这段没有录像")?;
    let list = write_concat_list(session_dir, &pick, &format!("concat_{tag}.txt"))?;
    let tmp = out.with_extension("part.mp4");
    let res = remux(ffmpeg_path, session_dir, &list, &tmp, meta);
    let _ = fs::remove_file(&list);
    res?;
    let res = cut_copy(ffmpeg_path, &tmp, a - off, b - off, out);
    let _ = fs::remove_file(&tmp);
    res
}

pub struct BuildInput<'a> {
    pub kind: &'a str,
    pub title_time_ms: i64,
    pub window: (i64, i64),
    pub events: Vec<GameEvent>,
    pub pubg: Option<&'a pubg::MatchInfo>,
    pub stats: Option<MatchStats>,
    /// keep the full video even in highlights mode
    pub clips_only: bool,
    /// (map label, mode label) from PUBG's log for games without API data
    pub labels: Option<(String, String)>,
    /// replace this existing record (keeps its id and favorite flag)
    pub reuse_id: Option<String>,
    /// a quick record that PUBG's data will replace
    pub pending_api: bool,
    /// mark the markers / screen detections it used as taken (not for quick records:
    /// the real record still needs them)
    pub mark_used: bool,
}

/// Build one library entry from session segments within [window].
pub fn build_record(
    lib: &Lib,
    ffmpeg_path: &Path,
    settings: &Settings,
    session_dir: &Path,
    meta: &mut SessionMeta,
    segs: &[Segment],
    input: BuildInput,
) -> Result<Option<MatchRecord>, String> {
    let (w0, w1) = input.window;
    let start_ms = meta.start_ms;
    let chosen: Vec<&Segment> = segs
        .iter()
        .filter(|s| {
            let a = start_ms + (s.start * 1000.0) as i64;
            let b = start_ms + (s.end * 1000.0) as i64;
            a < w1 && b > w0
        })
        .collect();
    if chosen.is_empty() {
        return Ok(None);
    }
    let first = chosen[0].start;
    let video_start_ms = start_ms + (first * 1000.0) as i64;
    // gaps between parts are dropped by the concat, so sum real segment lengths
    let duration: f64 = chosen.iter().map(|s| s.end - s.start).sum();
    let to_t = |wall: i64| wall_to_t(&chosen, start_ms, wall);

    let mut favorite = false;
    let id = match &input.reuse_id {
        Some(old) => {
            if let Some(r) = lib.get(old) {
                favorite = r.favorite;
                let _ = lib.delete(old);
            }
            old.clone()
        }
        None => lib.new_id(input.title_time_ms),
    };
    let dir = lib.matches_dir().join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // events -> video time; attach manual markers inside the window
    let offset = settings.telemetry_offset_ms;
    let mut events = input.events;
    for e in events.iter_mut() {
        e.t = to_t(e.wall_ms + offset);
    }
    for &mk in meta.markers.clone().iter() {
        if mk >= w0 && mk <= w1 && !meta.used_markers.contains(&mk) {
            events.push(GameEvent {
                id: String::new(),
                kind: "manual".into(),
                t: to_t(mk),
                wall_ms: mk,
                source: "hotkey".into(),
                ..Default::default()
            });
            if input.mark_used {
                meta.used_markers.push(mk);
            }
        }
    }
    // screen detections: used directly when there is no telemetry for this span
    for d in meta.detections.clone().iter() {
        if d.at_ms >= w0 && d.at_ms <= w1 && !meta.used_detections.contains(&d.at_ms) {
            if input.mark_used {
                meta.used_detections.push(d.at_ms);
            }
            if input.pubg.is_some() {
                continue;
            }
            events.push(GameEvent {
                id: String::new(),
                kind: d.kind.clone(),
                t: to_t(d.at_ms),
                wall_ms: d.at_ms,
                source: "screen".into(),
                ..Default::default()
            });
        }
    }
    events.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    for (i, e) in events.iter_mut().enumerate() {
        e.id = format!("e{:03}", i + 1);
    }
    let mut highlights = compute_highlights(&events, &settings.events, duration);

    // a still per highlight, taken just after its first kill / knock / win
    let moment = |h: &Highlight| -> f64 {
        events
            .iter()
            .filter(|e| e.t >= h.start && e.t <= h.end)
            .filter(|e| matches!(e.kind.as_str(), "kill" | "knock" | "win"))
            .map(|e| e.t + 0.4)
            .next()
            .unwrap_or((h.start + h.end) / 2.0)
            .min(h.end)
    };

    // with nothing to cut, keep the whole thing instead of ending up with nothing
    let mut keep_video =
        (settings.capture_mode != "highlights" && !input.clips_only) || highlights.is_empty();
    let video_path = dir.join("match.mp4");
    if !keep_video {
        // only the segments around each highlight are read and written, instead of
        // remuxing the whole match first (gigabytes) and cutting from that
        for h in highlights.iter_mut() {
            let name = format!("{}.mp4", h.id);
            let clip = dir.join(&name);
            let tag = format!("{}_{}", id, h.id);
            if cut_highlight(
                ffmpeg_path,
                session_dir,
                &chosen,
                meta,
                &tag,
                h.start,
                h.end,
                &clip,
            )
            .is_ok()
            {
                // the copy starts on the keyframe before `start` and ends at `end`
                h.file_start = ffmpeg::probe_duration(ffmpeg_path, &clip)
                    .map(|d| (h.end - d).clamp(h.start - 3.0, h.start));
                h.file = Some(name);
            }
        }
        if highlights.iter().all(|h| h.file.is_none()) {
            keep_video = true;
        }
    }
    if keep_video {
        for h in highlights.iter_mut() {
            h.file = None;
            h.file_start = None;
        }
        let list = write_concat_list(session_dir, &chosen, &format!("concat_{}.txt", id))?;
        let res = remux(ffmpeg_path, session_dir, &list, &video_path, meta);
        let _ = fs::remove_file(&list);
        res?;
    }
    // stills come from whichever file holds that moment
    let still_src = |h: &Highlight| -> Option<(PathBuf, f64)> {
        if keep_video {
            Some((video_path.clone(), moment(h)))
        } else {
            h.file
                .as_ref()
                .map(|f| (dir.join(f), moment(h) - h.file_start.unwrap_or(h.start)))
        }
    };
    let tdir = lib.thumbs_dir(&id);
    let _ = fs::create_dir_all(&tdir);
    for h in highlights.iter_mut() {
        let name = format!("{}.jpg", h.id);
        if let Some((src, t)) = still_src(h) {
            make_thumb(ffmpeg_path, &src, t, &tdir.join(&name));
        }
        if tdir.join(&name).exists() {
            h.thumb = Some(name);
        }
    }
    // cover: the best highlight (win, then most kills)
    let score = |h: &Highlight| -> i32 {
        h.kinds
            .iter()
            .map(|k| match k.as_str() {
                "win" => 100,
                "kill" => 10,
                "knock" => 3,
                _ => 1,
            })
            .sum()
    };
    let thumb = tdir.join("thumb.jpg");
    match highlights
        .iter()
        .max_by_key(|h| score(h))
        .and_then(|h| still_src(h))
    {
        Some((src, t)) => make_thumb(ffmpeg_path, &src, t, &thumb),
        None if keep_video => make_thumb(ffmpeg_path, &video_path, duration / 2.0, &thumb),
        None => {}
    }

    let (map_name, mut game_mode) = input
        .pubg
        .map(|p| (p.map_name.clone(), pubg::mode_label(&p.game_mode)))
        .unwrap_or_default();
    if input.pubg.is_none() {
        if let Some((_, mode)) = &input.labels {
            game_mode = mode.clone();
        }
    }
    let rec = MatchRecord {
        id: id.clone(),
        kind: input.kind.to_string(),
        pubg_match_id: input.pubg.map(|p| p.id.clone()),
        created_at_ms: input.title_time_ms,
        map_label: if input.pubg.is_some() {
            pubg::map_label(&map_name)
        } else if let Some((map, _)) = &input.labels {
            map.clone()
        } else if events.iter().any(|e| e.source == "screen") {
            "自定义 / 训练".into()
        } else {
            "手动片段".into()
        },
        map_name,
        game_mode,
        duration_s: duration,
        video: if keep_video {
            Some("match.mp4".into())
        } else {
            None
        },
        video_start_ms,
        events,
        highlights,
        stats: input.stats,
        favorite,
        thumbnail: if thumb.exists() {
            Some("thumb.jpg".into())
        } else {
            None
        },
        size_bytes: dir_size(&dir),
        has_game_audio: meta.has_game_audio,
        has_mic: meta.has_mic,
        width: meta.width,
        height: meta.height,
        encoder: meta.encoder.clone(),
        dir: String::new(),
        thumb_dir: String::new(),
        pending_api: input.pending_api,
    };
    lib.save(&rec)?;
    let mut out = rec;
    out.dir = dir.to_string_lossy().to_string();
    out.thumb_dir = tdir.to_string_lossy().to_string();
    Ok(Some(out))
}

// ---------------------------------------------------------------------------
// processing pass over all pending sessions

pub struct PassResult {
    pub new_records: Vec<MatchRecord>,
    pub messages: Vec<String>,
    /// an ended session is waiting for PUBG's match data: minutes left at most
    pub waiting_minutes: Option<i64>,
}

/// `active_session`: id of the session currently being recorded (never finalized).
pub fn process_sessions(
    lib: &Lib,
    ffmpeg_path: &Path,
    settings: &mut Settings,
    active_session: Option<&str>,
    force_final: bool,
    mut progress: impl FnMut(&str),
) -> PassResult {
    let mut result = PassResult {
        new_records: Vec::new(),
        messages: Vec::new(),
        waiting_minutes: None,
    };
    let Ok(rd) = fs::read_dir(lib.sessions_dir()) else {
        return result;
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    // fetch the player's recent matches once per pass
    let api = if settings.pubg.configured() {
        Some(pubg::Api::new(&settings.pubg.api_key, &settings.pubg.shard))
    } else {
        None
    };
    let mut recent: Option<Vec<String>> = None;
    let mut api_error: Option<String> = None;

    for dir in dirs {
        let Some(mut meta) = SessionMeta::load(&dir) else {
            continue;
        };
        if meta.finalized {
            // finished earlier but the folder could not be removed then
            if meta.finalize_failures < 3 {
                let _ = fs::remove_dir_all(&dir);
            }
            continue;
        }
        let is_active = active_session == Some(meta.id.as_str());
        if meta.test {
            if !is_active {
                let _ = fs::remove_dir_all(&dir);
            }
            continue;
        }
        // a session nobody is recording any more but that never got stopped
        // (app closed or restarted mid-game): treat it as ended now
        if !is_active && meta.ended_ms.is_none() {
            meta.ended_ms = Some(now_ms());
            meta.save(&dir);
        }
        let ended = meta.ended_ms.is_some() && !is_active;
        let segs = recorder::segments(ffmpeg_path, &dir, ended);
        if segs.is_empty() {
            if ended {
                let _ = fs::remove_dir_all(&dir);
            }
            continue;
        }
        let recorded_until = meta.start_ms + (segs[segs.len() - 1].end * 1000.0) as i64;

        if let Some(api) = &api {
            if recent.is_none() && api_error.is_none() {
                match api.player(&settings.pubg.player_name) {
                    Ok((acc, ids)) => {
                        settings.pubg.account_id = Some(acc);
                        recent = Some(ids);
                    }
                    Err(e) => api_error = Some(e),
                }
            }
            let me = settings.pubg.account_id.clone().unwrap_or_default();
            if let Some(ids) = &recent {
                for mid in ids.iter().take(12) {
                    if meta.processed_matches.contains(mid) || lib.has_pubg_match(mid) {
                        continue;
                    }
                    let info = match api.match_info(mid) {
                        Ok(i) => i,
                        Err(e) => {
                            result.messages.push(e);
                            continue;
                        }
                    };
                    let match_end_guess = info.created_at_ms + (info.duration_s * 1000.0) as i64;
                    if match_end_guess < meta.start_ms - 60_000 {
                        // older than this session; the list is newest first
                        break;
                    }
                    if info.created_at_ms > recorded_until {
                        continue;
                    }
                    progress(&format!("正在分析对局 {}", pubg::map_label(&info.map_name)));
                    let Some(url) = info.telemetry_url.clone() else {
                        continue;
                    };
                    let tele = match api.telemetry(&url) {
                        Ok(t) => t,
                        Err(e) => {
                            result.messages.push(e);
                            continue;
                        }
                    };
                    let mine = info
                        .participants
                        .iter()
                        .find(|p| p.account_id == me)
                        .cloned();
                    let won = mine.as_ref().map(|p| p.win_place == 1).unwrap_or(false);
                    let sum = pubg::summarize(&tele, &me, won);
                    let w0 = sum.match_start_ms.unwrap_or(info.created_at_ms) - 10_000;
                    let w1 = match (sum.death_ms, sum.match_end_ms) {
                        (Some(d), _) => d + 12_000,
                        (None, Some(e)) => e + 10_000,
                        _ => match_end_guess + 10_000,
                    };
                    if w1 > recorded_until && !ended {
                        // not fully recorded yet, try again next pass
                        continue;
                    }
                    if w1 < meta.start_ms {
                        meta.processed_matches.push(mid.clone());
                        meta.save(&dir);
                        continue;
                    }
                    // PUBG's server clock and this PC's clock differ by a second or so.
                    // Screen-read kills are exact on the video: line telemetry kills up with them.
                    let mut deltas: Vec<i64> = sum
                        .events
                        .iter()
                        .filter(|e| e.kind == "kill")
                        .filter_map(|e| {
                            meta.detections
                                .iter()
                                .filter(|d| d.kind == "kill")
                                .map(|d| d.at_ms - e.at_ms)
                                .filter(|dt| dt.abs() <= 3_000)
                                .min_by_key(|dt| dt.abs())
                        })
                        .collect();
                    deltas.sort();
                    let auto_offset = if deltas.len() >= 2 {
                        deltas[deltas.len() / 2]
                    } else {
                        0
                    };
                    let events: Vec<GameEvent> = sum
                        .events
                        .iter()
                        .map(|e| GameEvent {
                            id: String::new(),
                            kind: e.kind.clone(),
                            t: 0.0,
                            wall_ms: e.at_ms + auto_offset,
                            victim: e.victim.clone(),
                            weapon: e.weapon.clone(),
                            distance_m: e.distance_m,
                            headshot: e.headshot,
                            source: "telemetry".into(),
                        })
                        .collect();
                    let stats = mine.map(|p| MatchStats {
                        kills: p.kills,
                        knocks: p.dbnos,
                        damage: p.damage,
                        place: p.win_place,
                        teams: info.teams,
                        headshots: p.headshots,
                        longest_kill: p.longest_kill,
                    });
                    progress("正在生成录像和高光");
                    // the quick record for this game (if any) becomes the real one
                    let reuse = meta
                        .provisional
                        .iter()
                        .position(|p| p.from < w1 && p.to > w0)
                        .map(|i| meta.provisional.remove(i).id);
                    match build_record(
                        lib,
                        ffmpeg_path,
                        settings,
                        &dir,
                        &mut meta,
                        &segs,
                        BuildInput {
                            kind: "match",
                            title_time_ms: w0 + 10_000,
                            window: (w0, w1),
                            events,
                            pubg: Some(&info),
                            stats,
                            clips_only: false,
                            labels: None,
                            reuse_id: reuse,
                            pending_api: false,
                            mark_used: true,
                        },
                    ) {
                        Ok(Some(rec)) => {
                            meta.built_windows.push((w0, w1));
                            result.new_records.push(rec)
                        }
                        Ok(None) => {}
                        Err(e) => result.messages.push(e),
                    }
                    meta.processed_matches.push(mid.clone());
                    meta.save(&dir);
                }
            }
        }

        // Ended sessions. PUBG's log says which games were played: only battle
        // royale ones ever show up in the API, so arcade / custom / training games
        // are final right away. Battle royale games get a quick record from screen
        // reading right away too, and the real one replaces it when PUBG's match
        // data arrives (or the quick one stays, if it never does).
        if !ended {
            continue;
        }
        let joins = gamelog::joins(
            meta.start_ms - 120_000,
            meta.ended_ms.unwrap_or_else(now_ms) + 5_000,
        );
        let official_built = meta
            .processed_matches
            .iter()
            .filter(|mid| lib.has_pubg_match(mid))
            .count();
        let official_pending = joins.iter().filter(|j| j.official()).count() > official_built;
        // without the log we can't know, so wait for the API as before
        let nothing_to_wait_for = !joins.is_empty() && !official_pending;
        let waited_enough = nothing_to_wait_for
            || meta
                .ended_ms
                .map(|e| now_ms() - e > 15 * 60_000)
                .unwrap_or(false);
        let final_now = api.is_none() || waited_enough || force_final;
        if !final_now {
            let left = 15 - meta.ended_ms.map(|e| (now_ms() - e) / 60_000).unwrap_or(0);
            let left = left.clamp(1, 15);
            result.waiting_minutes = Some(result.waiting_minutes.map_or(left, |w| w.max(left)));
        }

        let mut left: Vec<i64> = meta
            .markers
            .iter()
            .copied()
            .filter(|m| !meta.used_markers.contains(m))
            .collect();
        left.extend(
            meta.detections
                .iter()
                .map(|d| d.at_ms)
                .filter(|t| !meta.used_detections.contains(t)),
        );
        left.sort();
        let full_session = api.is_none() && settings.capture_mode == "full";
        let mut failed = false;

        // one piece per game the log knows about (or the whole session)
        struct Piece {
            from: i64,
            to: i64,
            labels: Option<(String, String)>,
            /// may show up in PUBG's API (unknown without the log)
            official: bool,
        }
        let mut pieces: Vec<Piece> = Vec::new();
        if joins.is_empty() {
            pieces.push(Piece {
                from: i64::MIN,
                to: i64::MAX,
                labels: None,
                official: true,
            });
        } else {
            for (i, j) in joins.iter().enumerate() {
                pieces.push(Piece {
                    // anything before the first join belongs to the first game
                    from: if i == 0 { i64::MIN } else { j.at_ms },
                    to: joins.get(i + 1).map(|n| n.at_ms).unwrap_or(i64::MAX),
                    labels: Some(j.labels()),
                    official: j.official(),
                });
            }
        }
        let pre = settings.events.manual.pre.max(15.0) as i64 * 1000;
        let post = settings.events.manual.post.max(10.0) as i64 * 1000;
        for piece in &pieces {
            if meta.done_pieces.contains(&piece.from) {
                continue;
            }
            let in_piece = |t: i64| t >= piece.from && t < piece.to;
            let ev: Vec<i64> = left.iter().copied().filter(|t| in_piece(*t)).collect();
            let quick = meta.provisional.iter().position(|p| p.from == piece.from);

            if !final_now && piece.official {
                // waiting for PUBG's data: show what screen reading found meanwhile
                let built = !joins.is_empty()
                    && meta
                        .built_windows
                        .iter()
                        .any(|(a, b)| *a < piece.to && *b > piece.from);
                if built || quick.is_some() || ev.is_empty() {
                    continue;
                }
                let (Some(a), Some(b)) = (ev.first(), ev.last()) else {
                    continue;
                };
                let w0 = (a - pre - 5_000).max(piece.from.saturating_sub(2_000));
                let w1 = (b + post + 5_000).min(piece.to);
                if w1 - w0 < 2_000 {
                    continue;
                }
                progress("正在生成这局的高光");
                match build_record(
                    lib,
                    ffmpeg_path,
                    settings,
                    &dir,
                    &mut meta,
                    &segs,
                    BuildInput {
                        kind: "session",
                        title_time_ms: if piece.from == i64::MIN {
                            w0.max(meta.start_ms)
                        } else {
                            piece.from
                        },
                        window: (w0, w1),
                        events: Vec::new(),
                        pubg: None,
                        stats: None,
                        clips_only: true,
                        labels: Some(("普通对局".into(), String::new())),
                        reuse_id: None,
                        pending_api: true,
                        mark_used: false,
                    },
                ) {
                    Ok(Some(rec)) => {
                        meta.provisional.push(recorder::Provisional {
                            from: piece.from,
                            to: piece.to,
                            id: rec.id.clone(),
                        });
                        meta.save(&dir);
                        result.new_records.push(rec);
                    }
                    Ok(None) => {}
                    Err(e) => result.messages.push(e),
                }
                continue;
            }

            if let Some(i) = quick {
                // PUBG's data never came (or we stopped waiting): the quick record is final
                let q = meta.provisional.remove(i);
                if let Some(mut rec) = lib.get(&q.id) {
                    rec.pending_api = false;
                    // waited it out and it never showed up in the API: a custom /
                    // training game after all (not when the user just stopped waiting)
                    if !force_final {
                        if let Some((map, mode)) = &piece.labels {
                            rec.map_label = map.clone();
                            rec.game_mode = mode.clone();
                        }
                    }
                    let _ = lib.save(&rec);
                    result.new_records.push(rec);
                }
                let taken: Vec<i64> = meta.markers.iter().copied().filter(|t| in_piece(*t)).collect();
                meta.used_markers.extend(taken);
                let seen: Vec<i64> = meta
                    .detections
                    .iter()
                    .map(|d| d.at_ms)
                    .filter(|t| in_piece(*t))
                    .collect();
                meta.used_detections.extend(seen);
                meta.done_pieces.push(piece.from);
                meta.save(&dir);
                continue;
            }

            let (w0, w1) = if full_session {
                (
                    piece.from.max(meta.start_ms - 1),
                    piece.to.min(recorded_until + 1),
                )
            } else if let (Some(a), Some(b)) = (ev.first(), ev.last()) {
                (
                    (a - pre - 5_000).max(piece.from.saturating_sub(2_000)),
                    (b + post + 5_000).min(piece.to),
                )
            } else {
                // nothing left in this game
                if final_now {
                    meta.done_pieces.push(piece.from);
                }
                continue;
            };
            if w1 - w0 < 2_000 {
                continue;
            }
            progress("正在保存这次录制的片段");
            let title_ms = if piece.from == i64::MIN {
                w0.max(meta.start_ms)
            } else {
                piece.from
            };
            match build_record(
                lib,
                ffmpeg_path,
                settings,
                &dir,
                &mut meta,
                &segs,
                BuildInput {
                    kind: "session",
                    title_time_ms: title_ms,
                    window: (w0, w1),
                    events: Vec::new(),
                    pubg: None,
                    stats: None,
                    clips_only: !full_session,
                    // bits of a game whose real record exists (e.g. a marker in the lobby)
                    labels: if piece.official
                        && meta
                            .built_windows
                            .iter()
                            .any(|(a, b)| *a < piece.to && *b > piece.from)
                    {
                        Some(("普通对局".into(), String::new()))
                    } else {
                        piece.labels.clone()
                    },
                    reuse_id: None,
                    pending_api: false,
                    mark_used: true,
                },
            ) {
                Ok(Some(rec)) => {
                    meta.done_pieces.push(piece.from);
                    result.new_records.push(rec)
                }
                Ok(None) => meta.done_pieces.push(piece.from),
                Err(e) => {
                    result.messages.push(e);
                    failed = true;
                }
            }
        }
        meta.save(&dir);
        if !final_now {
            continue;
        }
        if failed {
            // keep the raw recording; retry on the next passes
            meta.finalize_failures += 1;
            meta.save(&dir);
            if meta.finalize_failures < 3 {
                continue;
            }
            result.messages.push(format!(
                "这次录制处理失败了 3 次，原始文件保留在 {}",
                dir.to_string_lossy()
            ));
            meta.finalized = true;
            meta.save(&dir);
            continue;
        }
        meta.finalized = true;
        meta.save(&dir);
        if fs::remove_dir_all(&dir).is_err() {
            // usually Explorer holding a thumbnail open; try again later
            result
                .messages
                .push("临时录像文件夹暂时删不掉（可能在资源管理器里开着），稍后会再试".into());
        }
    }
    if let Some(e) = api_error {
        result.messages.push(e);
    }
    let removed = lib.enforce_limit(settings.storage_limit_gb);
    if removed > 0 {
        result
            .messages
            .push(format!("存储空间超出上限，已清理 {removed} 场旧录像"));
    }
    result
}

// ---------------------------------------------------------------------------
// exports

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// source | 16:9 | 9:16
    pub aspect: String,
    /// 0 = keep
    pub height: u32,
    /// mix | all
    pub audio: String,
    /// keep the file under this many MB (10^6 bytes) for Discord / WeChat; 0 = no limit
    #[serde(default)]
    pub size_mb: u32,
}

/// Bitrates that fit `dur` seconds into the size limit.
#[derive(Debug, Clone, Copy)]
struct Budget {
    video_kbps: u32,
    audio_kbps: u32,
    /// highest output height that still looks fine at this bitrate
    max_height: u32,
    /// halve the frame rate when bits are scarce
    fps30: bool,
}

fn budget_for(size_mb: u32, dur: f64, margin: f64) -> Result<Budget, String> {
    let dur = dur.max(1.0);
    let total = size_mb as f64 * 8000.0 * margin / dur;
    let audio = if total < 800.0 { 64 } else { 96 };
    let video = total - audio as f64;
    if video < 250.0 {
        let max_s = (size_mb as f64 * 8000.0 * 0.9 / 650.0).floor();
        return Err(format!(
            "这段有 {dur:.0} 秒，压到 {size_mb} MB 以内画面会糊掉。建议剪到 {max_s:.0} 秒以内，或者选大一点的上限"
        ));
    }
    let max_height = if video >= 3500.0 {
        1080
    } else if video >= 1500.0 {
        720
    } else {
        480
    };
    Ok(Budget {
        video_kbps: video as u32,
        audio_kbps: audio,
        max_height,
        fps30: video < 2500.0,
    })
}

fn even(v: u32) -> u32 {
    v - (v % 2)
}

fn export_filter(rec: &MatchRecord, o: &ExportOptions) -> Option<String> {
    let (w, h) = (rec.width, rec.height);
    match o.aspect.as_str() {
        "9:16" => {
            let oh = if o.height == 0 {
                1920
            } else {
                (o.height as f64 * 16.0 / 9.0).round() as u32
            };
            let ow = even((oh as f64 * 9.0 / 16.0).round() as u32);
            if h > 0 {
                let cw = even(h * 9 / 16);
                Some(format!("crop={}:{},scale={}:{}", cw, h, ow, even(oh)))
            } else {
                Some(format!("crop=ih*9/16:ih,scale={}:{}", ow, even(oh)))
            }
        }
        "16:9" => {
            let th = if o.height == 0 { h } else { o.height };
            if w > 0 && h > 0 && (w as u64) * 9 > (h as u64) * 16 {
                let cw = even(h * 16 / 9);
                if th > 0 && th < h {
                    Some(format!("crop={}:{},scale=-2:{}", cw, h, th))
                } else {
                    Some(format!("crop={}:{}", cw, h))
                }
            } else if th > 0 && th < h {
                Some(format!("scale=-2:{}", th))
            } else {
                None
            }
        }
        _ => {
            if o.height > 0 && (h == 0 || o.height < h) {
                Some(format!("scale=-2:{}", o.height))
            } else {
                None
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn encode_range(
    ffmpeg_path: &Path,
    encoder: &str,
    rec: &MatchRecord,
    src: &Path,
    start: f64,
    end: f64,
    o: &ExportOptions,
    out: &Path,
    budget: Option<Budget>,
) -> Result<(), String> {
    // a size limit: lower the resolution if needed, one mixed audio track
    let limited;
    let o = match budget {
        Some(b) => {
            limited = ExportOptions {
                height: if o.height == 0 || o.height > b.max_height {
                    b.max_height
                } else {
                    o.height
                },
                audio: "mix".into(),
                ..o.clone()
            };
            &limited
        }
        None => o,
    };
    let mut a: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{:.3}", start.max(0.0)),
        "-i".into(),
        src.to_string_lossy().to_string(),
        "-t".into(),
        format!("{:.3}", (end - start).max(0.5)),
    ];
    if let Some(f) = export_filter(rec, o) {
        a.extend(["-vf".to_string(), f]);
    }
    a.extend(["-map".to_string(), "0:v:0".to_string()]);
    if o.audio == "all" {
        a.extend(["-map".to_string(), "0:a?".to_string()]);
    } else {
        a.extend(["-map".to_string(), "0:a:0?".to_string()]);
    }
    let audio_rate = match budget {
        Some(b) => {
            // software x264 with a hard rate cap: the size comes out predictable,
            // which the hardware encoders don't guarantee
            a.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-b:v".to_string(),
                format!("{}k", b.video_kbps),
                "-maxrate".to_string(),
                format!("{}k", b.video_kbps),
                "-bufsize".to_string(),
                format!("{}k", b.video_kbps * 2),
            ]);
            if b.fps30 {
                a.extend(["-r".to_string(), "30".to_string()]);
            }
            format!("{}k", b.audio_kbps)
        }
        None => {
            a.extend(ffmpeg::export_encoder_args(encoder));
            "192k".to_string()
        }
    };
    a.extend([
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        audio_rate,
        "-movflags".to_string(),
        "+faststart".to_string(),
        out.to_string_lossy().to_string(),
    ]);
    ffmpeg::run_ok(ffmpeg_path, &a, ffmpeg::BELOW_NORMAL_PRIORITY_CLASS)
}

/// Resolve the file + local range for a span of the match timeline.
/// Footage a highlight can be trimmed within: the whole match, or its clip file.
pub fn highlight_bounds(rec: &MatchRecord, h: &Highlight) -> (f64, f64) {
    if rec.video.is_some() {
        return (0.0, rec.duration_s.max(h.end));
    }
    (
        h.file_start
            .unwrap_or(h.orig_start.unwrap_or(h.start))
            .min(h.start),
        h.orig_end.unwrap_or(h.end).max(h.end),
    )
}

/// Set a highlight's start / end (None = back to what the rules picked).
pub fn trim_highlight(
    rec: &mut MatchRecord,
    hid: &str,
    range: Option<(f64, f64)>,
) -> Result<(), String> {
    let snapshot = rec.clone();
    let h = rec
        .highlights
        .iter_mut()
        .find(|h| h.id == hid)
        .ok_or("找不到这段高光")?;
    let (lo, hi) = highlight_bounds(&snapshot, h);
    match range {
        None => {
            if let (Some(a), Some(b)) = (h.orig_start, h.orig_end) {
                h.start = a;
                h.end = b;
            }
        }
        Some((a, b)) => {
            if h.orig_start.is_none() {
                h.orig_start = Some(h.start);
                h.orig_end = Some(h.end);
            }
            let a = a.clamp(lo, hi);
            let b = b.clamp(lo, hi);
            if b - a < 1.0 {
                return Err("高光至少要 1 秒".into());
            }
            h.start = a;
            h.end = b;
        }
    }
    Ok(())
}

fn source_for(rec: &MatchRecord, start: f64, end: f64) -> Option<(PathBuf, f64, f64)> {
    let dir = PathBuf::from(&rec.dir);
    if let Some(v) = &rec.video {
        return Some((dir.join(v), start, end));
    }
    // clips only: find the clip that covers the range
    rec.highlights
        .iter()
        .filter(|h| h.file.is_some())
        .find(|h| start >= h.start - 0.5 && end <= h.end + 0.5)
        .or_else(|| {
            rec.highlights
                .iter()
                .filter(|h| h.file.is_some())
                .find(|h| start < h.end && end > h.start)
        })
        .map(|h| {
            let f = dir.join(h.file.as_ref().unwrap());
            (
                f,
                (start - h.file_start.unwrap_or(h.start)).max(0.0),
                (end - h.file_start.unwrap_or(h.start))
                    .min(h.orig_end.unwrap_or(h.end).max(h.end) - h.file_start.unwrap_or(h.start)),
            )
        })
}

pub fn export_name(rec: &MatchRecord, title: &str, o: &ExportOptions) -> String {
    let mut tag = match o.aspect.as_str() {
        "9:16" => "_竖屏",
        "16:9" => "_16x9",
        _ => "",
    }
    .to_string();
    if o.size_mb > 0 {
        tag.push_str(&format!("_{}MB", o.size_mb));
    }
    sanitize(&format!(
        "{}_{}_{}{}_{}.mp4",
        local_stamp(rec.created_at_ms, "%Y%m%d-%H%M"),
        rec.map_label,
        title,
        tag,
        chrono::Local::now().format("%H%M%S")
    ))
}

pub fn export_range(
    lib: &Lib,
    ffmpeg_path: &Path,
    encoder: &str,
    rec: &MatchRecord,
    start: f64,
    end: f64,
    title: &str,
    o: &ExportOptions,
) -> Result<PathBuf, String> {
    let (src, a, b) = source_for(rec, start, end).ok_or("这段没有可用的录像")?;
    let out = lib.exports_dir().join(export_name(rec, title, o));
    if o.size_mb == 0 {
        encode_range(ffmpeg_path, encoder, rec, &src, a, b, o, &out, None)?;
        return Ok(out);
    }
    // aim a little under the limit; if the encoder still overshoots, once more with less
    let limit = o.size_mb as u64 * 1_000_000;
    for margin in [0.92, 0.78] {
        let budget = budget_for(o.size_mb, b - a, margin)?;
        encode_range(ffmpeg_path, encoder, rec, &src, a, b, o, &out, Some(budget))?;
        if fs::metadata(&out).map(|m| m.len()).unwrap_or(0) <= limit {
            return Ok(out);
        }
    }
    Err(format!(
        "压不到 {} MB 以内，建议剪短一点再试",
        o.size_mb
    ))
}

pub fn export_montage(
    lib: &Lib,
    ffmpeg_path: &Path,
    encoder: &str,
    rec: &MatchRecord,
    ids: &[String],
    o: &ExportOptions,
) -> Result<PathBuf, String> {
    let tmp = lib.tmp_dir().join(format!("montage_{}", now_ms()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // with a size limit every part gets the same bitrate, from the total length
    let budget = if o.size_mb > 0 {
        let total: f64 = rec
            .highlights
            .iter()
            .filter(|h| ids.contains(&h.id))
            .map(|h| (h.end - h.start).max(0.5))
            .sum();
        Some(budget_for(o.size_mb, total, 0.88)?)
    } else {
        None
    };
    let mut parts = Vec::new();
    for (i, h) in rec
        .highlights
        .iter()
        .filter(|h| ids.contains(&h.id))
        .enumerate()
    {
        let Some((src, a, b)) = source_for(rec, h.start, h.end) else {
            continue;
        };
        let p = tmp.join(format!("part_{:03}.mp4", i));
        encode_range(ffmpeg_path, encoder, rec, &src, a, b, o, &p, budget)?;
        parts.push(format!("part_{:03}.mp4", i));
    }
    if parts.is_empty() {
        let _ = fs::remove_dir_all(&tmp);
        return Err("没有选中任何高光".into());
    }
    let mut list = String::from("ffconcat version 1.0\n");
    for p in &parts {
        list.push_str(&format!("file '{}'\n", p));
    }
    fs::write(tmp.join("list.txt"), list).map_err(|e| e.to_string())?;
    let out = lib.exports_dir().join(export_name(rec, "合集", o));
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        "list.txt".into(),
        "-c".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        out.to_string_lossy().to_string(),
    ];
    let mut cmd = ffmpeg::command(ffmpeg_path, 0);
    let o2 = cmd
        .args(&args)
        .current_dir(&tmp)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&tmp);
    if !o2.status.success() {
        return Err(ffmpeg::tail(&String::from_utf8_lossy(&o2.stderr), 6));
    }
    Ok(out)
}

/// Merge every segment of a session into one mp4 (used for the perf-test preview).
pub fn remux_all(
    ffmpeg_path: &Path,
    session_dir: &Path,
    meta: &SessionMeta,
    out: &Path,
) -> Result<(), String> {
    let segs = recorder::segments(ffmpeg_path, session_dir, true);
    if segs.is_empty() {
        return Err("没有录到任何画面".into());
    }
    let refs: Vec<&Segment> = segs.iter().collect();
    let list = write_concat_list(session_dir, &refs, "concat_all.txt")?;
    remux(ffmpeg_path, session_dir, &list, out, meta)
}

/// Older records have no per-highlight stills: make them from the clips / video.
pub fn ensure_thumbs(lib: &Lib, ffmpeg_path: &Path, id: &str) -> Option<MatchRecord> {
    let mut rec = lib.get(id)?;
    if rec.highlights.iter().all(|h| h.thumb.is_some()) {
        return Some(rec);
    }
    let events = rec.events.clone();
    let mut changed = false;
    for i in 0..rec.highlights.len() {
        if rec.highlights[i].thumb.is_some() {
            continue;
        }
        let h = rec.highlights[i].clone();
        let at = events
            .iter()
            .filter(|e| e.t >= h.start && e.t <= h.end)
            .filter(|e| matches!(e.kind.as_str(), "kill" | "knock" | "win"))
            .map(|e| e.t + 0.4)
            .next()
            .unwrap_or((h.start + h.end) / 2.0)
            .min(h.end);
        let Some((src, local, _)) = source_for(&rec, at, at + 0.1) else {
            continue;
        };
        let name = format!("{}.jpg", h.id);
        let tdir = PathBuf::from(&rec.thumb_dir);
        let _ = fs::create_dir_all(&tdir);
        make_thumb(ffmpeg_path, &src, local, &tdir.join(&name));
        if tdir.join(&name).exists() {
            rec.highlights[i].thumb = Some(name);
            changed = true;
        }
    }
    if changed {
        let _ = lib.save(&rec);
    }
    Some(rec)
}
