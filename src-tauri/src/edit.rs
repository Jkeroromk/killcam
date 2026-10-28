//! The 剪辑 (edit) page's export: highlights from any matches, in the order
//! the user put them, as one video. Each clip can carry kill captions and slow
//! motion on its big moments (both picked in the UI), and the whole video can
//! be interpolated to 120 fps.
//!
//! Every clip is encoded on its own to the same size, frame rate and audio
//! format, then the parts are joined without re-encoding.

use crate::ffmpeg;
use crate::i18n::tr;
use crate::library::{self, Budget, Lib, MatchRecord};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// slow-motion speed
const SLOW: f64 = 0.5;
/// slowed around a moment: from this long before it…
const SLOW_BEFORE: f64 = 1.0;
/// …to this long after
const SLOW_AFTER: f64 = 0.6;
/// a caption shows from just before its moment for this long
const CAPTION_S: f64 = 3.0;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Caption {
    /// match time of the moment
    pub t: f64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EditClip {
    pub match_id: String,
    /// match time
    pub start: f64,
    pub end: f64,
    /// empty unless captions are on
    pub captions: Vec<Caption>,
    /// match times to play slowed (empty unless slow motion is on)
    pub slow: Vec<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditOptions {
    /// source | 16:9 | 9:16
    pub aspect: String,
    /// 0 = like the first clip
    pub height: u32,
    /// 0 = no limit
    pub size_mb: u32,
    /// interpolate to 120 fps
    pub fps120: bool,
}

impl Default for EditOptions {
    fn default() -> Self {
        EditOptions {
            aspect: "source".into(),
            height: 1080,
            size_mb: 0,
            fps120: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// 0..1 of the whole export
    pub fraction: f64,
    /// clip being encoded (1-based), 0 while joining
    pub part: usize,
    pub parts: usize,
}

fn even(v: f64) -> u32 {
    let v = v.round().max(2.0) as u32;
    v - (v % 2)
}

/// Output frame size for the options, from the first clip's size.
pub fn out_size(src_w: u32, src_h: u32, aspect: &str, height: u32) -> (u32, u32) {
    let (w0, h0) = if src_w > 0 && src_h > 0 { (src_w as f64, src_h as f64) } else { (1920.0, 1080.0) };
    match aspect {
        // `height` is the short side, like 1080p vertical = 1080 x 1920
        "9:16" => {
            let short = if height == 0 { 1080.0 } else { height as f64 };
            (even(short), even(short * 16.0 / 9.0))
        }
        "16:9" => {
            let h = if height == 0 || height as f64 > h0 { h0 } else { height as f64 };
            (even(h * 16.0 / 9.0), even(h))
        }
        _ => {
            let h = if height == 0 || height as f64 > h0 { h0 } else { height as f64 };
            (even(w0 * h / h0), even(h))
        }
    }
}

/// Pieces of a clip of `dur` seconds: (from, to, slowed), slowed around each
/// moment in `slow` (seconds into the clip), overlapping ones merged.
pub fn segments(dur: f64, slow: &[f64]) -> Vec<(f64, f64, bool)> {
    let mut wins: Vec<(f64, f64)> = slow
        .iter()
        .map(|&t| ((t - SLOW_BEFORE).max(0.0), (t + SLOW_AFTER).min(dur)))
        .filter(|(a, b)| b - a > 0.2)
        .collect();
    wins.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for w in wins {
        match merged.last_mut() {
            Some(l) if w.0 <= l.1 + 0.3 => l.1 = l.1.max(w.1),
            _ => merged.push(w),
        }
    }
    let mut out = Vec::new();
    let mut at = 0.0;
    for (a, b) in merged {
        if a - at > 0.05 {
            out.push((at, a, false));
        }
        out.push((a, b, true));
        at = b;
    }
    if dur - at > 0.05 || out.is_empty() {
        out.push((at, dur, false));
    }
    out
}

/// Length of the clip once slowed parts are stretched.
pub fn out_len(dur: f64, slow: &[f64]) -> f64 {
    segments(dur, slow)
        .iter()
        .map(|(a, b, s)| if *s { (b - a) / SLOW } else { b - a })
        .sum()
}

/// A bold font with Chinese in it, for the captions.
fn caption_font() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if let Ok(w) = std::env::var("WINDIR") {
        let f = Path::new(&w).join("Fonts");
        for n in ["msyhbd.ttc", "msyh.ttc", "simhei.ttf", "msjhbd.ttc", "arialbd.ttf"] {
            c.push(f.join(n));
        }
    }
    for p in [
        "C:\\Windows\\Fonts\\msyhbd.ttc",
        "C:\\Windows\\Fonts\\msyh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ] {
        c.push(PathBuf::from(p));
    }
    c.into_iter().find(|p| p.exists())
}

struct Probe {
    fps: f64,
    audio: bool,
}

/// Frame rate and whether there is sound, from `ffmpeg -i`.
fn probe(ff: &Path, file: &Path) -> Probe {
    let err = ffmpeg::run(ff, &["-hide_banner".to_string(), "-i".to_string(), file.to_string_lossy().to_string()], 0)
        .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
        .unwrap_or_default();
    let fps = regex::Regex::new(r"Video:.*?(\d+(?:\.\d+)?) fps")
        .ok()
        .and_then(|re| re.captures(&err).and_then(|c| c[1].parse::<f64>().ok()))
        .unwrap_or(60.0);
    Probe {
        fps,
        audio: err.contains("Audio:"),
    }
}

fn num(v: f64) -> String {
    format!("{:.3}", v.max(0.0))
}

/// The filter graph for one clip (input already cut to it): fit to the output
/// size, captions, slow parts, frame rate. Outputs [vo] and [ao].
#[allow(clippy::too_many_arguments)]
pub fn clip_graph(
    part: usize,
    dur: f64,
    (w, h): (u32, u32),
    fill: bool,
    captions: &[(f64, String)],
    font: Option<&str>,
    slow: &[f64],
    has_audio: bool,
    fps_out: f64,
    interpolate: bool,
) -> String {
    let mut g = String::new();
    // the frame: crop to fill (16:9 / vertical) or letterbox (original)
    if fill {
        g.push_str(&format!("[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"));
    } else {
        g.push_str(&format!(
            "[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1"
        ));
    }
    if let Some(font) = font {
        let size = (h.min(w) as f64 / 22.0).round().max(16.0);
        for (i, (t, _)) in captions.iter().enumerate() {
            let a = (t - 0.2).max(0.0);
            let b = (a + CAPTION_S).min(dur);
            if b - a < 0.3 {
                continue;
            }
            // text from a file: player names can hold anything; fades in and out
            g.push_str(&format!(
                ",drawtext=fontfile={font}:textfile=cap{part}_{i}.txt:expansion=none:fontsize={size}:fontcolor=white\
                 :box=1:boxcolor=black@0.55:boxborderw={pad}:x=(w-text_w)/2:y=h*0.76\
                 :alpha='if(lt(t,{a2}),(t-{a})/0.25,if(gt(t,{b2}),({b}-t)/0.4,1))':enable='between(t,{a},{b})'",
                pad = (size * 0.45).round(),
                a = num(a),
                b = num(b),
                a2 = num(a + 0.25),
                b2 = num(b - 0.4),
            ));
        }
    }
    g.push_str("[vb];");
    if has_audio {
        g.push_str("[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[ab];");
    } else {
        g.push_str(&format!("anullsrc=r=48000:cl=stereo,atrim=0:{},aformat=sample_fmts=fltp[ab];", num(dur)));
    }
    let segs = segments(dur, slow);
    if segs.len() == 1 {
        g.push_str("[vb]null[vc];[ab]anull[ac];");
    } else {
        let n = segs.len();
        g.push_str(&format!("[vb]split={n}"));
        for i in 0..n {
            g.push_str(&format!("[vs{i}]"));
        }
        g.push_str(&format!(";[ab]asplit={n}"));
        for i in 0..n {
            g.push_str(&format!("[as{i}]"));
        }
        g.push(';');
        for (i, (a, b, s)) in segs.iter().enumerate() {
            let (vp, at) = if *s {
                (format!("setpts=(PTS-STARTPTS)/{SLOW}"), format!(",atempo={SLOW}"))
            } else {
                ("setpts=PTS-STARTPTS".to_string(), String::new())
            };
            g.push_str(&format!(
                "[vs{i}]trim=start={}:end={},{vp}[v{i}];[as{i}]atrim=start={}:end={},asetpts=PTS-STARTPTS{at}[a{i}];",
                num(*a),
                num(*b),
                num(*a),
                num(*b)
            ));
        }
        for i in 0..n {
            g.push_str(&format!("[v{i}][a{i}]"));
        }
        g.push_str(&format!("concat=n={n}:v=1:a=1[vc][ac];"));
    }
    if interpolate {
        // motion-compensated in-between frames; slow, but smooth
        g.push_str(&format!(
            "[vc]minterpolate=fps={fps_out}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,format=yuv420p[vo];"
        ));
    } else {
        g.push_str(&format!("[vc]fps={fps_out},format=yuv420p[vo];"));
    }
    g.push_str("[ac]anull[ao]");
    g
}

/// Run ffmpeg, reporting how many seconds of output are done. `stop` ends it.
fn run_progress(
    ff: &Path,
    args: &[String],
    dir: &Path,
    stop: &dyn Fn() -> bool,
    on: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let mut a: Vec<String> = vec!["-progress".into(), "pipe:1".into(), "-nostats".into()];
    a.extend(args.iter().cloned());
    let mut child = ffmpeg::command(ff, ffmpeg::BELOW_NORMAL_PRIORITY_CLASS)
        .args(&a)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| tr(format!("无法启动 ffmpeg: {e}"), format!("Couldn't start ffmpeg: {e}")))?;
    // stderr in the background so a chatty ffmpeg can't block
    let err = child.stderr.take();
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = err {
            use std::io::Read;
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if stop() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(tr("已取消导出", "Export cancelled"));
            }
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
                on(us / 1e6);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let log = err_t.join().unwrap_or_default();
    if stop() {
        return Err(tr("已取消导出", "Export cancelled"));
    }
    if !status.success() {
        return Err(ffmpeg::tail(&log, 6));
    }
    Ok(())
}

pub fn export_name(n: usize, o: &EditOptions) -> String {
    let mut tag = match o.aspect.as_str() {
        "9:16" => tr("_竖屏", "_vertical"),
        "16:9" => "_16x9".to_string(),
        _ => String::new(),
    };
    if o.fps120 {
        tag.push_str("_120fps");
    }
    if o.size_mb > 0 {
        tag.push_str(&format!("_{}MB", o.size_mb));
    }
    library::sanitize(&format!(
        "{}_{}{}.mp4",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        tr(format!("剪辑_{n}段"), format!("Edit_{n}_clips")),
        tag
    ))
}

/// Export the clips as one video into the library's export folder.
pub fn export(
    lib: &Lib,
    ff: &Path,
    encoder: &str,
    clips: &[EditClip],
    o: &EditOptions,
    stop: &(dyn Fn() -> bool + Sync),
    progress: &mut dyn FnMut(Progress),
) -> Result<PathBuf, String> {
    if clips.is_empty() {
        return Err(tr("剪辑里还没有片段", "There are no clips in the edit yet"));
    }
    // every clip's record and footage first, so a missing one fails before any work
    let mut recs: HashMap<String, MatchRecord> = HashMap::new();
    let mut plan: Vec<(PathBuf, f64, f64, &EditClip)> = Vec::new();
    for c in clips {
        if !recs.contains_key(&c.match_id) {
            let r = lib
                .get(&c.match_id)
                .ok_or_else(|| tr("有一段所在的录像已经被删掉了", "A clip's recording has been deleted"))?;
            recs.insert(c.match_id.clone(), r);
        }
        let rec = &recs[&c.match_id];
        let (src, a, b) = library::source_for(rec, c.start, c.end)
            .ok_or_else(|| tr("有一段已经没有可用的录像了", "A clip has no usable footage left"))?;
        if !src.exists() {
            return Err(tr("有一段的录像文件找不到了", "A clip's video file is missing"));
        }
        if b - a < 0.5 {
            return Err(tr("有一段太短了（至少 0.5 秒）", "A clip is too short (at least 0.5 s)"));
        }
        plan.push((src, a, b, c));
    }

    // one size, frame rate and bitrate for all parts
    let total: f64 = plan.iter().map(|(_, a, b, c)| out_len(b - a, &rel(&c.slow, c.start))).sum();
    let budget: Option<Budget> = if o.size_mb > 0 { Some(library::budget_for(o.size_mb, total, 0.88)?) } else { None };
    let first = &recs[&clips[0].match_id];
    let mut height = o.height;
    if let Some(b) = budget {
        if height == 0 || height > b.max_height {
            height = b.max_height;
        }
    }
    let size = out_size(first.width, first.height, &o.aspect, height);
    let fill = o.aspect == "16:9" || o.aspect == "9:16";
    let mut probes: HashMap<PathBuf, Probe> = HashMap::new();
    let src_fps = {
        let p = probe(ff, &plan[0].0);
        let f = p.fps;
        probes.insert(plan[0].0.clone(), p);
        f
    };
    let interpolate = o.fps120 && budget.is_none();
    let fps_out: f64 = if interpolate {
        120.0
    } else if budget.map(|b| b.fps30).unwrap_or(false) {
        30.0
    } else {
        // 59.94 and the like as a whole number: parts must all match
        src_fps.round().clamp(24.0, 240.0)
    };
    let font = caption_font();

    let tmp = lib.tmp_dir().join(format!("edit_{}", chrono::Local::now().timestamp_millis()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let font_name = match &font {
        Some(f) if plan.iter().any(|p| !p.3.captions.is_empty()) => {
            // copied next to the parts: a plain relative name needs no escaping in the filter
            let ext = f.extension().and_then(|e| e.to_str()).unwrap_or("ttf");
            let name = format!("font.{ext}");
            fs::copy(f, tmp.join(&name)).ok().map(|_| name)
        }
        _ => None,
    };
    let result = (|| -> Result<PathBuf, String> {
        let n = plan.len();
        // every part's command first…
        let mut jobs: Vec<(Vec<String>, f64)> = Vec::new();
        for (i, (src, a, b, c)) in plan.iter().enumerate() {
            let dur = b - a;
            let p = probes.remove(src).unwrap_or_else(|| probe(ff, src));
            let caps: Vec<(f64, String)> = c
                .captions
                .iter()
                .map(|k| (k.t - c.start, k.text.clone()))
                .filter(|(t, s)| *t > -0.5 && *t < dur && !s.trim().is_empty())
                .collect();
            for (j, (_, text)) in caps.iter().enumerate() {
                fs::write(tmp.join(format!("cap{i}_{j}.txt")), text.trim()).map_err(|e| e.to_string())?;
            }
            let slow = rel(&c.slow, c.start);
            let graph = clip_graph(
                i,
                dur,
                size,
                fill,
                &caps,
                font_name.as_deref(),
                &slow,
                p.audio,
                fps_out,
                interpolate && p.fps < 119.0,
            );
            let gname = format!("graph_{i:03}.txt");
            fs::write(tmp.join(&gname), &graph).map_err(|e| e.to_string())?;
            let mut args: Vec<String> = vec![
                "-hide_banner".into(),
                "-loglevel".into(),
                "error".into(),
                "-y".into(),
                "-ss".into(),
                num(*a),
                "-t".into(),
                num(dur),
                "-i".into(),
                src.to_string_lossy().to_string(),
                "-filter_complex_script".into(),
                gname,
                "-map".into(),
                "[vo]".into(),
                "-map".into(),
                "[ao]".into(),
            ];
            match budget {
                Some(bd) => args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-b:v".to_string(),
                    format!("{}k", bd.video_kbps),
                    "-maxrate".to_string(),
                    format!("{}k", bd.video_kbps),
                    "-bufsize".to_string(),
                    format!("{}k", bd.video_kbps * 2),
                ]),
                None => args.extend(ffmpeg::export_encoder_args(encoder)),
            }
            args.extend([
                "-r".to_string(),
                format!("{fps_out}"),
                "-g".to_string(),
                format!("{}", (fps_out * 2.0) as u32),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                budget.map(|b| format!("{}k", b.audio_kbps)).unwrap_or_else(|| "192k".into()),
                "-ar".to_string(),
                "48000".to_string(),
                "-movflags".to_string(),
                "+faststart".to_string(),
                part_name(i),
            ]);
            jobs.push((args, out_len(dur, &slow)));
        }

        // …then run them. Interpolation is single-threaded in ffmpeg, so
        // several parts at once use the other cores; otherwise one at a time.
        let workers = if interpolate {
            std::thread::available_parallelism().map(|c| c.get()).unwrap_or(2).div_ceil(2).clamp(1, 4).min(n)
        } else {
            1
        };
        let next = std::sync::atomic::AtomicUsize::new(0);
        let failed = std::sync::atomic::AtomicBool::new(false);
        let halt = || stop() || failed.load(std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = std::sync::mpsc::channel::<(usize, f64, Option<Result<(), String>>)>();
        let mut first_err: Option<String> = None;
        std::thread::scope(|sc| {
            for _ in 0..workers {
                let tx = tx.clone();
                let (jobs, next, failed, halt, tmp) = (&jobs, &next, &failed, &halt, &tmp);
                sc.spawn(move || loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if i >= jobs.len() || halt() {
                        break;
                    }
                    let (args, len) = &jobs[i];
                    let r = run_progress(ff, args, tmp, halt, &mut |s| {
                        let _ = tx.send((i, s.min(*len), None));
                    });
                    if r.is_err() {
                        failed.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    let _ = tx.send((i, *len, Some(r)));
                });
            }
            drop(tx);
            let mut done = vec![0.0f64; n];
            let mut finished = 0usize;
            for (i, s, r) in rx {
                done[i] = s;
                match r {
                    Some(Ok(())) => finished += 1,
                    Some(Err(e)) => {
                        // the first real error, not the ones it caused by stopping the rest
                        if first_err.is_none() {
                            first_err = Some(e);
                        }
                    }
                    None => {}
                }
                progress(Progress {
                    fraction: (done.iter().sum::<f64>() / total.max(0.1)).min(0.99),
                    part: (finished + 1).min(n),
                    parts: n,
                });
            }
        });
        if stop() {
            return Err(tr("已取消导出", "Export cancelled"));
        }
        if let Some(e) = first_err {
            return Err(e);
        }
        let parts: Vec<String> = (0..n).map(part_name).collect();
        progress(Progress {
            fraction: 0.99,
            part: 0,
            parts: n,
        });
        let out = lib.exports_dir().join(export_name(n, o));
        let _ = fs::create_dir_all(lib.exports_dir());
        let mut list = String::from("ffconcat version 1.0\n");
        for p in &parts {
            list.push_str(&format!("file '{p}'\n"));
        }
        fs::write(tmp.join("list.txt"), list).map_err(|e| e.to_string())?;
        let args: Vec<String> = [
            "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy",
            "-movflags", "+faststart",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain([out.to_string_lossy().to_string()])
        .collect();
        run_progress(ff, &args, &tmp, stop, &mut |_| {})?;
        Ok(out)
    })();
    let _ = fs::remove_dir_all(&tmp);
    result
}

fn part_name(i: usize) -> String {
    format!("part_{i:03}.mp4")
}

/// Match times as seconds into the clip.
fn rel(ts: &[f64], start: f64) -> Vec<f64> {
    ts.iter().map(|t| t - start).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_parts_merge_and_stretch() {
        let r = |v: Vec<(f64, f64, bool)>| -> Vec<(i64, i64, bool)> {
            v.into_iter().map(|(a, b, s)| ((a * 100.0).round() as i64, (b * 100.0).round() as i64, s)).collect()
        };
        let s = r(segments(10.0, &[3.0, 3.8, 9.8]));
        assert_eq!(s, vec![(0, 200, false), (200, 440, true), (440, 880, false), (880, 1000, true)]);
        assert!((out_len(10.0, &[3.0, 3.8, 9.8]) - (10.0 + 2.4 + 1.2)).abs() < 1e-9);
        assert_eq!(segments(5.0, &[]), vec![(0.0, 5.0, false)]);
        // a moment outside the clip slows nothing
        assert_eq!(segments(5.0, &[-3.0]), vec![(0.0, 5.0, false)]);
    }

    #[test]
    fn output_sizes() {
        assert_eq!(out_size(2560, 1440, "source", 1080), (1920, 1080));
        assert_eq!(out_size(2560, 1440, "source", 0), (2560, 1440));
        assert_eq!(out_size(3440, 1440, "16:9", 1080), (1920, 1080));
        assert_eq!(out_size(1920, 1080, "9:16", 1080), (1080, 1920));
        assert_eq!(out_size(1920, 1080, "source", 1440), (1920, 1080));
    }
}
