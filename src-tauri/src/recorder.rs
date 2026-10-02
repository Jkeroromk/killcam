//! One recording session = one ffmpeg process writing 10 s MPEG-TS segments
//! while the game runs. Matches are cut out of these segments afterwards.

use crate::audio::{self, AudioPipeline, Source};
use crate::ffmpeg;
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionMeta {
    pub id: String,
    /// wall clock (unix ms) of video time 0
    pub start_ms: i64,
    pub ended_ms: Option<i64>,
    pub game_pid: Option<u32>,
    pub has_game_audio: bool,
    pub has_mic: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub encoder: String,
    /// manual highlight markers, unix ms
    pub markers: Vec<i64>,
    /// markers already attached to a match
    pub used_markers: Vec<i64>,
    /// prompts recognised on screen while recording
    pub detections: Vec<ScreenDetection>,
    pub used_detections: Vec<i64>,
    pub processed_matches: Vec<String>,
    pub finalized: bool,
    pub test: bool,
    /// ffmpeg runs inside this session; a new part starts whenever capture is
    /// interrupted (display mode change, alt-tab out of fullscreen, UAC...)
    pub parts: Vec<PartMeta>,
    /// how many times turning this session into a library entry failed
    pub finalize_failures: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PartMeta {
    pub index: u32,
    /// wall clock of this part's video time 0
    pub start_ms: i64,
}

pub fn part_prefix(index: u32) -> String {
    format!("p{:02}_", index)
}

impl SessionMeta {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("session.json")
    }
    pub fn load(dir: &Path) -> Option<SessionMeta> {
        let s = fs::read_to_string(Self::path(dir)).ok()?;
        serde_json::from_str(&s).ok()
    }
    pub fn save(&self, dir: &Path) {
        if let Ok(j) = serde_json::to_string_pretty(self) {
            let p = Self::path(dir);
            let tmp = p.with_extension("json.tmp");
            if fs::write(&tmp, j).is_ok() {
                let _ = fs::rename(&tmp, &p);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenDetection {
    pub kind: String,
    pub at_ms: i64,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveStats {
    pub frame: u64,
    pub fps: f64,
    pub speed: f64,
    pub drop_frames: u64,
    pub dup_frames: u64,
    pub size_bytes: u64,
    pub out_time_s: f64,
    pub reports: u32,
}

pub struct Recording {
    pub dir: PathBuf,
    pub meta: Arc<Mutex<SessionMeta>>,
    pub stats: Arc<Mutex<LiveStats>>,
    pub log: Arc<Mutex<VecDeque<String>>>,
    /// first lines ffmpeg printed (the real cause of a failure is usually here)
    pub log_head: Arc<Mutex<Vec<String>>>,
    child: Arc<Mutex<Child>>,
    audio: Option<AudioPipeline>,
    pub started: Instant,
    pub warnings: Vec<String>,
    // what we need to start another part
    ffmpeg_path: PathBuf,
    settings: Settings,
    game_pid: Option<u32>,
    gpu_scale: bool,
    limit_seconds: Option<u32>,
    pub part: u32,
    pub part_started: Instant,
    /// last time a part had been running for a while (for giving up)
    pub last_good: Instant,
    pub restarts: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub file: String,
    /// seconds relative to the session start (SessionMeta::start_ms)
    pub start: f64,
    pub end: f64,
}

impl Recording {
    pub fn pid(&self) -> u32 {
        self.child.lock().map(|c| c.id()).unwrap_or(0)
    }

    /// Has ffmpeg exited on its own? Returns the exit message if so.
    pub fn exited(&self) -> Option<String> {
        let mut c = self.child.lock().ok()?;
        match c.try_wait() {
            Ok(Some(st)) => Some(format!("ffmpeg 已退出（{}）", st)),
            Ok(None) => None,
            Err(e) => Some(e.to_string()),
        }
    }

    pub fn log_tail(&self, n: usize) -> String {
        let l = self
            .log
            .lock()
            .map(|l| l.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let start = l.len().saturating_sub(n);
        let tail: Vec<String> = l[start..].to_vec();
        // put the first real errors on top: the tail is usually just the fallout
        let key = ["rror", "ailed", "nvalid", "annot", "not "];
        let mut first: Vec<String> = self
            .log_head
            .lock()
            .map(|h| {
                h.iter()
                    .filter(|x| key.iter().any(|k| x.contains(k)))
                    .take(6)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        first.retain(|x| !tail.contains(x));
        if first.is_empty() {
            tail.join("\n")
        } else {
            format!("{}\n…\n{}", first.join("\n"), tail.join("\n"))
        }
    }

    pub fn audio_warnings(&self) -> Vec<String> {
        self.audio
            .as_ref()
            .map(|a| a.warnings())
            .unwrap_or_default()
    }

    pub fn add_detection(&self, kind: &str, at_ms: i64, score: f32) {
        if let Ok(mut m) = self.meta.lock() {
            m.detections.push(ScreenDetection {
                kind: kind.to_string(),
                at_ms,
                score,
            });
            m.save(&self.dir);
        }
    }

    pub fn add_marker(&self, at_ms: i64) {
        if let Ok(mut m) = self.meta.lock() {
            m.markers.push(at_ms);
            m.save(&self.dir);
        }
    }

    /// ffmpeg died (capture lost): start the next part in the same session.
    pub fn restart(&mut self) -> Result<(), String> {
        // the old audio threads only feed a dead pipe now: tear them down in the
        // background so the next part starts without waiting for WASAPI
        if let Some(a) = self.audio.take() {
            thread::spawn(move || a.stop());
        }
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if self.part_started.elapsed() > Duration::from_secs(10) {
            self.last_good = Instant::now();
        }
        self.part += 1;
        self.restarts += 1;
        if let Ok(mut m) = self.meta.lock() {
            m.parts.push(PartMeta {
                index: self.part,
                start_ms: now_ms() + 300,
            });
            m.save(&self.dir);
        }
        let l = launch(
            &self.ffmpeg_path,
            &self.settings,
            &self.dir,
            self.part,
            self.gpu_scale,
            self.limit_seconds,
            self.game_pid,
            self.meta.clone(),
        )?;
        self.child = Arc::new(Mutex::new(l.child));
        self.audio = l.audio;
        self.stats = l.stats;
        self.log = l.log;
        self.log_head = l.log_head;
        self.part_started = Instant::now();
        Ok(())
    }

    /// Stop gracefully: end the audio stream (ffmpeg stops via -shortest), then kill if needed.
    pub fn stop(mut self) -> SessionMeta {
        if let Some(a) = self.audio.take() {
            a.stop();
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let done = self
                .child
                .lock()
                .map(|mut c| matches!(c.try_wait(), Ok(Some(_))))
                .unwrap_or(true);
            if done {
                break;
            }
            if Instant::now() > deadline {
                if let Ok(mut c) = self.child.lock() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        // write ended_ms into the shared meta so no later save can drop it
        let meta = match self.meta.lock() {
            Ok(mut m) => {
                m.ended_ms = Some(now_ms());
                if m.start_ms == 0 {
                    m.start_ms =
                        m.ended_ms.unwrap_or(0) - (self.started.elapsed().as_millis() as i64);
                }
                m.save(&self.dir);
                m.clone()
            }
            Err(_) => SessionMeta::default(),
        };
        meta
    }
}

pub struct StartOptions {
    pub dir: PathBuf,
    pub session_id: String,
    pub game_pid: Option<u32>,
    /// limit length (perf test)
    pub limit_seconds: Option<u32>,
    pub test: bool,
    /// scale_d3d11 verified to work on this machine
    pub gpu_scale: bool,
}

fn game_source(settings: &Settings, pid: Option<u32>) -> Option<Source> {
    match settings.audio.game_source.as_str() {
        "off" => None,
        "system" => Some(Source::SystemLoopback(
            settings.audio.system_device_id.clone(),
        )),
        _ => match pid {
            Some(p) => Some(Source::Process(p)),
            None => Some(Source::SystemLoopback(
                settings.audio.system_device_id.clone(),
            )),
        },
    }
}

struct Launched {
    child: Child,
    audio: Option<AudioPipeline>,
    stats: Arc<Mutex<LiveStats>>,
    log: Arc<Mutex<VecDeque<String>>>,
    log_head: Arc<Mutex<Vec<String>>>,
}

pub fn start(
    ffmpeg_path: &Path,
    settings: &Settings,
    opts: StartOptions,
) -> Result<Recording, String> {
    fs::create_dir_all(&opts.dir).map_err(|e| format!("无法创建录像目录：{e}"))?;
    let info = ffmpeg::info(ffmpeg_path);
    if !info.has_ddagrab {
        return Err(
            "当前 FFmpeg 不支持 ddagrab（显卡抓屏），请换用 gyan.dev 的 git-full 版本".into(),
        );
    }
    let plan = ffmpeg::capture_plan(&settings.video, opts.gpu_scale);
    let fps = if settings.video.fps == 0 {
        60
    } else {
        settings.video.fps
    };
    let launch_ms = now_ms();
    let meta = SessionMeta {
        id: opts.session_id.clone(),
        start_ms: launch_ms + 300,
        ended_ms: None,
        game_pid: opts.game_pid,
        has_game_audio: game_source(settings, opts.game_pid).is_some(),
        has_mic: settings.audio.mic_enabled,
        width: plan.out_width,
        height: plan.out_height,
        fps,
        encoder: settings.video.encoder.clone(),
        test: opts.test,
        parts: vec![PartMeta {
            index: 0,
            start_ms: launch_ms + 300,
        }],
        ..Default::default()
    };
    meta.save(&opts.dir);
    let meta = Arc::new(Mutex::new(meta));
    let l = launch(
        ffmpeg_path,
        settings,
        &opts.dir,
        0,
        opts.gpu_scale,
        opts.limit_seconds,
        opts.game_pid,
        meta.clone(),
    )?;
    let now = Instant::now();
    Ok(Recording {
        dir: opts.dir,
        meta,
        stats: l.stats,
        log: l.log,
        log_head: l.log_head,
        child: Arc::new(Mutex::new(l.child)),
        audio: l.audio,
        started: now,
        warnings: Vec::new(),
        ffmpeg_path: ffmpeg_path.to_path_buf(),
        settings: settings.clone(),
        game_pid: opts.game_pid,
        gpu_scale: opts.gpu_scale,
        limit_seconds: opts.limit_seconds,
        part: 0,
        part_started: now,
        last_good: now,
        restarts: 0,
    })
}

/// Spawn one ffmpeg part writing `pNN_seg_xxxxx.ts` into the session folder.
#[allow(clippy::too_many_arguments)]
fn launch(
    ffmpeg_path: &Path,
    settings: &Settings,
    dir: &Path,
    part: u32,
    gpu_scale: bool,
    limit_seconds: Option<u32>,
    game_pid: Option<u32>,
    meta: Arc<Mutex<SessionMeta>>,
) -> Result<Launched, String> {
    let plan = ffmpeg::capture_plan(&settings.video, gpu_scale);
    let game = game_source(settings, game_pid);
    let mic = if settings.audio.mic_enabled {
        Some(Source::Mic(settings.audio.mic_device_id.clone()))
    } else {
        None
    };
    let has_audio = game.is_some() || mic.is_some();
    let prefix = part_prefix(part);

    let s = |v: &str| v.to_string();
    let mut args: Vec<String> = vec![
        s("-hide_banner"),
        s("-loglevel"),
        s("warning"),
        s("-nostats"),
        s("-stats_period"),
        s("0.5"),
        s("-progress"),
        s("pipe:1"),
    ];
    if has_audio {
        args.extend([
            s("-thread_queue_size"),
            s("4096"),
            s("-f"),
            s("f32le"),
            s("-ar"),
            s("48000"),
            s("-ch_layout"),
            s("quad"),
            s("-i"),
            s("pipe:0"),
        ]);
    }
    let mut graph = format!("{}[v]", plan.filter);
    let mut maps = vec![s("-map"), s("[v]")];
    match (game.is_some(), mic.is_some()) {
        (true, true) => {
            graph.push_str(";[0:a]asplit=2[a1][a2];[a1]pan=stereo|c0=c0|c1=c1[ga];[a2]pan=stereo|c0=c2|c1=c3[ma]");
            maps.extend([s("-map"), s("[ga]"), s("-map"), s("[ma]")]);
        }
        (true, false) => {
            graph.push_str(";[0:a]pan=stereo|c0=c0|c1=c1[ga]");
            maps.extend([s("-map"), s("[ga]")]);
        }
        (false, true) => {
            graph.push_str(";[0:a]pan=stereo|c0=c2|c1=c3[ma]");
            maps.extend([s("-map"), s("[ma]")]);
        }
        (false, false) => {}
    }
    args.extend([s("-filter_complex"), graph]);
    args.extend(maps);
    let fps = if settings.video.fps == 0 {
        60
    } else {
        settings.video.fps
    };
    args.extend(ffmpeg::encoder_args(
        &settings.video.encoder,
        settings.video.bitrate_mbps,
        fps,
    ));
    if has_audio {
        args.extend([s("-c:a"), s("aac"), s("-b:a"), s("160k"), s("-shortest")]);
    }
    if let Some(t) = limit_seconds {
        args.extend([s("-t"), t.to_string()]);
    }
    args.extend([
        s("-f"),
        s("segment"),
        s("-segment_time"),
        s("10"),
        s("-segment_format"),
        s("mpegts"),
        s("-reset_timestamps"),
        s("1"),
        s("-segment_list"),
        format!("{prefix}segments.csv"),
        s("-segment_list_type"),
        s("csv"),
        format!("{prefix}seg_%05d.ts"),
    ]);

    let _ = fs::write(dir.join(format!("{prefix}command.txt")), args.join(" "));

    let mut cmd = ffmpeg::command(ffmpeg_path, 0);
    cmd.args(&args)
        .current_dir(dir)
        .stdin(if has_audio {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 ffmpeg：{e}"))?;

    let stats = Arc::new(Mutex::new(LiveStats::default()));
    let log = Arc::new(Mutex::new(VecDeque::with_capacity(80)));
    let log_head: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    // progress reader -> stats + this part's start wall clock
    if let Some(out) = child.stdout.take() {
        let stats = stats.clone();
        let meta = meta.clone();
        let dir = dir.to_path_buf();
        thread::spawn(move || {
            let mut cur = LiveStats::default();
            let mut best_start: i64 = i64::MAX;
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                let Some((k, v)) = line.split_once('=') else {
                    continue;
                };
                let v = v.trim();
                match k.trim() {
                    "frame" => cur.frame = v.parse().unwrap_or(cur.frame),
                    "fps" => cur.fps = v.parse().unwrap_or(cur.fps),
                    "drop_frames" => cur.drop_frames = v.parse().unwrap_or(cur.drop_frames),
                    "dup_frames" => cur.dup_frames = v.parse().unwrap_or(cur.dup_frames),
                    "total_size" => cur.size_bytes = v.parse().unwrap_or(cur.size_bytes),
                    "out_time_us" => {
                        if let Ok(us) = v.parse::<i64>() {
                            cur.out_time_s = us as f64 / 1_000_000.0;
                        }
                    }
                    "speed" => {
                        cur.speed = v.trim_end_matches('x').trim().parse().unwrap_or(cur.speed)
                    }
                    "progress" => {
                        cur.reports += 1;
                        if cur.out_time_s > 0.0 && cur.reports < 60 {
                            let cand = now_ms() - (cur.out_time_s * 1000.0) as i64;
                            if cand < best_start {
                                best_start = cand;
                                if let Ok(mut m) = meta.lock() {
                                    if let Some(p) = m.parts.iter_mut().find(|p| p.index == part) {
                                        p.start_ms = best_start;
                                    }
                                    if part == 0 {
                                        m.start_ms = best_start;
                                    }
                                    m.save(&dir);
                                }
                            }
                        }
                        if let Ok(mut s) = stats.lock() {
                            *s = cur.clone();
                        }
                    }
                    _ => {}
                }
            }
        });
    }
    // stderr -> ring buffer
    if let Some(mut err) = child.stderr.take() {
        let log = log.clone();
        let head = log_head.clone();
        let logfile = dir.join(format!("{prefix}ffmpeg.log"));
        thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match err.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n' || b == b'\r') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let t = String::from_utf8_lossy(&line).trim().to_string();
                            if t.is_empty() {
                                continue;
                            }
                            if let Ok(mut h) = head.lock() {
                                if h.len() < 40 {
                                    h.push(t.clone());
                                }
                            }
                            if let Ok(mut l) = log.lock() {
                                if l.len() >= 80 {
                                    l.pop_front();
                                }
                                l.push_back(t);
                            }
                        }
                    }
                }
            }
            let h = head.lock().map(|h| h.join("\n")).unwrap_or_default();
            let t = log
                .lock()
                .map(|l| l.iter().cloned().collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            let _ = fs::write(logfile, format!("{h}\n----- tail -----\n{t}"));
        });
    }

    let audio = if has_audio {
        child.stdin.take().map(|stdin| {
            audio::start_pipeline(
                stdin,
                game,
                mic,
                settings.audio.game_volume,
                settings.audio.mic_volume,
            )
        })
    } else {
        None
    };

    Ok(Launched {
        child,
        audio,
        stats,
        log,
        log_head,
    })
}

/// Bytes written so far (the segment muxer does not report total_size).
pub fn written_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.contains("seg_") && n.ends_with(".ts")
                })
                .filter_map(|e| e.metadata().ok().map(|m| m.len()))
                .sum()
        })
        .unwrap_or(0)
}

/// Segments of one part, in seconds relative to that part's start.
fn part_segments(
    ffmpeg_path: &Path,
    dir: &Path,
    prefix: &str,
    include_trailing: bool,
) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    if let Ok(csv) = fs::read_to_string(dir.join(format!("{prefix}segments.csv"))) {
        for line in csv.lines() {
            let cols: Vec<&str> = line.split(',').collect();
            if cols.len() < 3 {
                continue;
            }
            let (Ok(a), Ok(b)) = (cols[1].trim().parse::<f64>(), cols[2].trim().parse::<f64>())
            else {
                continue;
            };
            let file = cols[0].trim().trim_matches('"').to_string();
            if dir.join(&file).exists() {
                out.push(Segment {
                    file,
                    start: a,
                    end: b,
                });
            }
        }
    }
    if include_trailing {
        let seg_prefix = format!("{prefix}seg_");
        let mut files: Vec<String> = fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.starts_with(&seg_prefix) && n.ends_with(".ts"))
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        for f in files {
            if out.iter().any(|s| s.file == f) {
                continue;
            }
            let start = out.last().map(|s| s.end).unwrap_or(0.0);
            let Some(d) = ffmpeg::probe_duration(ffmpeg_path, &dir.join(&f)) else {
                continue;
            };
            if d < 0.5 {
                continue;
            }
            out.push(Segment {
                file: f,
                start,
                end: start + d,
            });
        }
    }
    out
}

/// All segments of a session, in seconds relative to SessionMeta::start_ms.
/// Parts may leave gaps between them (capture was interrupted).
pub fn segments(ffmpeg_path: &Path, dir: &Path, include_trailing: bool) -> Vec<Segment> {
    let Some(meta) = SessionMeta::load(dir) else {
        return Vec::new();
    };
    let parts: Vec<(String, i64)> = if meta.parts.is_empty() {
        vec![(String::new(), meta.start_ms)]
    } else {
        meta.parts
            .iter()
            .map(|p| (part_prefix(p.index), p.start_ms))
            .collect()
    };
    let n = parts.len();
    let mut out: Vec<Segment> = Vec::new();
    for (i, (prefix, pstart)) in parts.into_iter().enumerate() {
        // earlier parts ended abruptly: their last segment is never in the csv
        let trailing = include_trailing || i + 1 < n;
        let shift = (pstart - meta.start_ms) as f64 / 1000.0;
        for mut seg in part_segments(ffmpeg_path, dir, &prefix, trailing) {
            seg.start += shift;
            seg.end += shift;
            // never overlap the previous part
            if let Some(last) = out.last() {
                if seg.start < last.end {
                    let d = last.end - seg.start;
                    seg.start += d;
                    seg.end += d;
                }
            }
            out.push(seg);
        }
    }
    out
}
