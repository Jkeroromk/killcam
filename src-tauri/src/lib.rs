mod audio;
mod detector;
mod ffmpeg;
mod game;
mod gamelog;
mod library;
mod mini;
mod pubg;
mod recorder;
mod settings;
mod sound;

use library::{ExportOptions, Lib, MatchRecord};
use recorder::{now_ms, LiveStats, Recording, StartOptions};
use serde::Serialize;
use settings::{AudioSettings, Settings};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Passed by the Windows "Run" entry: start hidden in the tray.
const AUTOSTART_ARG: &str = "--autostart";

/// Keep the Windows startup entry in line with the setting. Debug builds never
/// register themselves (they need the dev server and would start blank).
fn apply_launch_at_login(app: &AppHandle, on: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let al = app.autolaunch();
    let now = al.is_enabled().unwrap_or(false);
    if on && !now {
        al.enable().map_err(|e| format!("开机自启设置失败：{e}"))?;
    } else if !on && now {
        al.disable().map_err(|e| format!("取消开机自启失败：{e}"))?;
    }
    Ok(())
}

fn lk<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct AppState {
    config_dir: PathBuf,
    settings: Mutex<Settings>,
    recording: Mutex<Option<Recording>>,
    monitor: Mutex<Option<audio::Monitor>>,
    game_pid: Mutex<Option<u32>>,
    processing: Mutex<Option<String>>,
    notices: Mutex<Vec<String>>,
    last_error: Mutex<Option<String>>,
    auto_session: AtomicBool,
    process_tx: Mutex<Option<Sender<bool>>>,
    ffmpeg_path: Mutex<Option<PathBuf>>,
    hotkeys: Mutex<Vec<(Shortcut, &'static str)>>,
    perf_running: AtomicBool,
    /// (monitor index, scale_d3d11 works)
    gpu_scale: Mutex<Option<(u32, bool)>>,
    detector: Mutex<Option<detector::Detector>>,
    /// minutes an ended session may still wait for PUBG's match data
    waiting: Mutex<Option<i64>>,
    /// the mini window was opened for the running game
    mini_open: AtomicBool,
    /// last successful hardware probe
    hw_cache: Mutex<Option<HardwareInfo>>,
    /// "立即同步" pressed: process even while the game runs
    sync_requested: AtomicBool,
    /// newest release found by the update check
    update: Mutex<Option<UpdateInfo>>,
    /// recording stopped itself after failing for a while (retried later)
    gave_up_at: Mutex<Option<Instant>>,
    version: String,
}

type St = Arc<AppState>;

impl AppState {
    fn ffmpeg(&self) -> Result<PathBuf, String> {
        if let Some(p) = lk(&self.ffmpeg_path).clone() {
            return Ok(p);
        }
        let explicit = lk(&self.settings).ffmpeg_path.clone();
        let found = ffmpeg::locate(explicit.as_deref())
            .ok_or("找不到 ffmpeg.exe：把它放进 PATH，或在设置里指定位置")?;
        *lk(&self.ffmpeg_path) = Some(found.clone());
        Ok(found)
    }

    fn lib(&self) -> Result<Lib, String> {
        let dir = lk(&self.settings).library_dir.clone();
        if dir.trim().is_empty() {
            return Err("还没有设置录像保存位置".into());
        }
        Ok(Lib::new(Path::new(&dir)))
    }

    /// Whether GPU scaling works for this monitor (probed once, cached).
    fn gpu_scale(&self, ff: &Path, monitor: u32) -> bool {
        if let Some((m, ok)) = *lk(&self.gpu_scale) {
            if m == monitor {
                return ok;
            }
        }
        let ok = ffmpeg::probe_gpu_scale(ff, monitor);
        *lk(&self.gpu_scale) = Some((monitor, ok));
        ok
    }

    /// Whether this encoder has to be fed from the CPU on this machine (found
    /// by the encoder test; the software encoder always is).
    fn cpu_feed_for(&self, encoder: &str) -> bool {
        if encoder == ffmpeg::SOFTWARE_ENCODER {
            return true;
        }
        lk(&self.hw_cache)
            .as_ref()
            .and_then(|h| h.encoders.iter().find(|e| e.id == encoder))
            .map(|e| e.available && e.cpu_feed)
            .unwrap_or(false)
    }

    fn trigger_processing(&self, force_final: bool) {
        if let Some(tx) = lk(&self.process_tx).as_ref() {
            let _ = tx.send(force_final);
        }
    }
}

// ---------------------------------------------------------------------------
// status

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    recording: bool,
    session_id: Option<String>,
    started_at_ms: Option<i64>,
    elapsed_s: f64,
    stats: LiveStats,
    width: u32,
    height: u32,
    encoder: String,
    markers: usize,
    detections: usize,
    /// screen-read kills / knocks in the current recording
    live_kills: usize,
    live_knocks: usize,
    /// off | uncalibrated | active | error text
    detector: String,
    game_running: bool,
    auto_session: bool,
    processing: Option<String>,
    waiting_minutes: Option<i64>,
    last_error: Option<String>,
    warnings: Vec<String>,
    notices: Vec<String>,
    onboarded: bool,
    /// a newer KillCam is published
    update: Option<UpdateInfo>,
    version: String,
}

fn build_status(st: &AppState) -> Status {
    let rec = lk(&st.recording);
    let (
        recording,
        session_id,
        started_at_ms,
        elapsed_s,
        stats,
        width,
        height,
        encoder,
        markers,
        detections,
        live_kills,
        live_knocks,
        mut warnings,
    ) = match rec.as_ref() {
        Some(r) => {
            let m = lk(&r.meta).clone();
            let mut w = r.warnings.clone();
            w.extend(r.audio_warnings());
            (
                true,
                Some(m.id.clone()),
                Some(m.start_ms),
                r.started.elapsed().as_secs_f64(),
                {
                    let mut st = lk(&r.stats).clone();
                    st.size_bytes = recorder::written_bytes(&r.dir);
                    st
                },
                m.width,
                m.height,
                m.encoder.clone(),
                m.markers.len(),
                m.detections.len(),
                m.detections.iter().filter(|d| d.kind == "kill").count(),
                m.detections.iter().filter(|d| d.kind == "knock").count(),
                w,
            )
        }
        None => (
            false,
            None,
            None,
            0.0,
            LiveStats::default(),
            0,
            0,
            String::new(),
            0,
            0,
            0,
            0,
            Vec::new(),
        ),
    };
    drop(rec);
    let detector_state = match lk(&st.detector).as_ref() {
        Some(d) => lk(&d.error).clone().unwrap_or_else(|| "active".into()),
        None if !detector::ready() => "uncalibrated".into(),
        None => "off".into(),
    };
    warnings.dedup();
    Status {
        recording,
        session_id,
        started_at_ms,
        elapsed_s,
        stats,
        width,
        height,
        encoder,
        markers,
        detections,
        live_kills,
        live_knocks,
        detector: detector_state,
        game_running: lk(&st.game_pid).is_some(),
        auto_session: st.auto_session.load(Ordering::Relaxed),
        processing: lk(&st.processing).clone(),
        waiting_minutes: *lk(&st.waiting),
        last_error: lk(&st.last_error).clone(),
        warnings,
        notices: lk(&st.notices).clone(),
        onboarded: lk(&st.settings).onboarded,
        update: lk(&st.update).clone(),
        version: st.version.clone(),
    }
}

fn emit_status(app: &AppHandle, st: &AppState) {
    let _ = app.emit("status", build_status(st));
}

// ---------------------------------------------------------------------------
// session control

fn start_session(app: &AppHandle, st: &St, pid: Option<u32>, auto: bool) -> Result<(), String> {
    let mut slot = lk(&st.recording);
    if slot.is_some() {
        return Ok(());
    }
    let settings = lk(&st.settings).clone();
    let lib = st.lib()?;
    let ff = st.ffmpeg()?;
    let id = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let gpu_scale = st.gpu_scale(&ff, settings.video.monitor_index);
    let cpu_feed = st.cpu_feed_for(&settings.video.encoder);
    let rec = recorder::start(
        &ff,
        &settings,
        StartOptions {
            dir: lib.sessions_dir().join(&id),
            session_id: id,
            game_pid: pid,
            limit_seconds: None,
            test: false,
            gpu_scale,
            cpu_feed,
        },
    )?;
    *slot = Some(rec);
    drop(slot);
    start_detector(app, st, &settings, &ff);
    st.auto_session.store(auto, Ordering::Relaxed);
    *lk(&st.last_error) = None;
    emit_status(app, st);
    Ok(())
}

fn start_detector(app: &AppHandle, st: &St, settings: &Settings, ff: &Path) {
    if !settings.screen_detect || !detector::ready() {
        return;
    }
    let app2 = app.clone();
    let st2 = st.clone();
    match detector::start(
        ff,
        settings.video.monitor_index,
        settings.video.monitor_width,
        settings.video.monitor_height,
        move |d| {
            if let Some(r) = lk(&st2.recording).as_ref() {
                r.add_detection(&d.kind, d.at_ms, d.score);
            }
            let _ = app2.emit("detection", d.kind.clone());
        },
    ) {
        Ok(d) => *lk(&st.detector) = Some(d),
        Err(e) => push_notice(st, format!("读屏识别没有启动：{e}")),
    }
}

fn push_notice(st: &AppState, msg: String) {
    let mut n = lk(&st.notices);
    if !n.contains(&msg) {
        n.push(msg);
    }
    let len = n.len();
    if len > 5 {
        n.drain(..len - 5);
    }
}

fn stop_detector(st: &AppState) {
    let d = lk(&st.detector).take();
    if let Some(d) = d {
        d.stop();
    }
}

fn stop_session(app: &AppHandle, st: &St) {
    stop_detector(st);
    let rec = lk(&st.recording).take();
    if let Some(r) = rec {
        r.stop();
        st.auto_session.store(false, Ordering::Relaxed);
        emit_status(app, st);
        st.trigger_processing(false);
    }
}

fn add_marker_now(app: &AppHandle, st: &St) -> bool {
    let ok = match lk(&st.recording).as_ref() {
        Some(r) => {
            r.add_marker(now_ms());
            true
        }
        None => false,
    };
    if lk(&st.settings).marker_sound {
        sound::marker(ok);
    }
    if ok {
        let _ = app.emit("marker", now_ms());
        emit_status(app, st);
    }
    ok
}

// ---------------------------------------------------------------------------
// background threads

fn spawn_status_loop(app: AppHandle, st: St) {
    thread::spawn(move || {
        let mut last_detector_restart = Instant::now();
        // encoders that failed during the current recording
        let mut tried_encoders: Vec<String> = Vec::new();
        // when we first noticed the current ffmpeg had exited
        let mut exit_seen: Option<Instant> = None;
        let mut tick: u64 = 0;
        loop {
            // short ticks: a lost capture is noticed within 0.2 s instead of 1 s
            thread::sleep(Duration::from_millis(200));
            tick += 1;
            // ffmpeg exits when Windows takes the screen capture away (display mode
            // change, alt-tab out of fullscreen, UAC). Start the next part.
            let mut give_up: Option<String> = None;
            let mut retry_later = false;
            let mut resumed = false;
            // (failed encoder, replacement)
            let mut switched: Option<(String, String)> = None;
            {
                let mut rec = lk(&st.recording);
                match rec.as_mut() {
                    Some(r) => {
                        if let Some(why) = r.exited() {
                            let seen = *exit_seen.get_or_insert_with(Instant::now);
                            let short = r.part_started.elapsed() < Duration::from_secs(3);
                            // a part that died right away = the screen is still switching:
                            // give it a moment instead of spinning up ffmpeg 5x a second
                            if !short || seen.elapsed() >= Duration::from_millis(700) {
                                exit_seen = None;
                                let tail = r.log_tail(8);
                                let quick = r.part_started.elapsed() < Duration::from_secs(10);
                                // ffmpeg rejecting its arguments won't fix itself by retrying
                                let bad_args = [
                                    "Error parsing options",
                                    "Unrecognized option",
                                    "Option not found",
                                ]
                                .iter()
                                .any(|m| tail.contains(m));
                                // the encoder can't take this screen's frames (e.g. it sits
                                // on the other GPU of a laptop): retrying won't help, another
                                // encoder might
                                let enc_failed = quick && ffmpeg::encoder_failed(&tail);
                                if bad_args {
                                    give_up = Some(format!(
                                        "这个 FFmpeg 不认 KillCam 的录制参数（版本不兼容）\n{tail}"
                                    ));
                                } else if enc_failed
                                    && !r.cpu_feed()
                                    && r.encoder() != ffmpeg::SOFTWARE_ENCODER
                                {
                                    // first try the same encoder with the image
                                    // converted on the CPU (some AMD drivers need it)
                                    let enc = r.encoder().to_string();
                                    match r.switch_encoder(&enc, true) {
                                        Ok(_) => switched = Some((enc.clone(), enc)),
                                        Err(e) => give_up = Some(e),
                                    }
                                } else if enc_failed {
                                    let failed = r.encoder().to_string();
                                    tried_encoders.push(failed.clone());
                                    let next = {
                                        let mut hw = lk(&st.hw_cache);
                                        if let Some(h) = hw.as_mut() {
                                            for e in h.encoders.iter_mut() {
                                                if e.id == failed {
                                                    e.available = false;
                                                }
                                            }
                                        }
                                        ffmpeg::fallback_encoder(
                                            &failed,
                                            hw.as_ref().map(|h| h.encoders.as_slice()),
                                            &tried_encoders,
                                        )
                                    };
                                    let next_cpu = next
                                        .as_deref()
                                        .map(|n| st.cpu_feed_for(n))
                                        .unwrap_or(false);
                                    match next {
                                        Some(n) => match r.switch_encoder(&n, next_cpu) {
                                            Ok(_) => switched = Some((failed, n)),
                                            Err(e) => give_up = Some(e),
                                        },
                                        None => {
                                            give_up = Some(format!(
                                                "编码器 {failed} 用不了这块屏幕的画面，请在「设置 → 画质」里换一个编码器，或点「重新检测」\n{tail}"
                                            ))
                                        }
                                    }
                                } else if quick && r.last_good.elapsed() > Duration::from_secs(120)
                                {
                                    retry_later = true;
                                    give_up = Some(format!("{why}\n{tail}"));
                                } else {
                                    match r.restart() {
                                        Ok(_) => resumed = true,
                                        Err(e) => give_up = Some(e),
                                    }
                                }
                            }
                        }
                    }
                    None => {
                        exit_seen = None;
                        tried_encoders.clear();
                    }
                }
            }
            if let Some((failed, next)) = switched {
                if failed == next {
                    // same encoder, fed from the CPU now: remember that for next time
                    if let Some(h) = lk(&st.hw_cache).as_mut() {
                        for e in h.encoders.iter_mut() {
                            if e.id == next {
                                e.cpu_feed = true;
                            }
                        }
                    }
                    push_notice(
                        &st,
                        format!("显卡驱动不接受直接送画面，已改成先由 CPU 转换格式再交给 {next} 编码，继续录制"),
                    );
                } else {
                    // remember it, so the next recording starts with the working one
                    let saved = {
                        let mut s = lk(&st.settings);
                        s.video.encoder = next.clone();
                        settings::save(&st.config_dir, &s)
                    };
                    if let Err(e) = saved {
                        push_notice(&st, format!("编码器设置没能保存：{e}"));
                    }
                    push_notice(
                        &st,
                        format!("编码器 {failed} 在这台电脑上用不了这块屏幕的画面，已自动换成 {next} 继续录制"),
                    );
                }
                // the settings page shows the new encoder instead of saving the old one back
                let _ = app.emit("settings-changed", ());
                emit_status(&app, &st);
            }
            if resumed {
                push_notice(
                    &st,
                    "画面中断过一下（切换全屏、分辨率或 Alt+Tab 时会这样），已经自动接着录了"
                        .into(),
                );
            }
            if let Some(msg) = give_up {
                *lk(&st.last_error) = Some(if retry_later {
                    format!("录制意外停止，两分钟内一直没法恢复（3 分钟后会自动再试）：{msg}")
                } else {
                    format!("录制没法开始：{msg}")
                });
                stop_session(&app, &st);
                // e.g. the screen was off or locked: the game watcher tries again later
                *lk(&st.gave_up_at) = retry_later.then(Instant::now);
            }
            // the detector's capture dies the same way
            let detector_dead = lk(&st.detector)
                .as_ref()
                .map(|d| lk(&d.error).is_some())
                .unwrap_or(false);
            if detector_dead && last_detector_restart.elapsed() > Duration::from_millis(1200) {
                last_detector_restart = Instant::now();
                stop_detector(&st);
                if lk(&st.recording).is_some() {
                    let settings = lk(&st.settings).clone();
                    if let Ok(ff) = st.ffmpeg() {
                        start_detector(&app, &st, &settings, &ff);
                    }
                }
            }
            if resumed || tick % 5 == 0 {
                emit_status(&app, &st);
            }
        }
    });
}

fn spawn_game_watcher(app: AppHandle, st: St) {
    thread::spawn(move || {
        let mut w = game::Watcher::new();
        let mut last: Option<u32> = None;
        loop {
            let pid = w.find();
            *lk(&st.game_pid) = pid;
            let (onboarded, auto) = {
                let s = lk(&st.settings);
                (s.onboarded, s.auto_record)
            };
            if pid.is_some() && last.is_none() {
                let _ = app.emit("game", true);
                let (mini_on, game_size) = {
                    let s = lk(&st.settings);
                    (
                        s.mini_window,
                        (s.video.monitor_width, s.video.monitor_height),
                    )
                };
                if onboarded && mini_on && !st.perf_running.load(Ordering::Relaxed) {
                    match mini::open(&app, &st.config_dir, game_size) {
                        Ok(()) => st.mini_open.store(true, Ordering::Relaxed),
                        Err(e) => *lk(&st.last_error) = Some(format!("迷你窗口打不开：{e}")),
                    }
                }
                if onboarded && auto && !st.perf_running.load(Ordering::Relaxed) {
                    // give the game a moment to create its window
                    thread::sleep(Duration::from_secs(3));
                    if let Err(e) = start_session(&app, &st, pid, true) {
                        *lk(&st.last_error) = Some(e);
                    }
                }
            } else if pid.is_some()
                && onboarded
                && auto
                && lk(&st.recording).is_none()
                && lk(&st.gave_up_at)
                    .map(|t| t.elapsed() > Duration::from_secs(180))
                    .unwrap_or(false)
            {
                // recording gave up earlier in this game: try again
                *lk(&st.gave_up_at) = None;
                *lk(&st.last_error) = None;
                if let Err(e) = start_session(&app, &st, pid, true) {
                    *lk(&st.last_error) = Some(e);
                }
            } else if pid.is_none() && last.is_some() {
                let _ = app.emit("game", false);
                *lk(&st.gave_up_at) = None;
                if st.mini_open.swap(false, Ordering::Relaxed) {
                    mini::close(&app, &st.config_dir, true);
                }
                if st.auto_session.load(Ordering::Relaxed) {
                    stop_session(&app, &st);
                }
            }
            last = pid;
            thread::sleep(Duration::from_secs(3));
        }
    });
}

fn spawn_processor(app: AppHandle, st: St) {
    let (tx, rx) = mpsc::channel::<bool>();
    *lk(&st.process_tx) = Some(tx);
    thread::spawn(move || {
        // first pass shortly after launch (picks up unfinished sessions)
        let mut force = false;
        let mut wait = Duration::from_secs(10);
        loop {
            if let Ok(f) = rx.recv_timeout(wait) {
                force = force || f;
                // collapse bursts
                while let Ok(f2) = rx.try_recv() {
                    force = force || f2;
                }
            }
            wait = Duration::from_secs(90);
            let (Ok(lib), Ok(ff)) = (st.lib(), st.ffmpeg()) else {
                continue;
            };
            let mut settings = lk(&st.settings).clone();
            if !settings.onboarded {
                continue;
            }
            // remuxing, cutting clips and parsing telemetry are heavy on the disk and
            // CPU: while PUBG runs they wait, unless the user asked for it
            let manual = st.sync_requested.swap(false, Ordering::Relaxed);
            if lk(&st.game_pid).is_some() && !force && !manual {
                continue;
            }
            let active = lk(&st.recording).as_ref().map(|r| lk(&r.meta).id.clone());
            let app2 = app.clone();
            let st2 = st.clone();
            let res = library::process_sessions(
                &lib,
                &ff,
                &mut settings,
                active.as_deref(),
                force,
                move |msg| {
                    *lk(&st2.processing) = Some(msg.to_string());
                    emit_status(&app2, &st2);
                },
            );
            force = false;
            *lk(&st.processing) = None;
            *lk(&st.waiting) = res.waiting_minutes;
            // remember the account id we looked up
            if settings.pubg.account_id.is_some() {
                let mut s = lk(&st.settings);
                if s.pubg.account_id != settings.pubg.account_id
                    && s.pubg.player_name == settings.pubg.player_name
                {
                    s.pubg.account_id = settings.pubg.account_id.clone();
                    let _ = settings::save(&st.config_dir, &s);
                }
            }
            {
                let mut n = lk(&st.notices);
                for m in res.messages {
                    if !n.contains(&m) {
                        n.push(m);
                    }
                }
                let len = n.len();
                if len > 5 {
                    n.drain(..len - 5);
                }
            }
            if !res.new_records.is_empty() {
                let _ = app.emit("library-changed", res.new_records.len());
            }
            emit_status(&app, &st);
        }
    });
}

// ---------------------------------------------------------------------------
// hotkeys

fn register_hotkeys(app: &AppHandle, st: &AppState) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let hk = lk(&st.settings).hotkeys.clone();
    let mut errors = Vec::new();
    let mut map = Vec::new();
    for (combo, action) in [(hk.highlight, "highlight"), (hk.toggle_record, "toggle")] {
        if combo.trim().is_empty() {
            continue;
        }
        match combo.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc.clone()) {
                Ok(_) => map.push((sc, action)),
                Err(e) => errors.push(format!("{combo}：{e}")),
            },
            Err(e) => errors.push(format!("{combo}：{e}")),
        }
    }
    *lk(&st.hotkeys) = map;
    errors
}

fn on_hotkey(app: &AppHandle, sc: &Shortcut) {
    let st = app.state::<St>().inner().clone();
    let action = lk(&st.hotkeys)
        .iter()
        .find(|(s, _)| s == sc)
        .map(|(_, a)| *a);
    match action {
        Some("highlight") => {
            add_marker_now(app, &st);
        }
        Some("toggle") => {
            let app = app.clone();
            thread::spawn(move || {
                let recording = lk(&st.recording).is_some();
                if recording {
                    stop_session(&app, &st);
                } else {
                    let pid = *lk(&st.game_pid);
                    if let Err(e) = start_session(&app, &st, pid, false) {
                        *lk(&st.last_error) = Some(e);
                    }
                }
            });
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// commands

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(st: State<'_, St>) -> Settings {
    lk(&st.settings).clone()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    st: State<'_, St>,
    settings: Settings,
) -> Result<Vec<String>, String> {
    let login_changed;
    {
        let mut s = lk(&st.settings);
        // encoders are tested against the recording screen, so a new screen
        // (possibly on another GPU) needs a fresh test too
        let ff_changed = s.ffmpeg_path != settings.ffmpeg_path
            || s.video.monitor_index != settings.video.monitor_index;
        login_changed = s.launch_at_login != settings.launch_at_login;
        let name_changed = s.pubg.player_name != settings.pubg.player_name;
        *s = settings;
        if name_changed {
            s.pubg.account_id = None;
        }
        settings::save(&st.config_dir, &s)?;
        if ff_changed {
            *lk(&st.ffmpeg_path) = None;
            *lk(&st.hw_cache) = None;
        }
    }
    if let Ok(lib) = st.lib() {
        let _ = lib.matches_dir();
    }
    let mut errs = register_hotkeys(&app, &st);
    if login_changed {
        let on = lk(&st.settings).launch_at_login;
        if let Err(e) = apply_launch_at_login(&app, on) {
            errs.push(e);
        }
    }
    emit_status(&app, &st);
    Ok(errs)
}

#[tauri::command]
fn get_status(st: State<'_, St>) -> Status {
    build_status(&st)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskInfo {
    mount: String,
    total: u64,
    free: u64,
    is_system: bool,
}

fn disks() -> Vec<DiskInfo> {
    let sysdrive = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".into())
        .to_uppercase();
    let list = sysinfo::Disks::new_with_refreshed_list();
    let mut out: Vec<DiskInfo> = list
        .list()
        .iter()
        .map(|d| {
            let mount = d.mount_point().to_string_lossy().to_string();
            DiskInfo {
                is_system: mount.to_uppercase().starts_with(&sysdrive),
                mount,
                total: d.total_space(),
                free: d.available_space(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out.dedup_by(|a, b| a.mount == b.mount);
    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HardwareInfo {
    gpu: String,
    cpu_threads: usize,
    ffmpeg: Option<ffmpeg::FfmpegInfo>,
    ffmpeg_error: Option<String>,
    gpu_scale_works: bool,
    encoders: Vec<ffmpeg::EncoderInfo>,
    disks: Vec<DiskInfo>,
}

/// Probing runs ffmpeg a few times (several seconds), so the result is kept
/// until `force` or a changed ffmpeg path. Disk space is always fresh.
#[tauri::command]
async fn detect_hardware(st: State<'_, St>, force: Option<bool>) -> Result<HardwareInfo, String> {
    let st = st.inner().clone();
    blocking(move || {
        if !force.unwrap_or(false) {
            if let Some(mut hw) = lk(&st.hw_cache).clone() {
                hw.disks = disks();
                return Ok(hw);
            }
        }
        *lk(&st.ffmpeg_path) = None;
        *lk(&st.gpu_scale) = None;
        let ff = st.ffmpeg();
        let monitor = lk(&st.settings).video.monitor_index;
        let (info, err) = match &ff {
            Ok(p) => (Some(ffmpeg::info(p)), None),
            Err(e) => (None, Some(e.clone())),
        };
        let gpu_scale_works = match &ff {
            Ok(p) => {
                info.as_ref()
                    .map(|i| i.has_ddagrab && i.has_scale_d3d11)
                    .unwrap_or(false)
                    && st.gpu_scale(p, monitor)
            }
            Err(_) => false,
        };
        // test the encoders with frames from the recording screen, so an
        // encoder on another GPU doesn't show up as usable
        let encoders = match &ff {
            Ok(p) => {
                let screen = info
                    .as_ref()
                    .filter(|i| i.has_ddagrab)
                    .map(|_| monitor);
                ffmpeg::probe_encoders(p, screen, gpu_scale_works)
            }
            Err(_) => Vec::new(),
        };
        let hw = HardwareInfo {
            gpu: ffmpeg::gpu_name(),
            cpu_threads: thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(0),
            ffmpeg: info,
            ffmpeg_error: err,
            gpu_scale_works,
            encoders,
            disks: disks(),
        };
        // only remember a good result; a failed probe gets retried next time
        if hw.ffmpeg_error.is_none() && hw.encoders.iter().any(|e| e.available) {
            *lk(&st.hw_cache) = Some(hw.clone());
        }
        Ok(hw)
    })
    .await
}

#[tauri::command]
async fn list_monitors(
    app: AppHandle,
    st: State<'_, St>,
) -> Result<Vec<ffmpeg::MonitorInfo>, String> {
    let st = st.inner().clone();
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("monitors");
    blocking(move || {
        let ff = st.ffmpeg()?;
        let _ = std::fs::remove_dir_all(&cache);
        Ok(ffmpeg::list_monitors(&ff, &cache))
    })
    .await
}

#[tauri::command]
fn game_info(st: State<'_, St>) -> game::GameInfo {
    game::info(*lk(&st.game_pid))
}

#[tauri::command]
async fn list_audio_devices() -> Result<audio::AudioDevices, String> {
    blocking(audio::list_devices).await
}

#[tauri::command]
fn start_audio_monitor(
    app: AppHandle,
    st: State<'_, St>,
    audio_settings: AudioSettings,
) -> Result<(), String> {
    if let Some(m) = lk(&st.monitor).take() {
        m.stop();
    }
    let pid = *lk(&st.game_pid);
    let game = match (audio_settings.game_source.as_str(), pid) {
        ("off", _) => None,
        ("process", Some(p)) => Some(audio::Source::Process(p)),
        _ => Some(audio::Source::SystemLoopback(
            audio_settings.system_device_id.clone(),
        )),
    };
    let mic = if audio_settings.mic_enabled {
        Some(audio::Source::Mic(audio_settings.mic_device_id.clone()))
    } else {
        None
    };
    let gv = audio_settings.game_volume;
    let mv = audio_settings.mic_volume;
    let app2 = app.clone();
    let m = audio::start_monitor(game, mic, move |mut l| {
        l.game = (l.game * gv).min(1.5);
        l.mic = (l.mic * mv).min(1.5);
        let _ = app2.emit("audio-levels", l);
    });
    *lk(&st.monitor) = Some(m);
    Ok(())
}

#[tauri::command]
fn stop_audio_monitor(st: State<'_, St>) {
    if let Some(m) = lk(&st.monitor).take() {
        m.stop();
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PerfProgress {
    elapsed: f64,
    total: f64,
    fps: f64,
    speed: f64,
    cpu: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerfResult {
    ok: bool,
    target_fps: u32,
    avg_fps: f64,
    speed: f64,
    drop_frames: u64,
    dup_frames: u64,
    frames: u64,
    cpu_percent: f32,
    bitrate_mbps: f64,
    mb_per_minute: f64,
    width: u32,
    height: u32,
    encoder: String,
    game_running: bool,
    video_path: Option<String>,
    warnings: Vec<String>,
    log: String,
}

#[tauri::command]
async fn run_perf_test(
    app: AppHandle,
    st: State<'_, St>,
    settings: Settings,
    seconds: Option<u32>,
) -> Result<PerfResult, String> {
    let st = st.inner().clone();
    if lk(&st.recording).is_some() {
        return Err("正在录制中，先停止录制再测试".into());
    }
    if st.perf_running.swap(true, Ordering::Relaxed) {
        return Err("测试已经在进行".into());
    }
    let secs = seconds.unwrap_or(12).clamp(5, 60);
    let st2 = st.clone();
    let res = blocking(move || {
        let ff = st.ffmpeg()?;
        let base = if settings.library_dir.trim().is_empty() {
            app.path().app_cache_dir().map_err(|e| e.to_string())?
        } else {
            Lib::new(Path::new(&settings.library_dir)).tmp_dir()
        };
        let dir = base.join(format!("perf_{}", now_ms()));
        let pid = *lk(&st.game_pid);
        let gpu_scale = st.gpu_scale(&ff, settings.video.monitor_index);
        let cpu_feed = st.cpu_feed_for(&settings.video.encoder);
        let rec = recorder::start(
            &ff,
            &settings,
            StartOptions {
                dir: dir.clone(),
                session_id: "perf".into(),
                game_pid: pid,
                limit_seconds: Some(secs),
                test: true,
                gpu_scale,
                cpu_feed,
            },
        )?;
        let mut watcher = game::Watcher::new();
        let ff_pid = rec.pid();
        let t0 = Instant::now();
        let mut cpu_samples: Vec<f32> = Vec::new();
        let _ = watcher.cpu_of(ff_pid);
        while rec.exited().is_none() && t0.elapsed() < Duration::from_secs(secs as u64 + 15) {
            thread::sleep(Duration::from_millis(1000));
            let cpu = watcher.cpu_of(ff_pid).unwrap_or(0.0);
            if t0.elapsed().as_secs() >= 2 {
                cpu_samples.push(cpu);
            }
            let s = lk(&rec.stats).clone();
            let _ = app.emit(
                "perf-progress",
                PerfProgress {
                    elapsed: s.out_time_s,
                    total: secs as f64,
                    fps: s.fps,
                    speed: s.speed,
                    cpu,
                },
            );
        }
        let stats = lk(&rec.stats).clone();
        let log = rec.log_tail(12);
        let mut warnings = rec.warnings.clone();
        warnings.extend(rec.audio_warnings());
        let meta = rec.stop();
        let size = recorder::written_bytes(&dir);
        let video = dir.join("test.mp4");
        let video_path = match library::remux_all(&ff, &dir, &meta, &video) {
            Ok(_) => Some(video.to_string_lossy().to_string()),
            Err(e) => {
                warnings.push(e);
                None
            }
        };
        let dur = stats.out_time_s.max(0.001);
        let fps_target = meta.fps.max(1);
        let avg_fps = stats.frame as f64 / dur;
        let cpu = if cpu_samples.is_empty() {
            0.0
        } else {
            cpu_samples.iter().sum::<f32>() / cpu_samples.len() as f32
        };
        let bitrate = size as f64 * 8.0 / dur / 1_000_000.0;
        // speed is skewed by ffmpeg start-up on a short test; frames per recorded second is what matters
        let ok = stats.frame > 0 && avg_fps >= fps_target as f64 * 0.95;
        Ok(PerfResult {
            ok,
            target_fps: fps_target,
            avg_fps,
            speed: stats.speed,
            drop_frames: stats.drop_frames,
            dup_frames: stats.dup_frames,
            frames: stats.frame,
            cpu_percent: cpu,
            bitrate_mbps: bitrate,
            mb_per_minute: bitrate * 60.0 / 8.0,
            width: meta.width,
            height: meta.height,
            encoder: meta.encoder,
            game_running: pid.is_some(),
            video_path,
            warnings,
            log,
        })
    })
    .await;
    st2.perf_running.store(false, Ordering::Relaxed);
    res
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PubgCheck {
    account_id: String,
    recent_matches: usize,
}

#[tauri::command]
async fn verify_pubg(
    player_name: String,
    api_key: String,
    shard: String,
) -> Result<PubgCheck, String> {
    blocking(move || {
        let api = pubg::Api::new(&api_key, &shard);
        let (id, matches) = api.player(&player_name)?;
        Ok(PubgCheck {
            account_id: id,
            recent_matches: matches.len(),
        })
    })
    .await
}

#[tauri::command]
async fn start_recording(app: AppHandle, st: State<'_, St>) -> Result<(), String> {
    let st = st.inner().clone();
    blocking(move || {
        let pid = *lk(&st.game_pid);
        start_session(&app, &st, pid, false)
    })
    .await
}

#[tauri::command]
async fn stop_recording(app: AppHandle, st: State<'_, St>) -> Result<(), String> {
    let st = st.inner().clone();
    blocking(move || {
        stop_session(&app, &st);
        Ok(())
    })
    .await
}

#[tauri::command]
fn add_marker(app: AppHandle, st: State<'_, St>) -> bool {
    add_marker_now(&app, st.inner())
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

/// Close the mini window for this game without bringing the main window up.
#[tauri::command]
fn close_mini(app: AppHandle, st: State<'_, St>) {
    st.mini_open.store(false, Ordering::Relaxed);
    mini::close(&app, &st.config_dir, false);
}

#[tauri::command]
fn clear_notices(app: AppHandle, st: State<'_, St>) {
    lk(&st.notices).clear();
    *lk(&st.last_error) = None;
    emit_status(&app, &st);
}

#[tauri::command]
fn sync_now(st: State<'_, St>, finalize: bool) {
    st.sync_requested.store(true, Ordering::Relaxed);
    st.trigger_processing(finalize);
}

#[tauri::command]
async fn list_matches(st: State<'_, St>) -> Result<Vec<MatchRecord>, String> {
    let st = st.inner().clone();
    blocking(move || Ok(st.lib()?.list())).await
}

#[tauri::command]
fn get_match(st: State<'_, St>, id: String) -> Result<MatchRecord, String> {
    st.lib()?
        .get(&id)
        .ok_or_else(|| "找不到这场录像".to_string())
}

/// Make missing highlight stills (older records), returns the updated record.
#[tauri::command]
async fn ensure_thumbs(st: State<'_, St>, id: String) -> Result<MatchRecord, String> {
    let st = st.inner().clone();
    blocking(move || {
        let lib = st.lib()?;
        let ff = st.ffmpeg()?;
        library::ensure_thumbs(&lib, &ff, &id).ok_or_else(|| "找不到这场录像".to_string())
    })
    .await
}

#[tauri::command]
fn set_favorite(st: State<'_, St>, id: String, favorite: bool) -> Result<(), String> {
    let lib = st.lib()?;
    let mut m = lib.get(&id).ok_or("找不到这场录像")?;
    m.favorite = favorite;
    lib.save(&m)
}

/// Trim a highlight (start/end in match seconds); both None resets it.
#[tauri::command]
fn trim_highlight(
    st: State<'_, St>,
    id: String,
    hid: String,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<MatchRecord, String> {
    let lib = st.lib()?;
    let mut m = lib.get(&id).ok_or("找不到这场录像")?;
    let range = match (start, end) {
        (Some(a), Some(b)) => Some((a.min(b), a.max(b))),
        _ => None,
    };
    library::trim_highlight(&mut m, &hid, range)?;
    lib.save(&m)?;
    Ok(m)
}

#[tauri::command]
fn delete_match(app: AppHandle, st: State<'_, St>, id: String) -> Result<(), String> {
    st.lib()?.delete(&id)?;
    let _ = app.emit("library-changed", 0);
    Ok(())
}

#[tauri::command]
async fn export_clip(
    st: State<'_, St>,
    id: String,
    start: f64,
    end: f64,
    title: String,
    options: ExportOptions,
) -> Result<String, String> {
    let st = st.inner().clone();
    blocking(move || {
        let lib = st.lib()?;
        let ff = st.ffmpeg()?;
        let rec = lib.get(&id).ok_or("找不到这场录像")?;
        let enc = lk(&st.settings).video.encoder.clone();
        let p = library::export_range(&lib, &ff, &enc, &rec, start, end, &title, &options)?;
        Ok(p.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
async fn export_montage(
    st: State<'_, St>,
    id: String,
    highlight_ids: Vec<String>,
    options: ExportOptions,
) -> Result<String, String> {
    let st = st.inner().clone();
    blocking(move || {
        let lib = st.lib()?;
        let ff = st.ffmpeg()?;
        let rec = lib.get(&id).ok_or("找不到这场录像")?;
        let enc = lk(&st.settings).video.encoder.clone();
        let p = library::export_montage(&lib, &ff, &enc, &rec, &highlight_ids, &options)?;
        Ok(p.to_string_lossy().to_string())
    })
    .await
}

/// Everything useful for figuring out a problem on someone else's computer,
/// in one text file: versions, hardware, encoder test, settings (without the
/// API key), recent errors and the last recording logs.
#[tauri::command]
async fn export_diagnostics(st: State<'_, St>, path: String) -> Result<(), String> {
    let st = st.inner().clone();
    blocking(move || {
        use std::fmt::Write as _;
        let mut out = String::new();
        let line = |o: &mut String, k: &str, v: &str| {
            let _ = writeln!(o, "{k}: {v}");
        };
        let _ = writeln!(out, "===== KillCam 诊断信息 =====");
        line(&mut out, "导出时间", &chrono::Local::now().format("%Y-%m-%d %H:%M:%S %z").to_string());
        line(&mut out, "KillCam 版本", &st.version);
        line(
            &mut out,
            "系统",
            &sysinfo::System::long_os_version().unwrap_or_default(),
        );
        {
            let mut sys = sysinfo::System::new();
            sys.refresh_cpu_all();
            sys.refresh_memory();
            let cpu = sys
                .cpus()
                .first()
                .map(|c| c.brand().trim().to_string())
                .unwrap_or_default();
            line(&mut out, "CPU", &format!("{cpu}（{} 线程）", sys.cpus().len()));
            line(
                &mut out,
                "内存",
                &format!("{:.1} GB", sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0),
            );
        }
        // every GPU with its driver version (laptops often have two)
        let gpus = ffmpeg::hidden("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '  驱动 ' + $_.DriverVersion }",
            ])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let _ = writeln!(out, "显卡:\n{gpus}");

        let _ = writeln!(out, "\n===== FFmpeg =====");
        match st.ffmpeg() {
            Ok(p) => {
                line(&mut out, "位置", &p.to_string_lossy());
                let info = ffmpeg::info(&p);
                let _ = writeln!(out, "{info:?}");
            }
            Err(e) => line(&mut out, "错误", &e),
        }

        let _ = writeln!(out, "\n===== 显卡 / 编码器检测 =====");
        match lk(&st.hw_cache).clone() {
            Some(h) => {
                let _ = writeln!(out, "{}", serde_json::to_string_pretty(&h).unwrap_or_default());
            }
            None => {
                let _ = writeln!(out, "（还没检测过：在 设置 → 画质 里点「重新检测」后再导出）");
            }
        }

        let _ = writeln!(out, "\n===== 设置（不含 API Key）=====");
        let mut s = lk(&st.settings).clone();
        if !s.pubg.api_key.is_empty() {
            s.pubg.api_key = "（已填写，已隐藏）".into();
        }
        let _ = writeln!(out, "{}", serde_json::to_string_pretty(&s).unwrap_or_default());

        let _ = writeln!(out, "\n===== 状态 =====");
        line(&mut out, "正在录制", &lk(&st.recording).is_some().to_string());
        line(&mut out, "最近错误", &lk(&st.last_error).clone().unwrap_or_else(|| "无".into()));
        for n in lk(&st.notices).iter() {
            line(&mut out, "提示", n);
        }
        if let Some(r) = lk(&st.recording).as_ref() {
            let _ = writeln!(out, "当前录制日志:\n{}", r.log_tail(30));
        }

        let _ = writeln!(out, "\n===== 最近的录制日志 =====");
        let logs_dir = st.lib().ok().map(|l| l.root.join("_cache").join("logs"));
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = logs_dir
            .and_then(|d| std::fs::read_dir(d).ok())
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
                    .collect()
            })
            .unwrap_or_default();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        if files.is_empty() {
            let _ = writeln!(out, "（没有：还没录过，或者是 0.1.4 之前录的）");
        }
        for (_, f) in files.iter().take(6) {
            let text = std::fs::read_to_string(f).unwrap_or_default();
            let lines: Vec<&str> = text.lines().collect();
            let keep = if lines.len() > 160 {
                lines[..40].join("\n") + "\n…\n" + &lines[lines.len() - 120..].join("\n")
            } else {
                lines.join("\n")
            };
            let _ = writeln!(
                out,
                "\n--- {} ---\n{keep}",
                f.file_name().unwrap_or_default().to_string_lossy()
            );
        }
        std::fs::write(&path, out).map_err(|e| format!("保存失败：{e}"))
    })
    .await
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let mut c = ffmpeg::hidden("explorer");
    if p.is_file() {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.raw_arg(format!("/select,\"{}\"", path));
        }
        #[cfg(not(windows))]
        c.arg(&path);
    } else {
        c.arg(&path);
    }
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open a web page in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("只能打开 https 链接".into());
    }
    ffmpeg::hidden("explorer")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageInfo {
    library_dir: String,
    used_bytes: u64,
    limit_gb: u32,
    free_bytes: u64,
}

#[tauri::command]
async fn storage_info(st: State<'_, St>) -> Result<StorageInfo, String> {
    let st = st.inner().clone();
    blocking(move || {
        let lib = st.lib()?;
        let used = lib.usage_bytes();
        let dir = lib.root.to_string_lossy().to_string();
        let up = dir.to_uppercase();
        let free = disks()
            .into_iter()
            .filter(|d| up.starts_with(&d.mount.to_uppercase()))
            .max_by_key(|d| d.mount.len())
            .map(|d| d.free)
            .unwrap_or(0);
        Ok(StorageInfo {
            library_dir: dir,
            used_bytes: used,
            limit_gb: lk(&st.settings).storage_limit_gb,
            free_bytes: free,
        })
    })
    .await
}

#[tauri::command]
async fn check_ffmpeg(path: Option<String>) -> Result<Option<ffmpeg::FfmpegInfo>, String> {
    blocking(move || Ok(ffmpeg::locate(path.as_deref()).map(|p| ffmpeg::info(&p)))).await
}

#[tauri::command]
fn default_library_dir(app: AppHandle) -> String {
    let ds = disks();
    let best = ds
        .iter()
        .filter(|d| !d.is_system && d.free > 50 * 1024 * 1024 * 1024)
        .max_by_key(|d| d.free);
    if let Some(d) = best {
        return PathBuf::from(&d.mount)
            .join("KillCam")
            .to_string_lossy()
            .to_string();
    }
    app.path()
        .video_dir()
        .map(|p| p.join("KillCam").to_string_lossy().to_string())
        .unwrap_or_else(|_| "C:\\KillCam".into())
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// updates (GitHub releases, signed; see tauri.conf.json > plugins.updater)

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

async fn check_for_update(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = match updater.check().await {
        Ok(f) => f,
        // no release published yet (latest.json 404s): nothing newer
        Err(e) if e.to_string().contains("valid release JSON") => None,
        Err(e) => return Err(format!("检查更新失败：{e}")),
    };
    Ok(found.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Look for a new release shortly after launch and then every 6 hours.
/// Debug builds don't (they would offer to install over the dev setup).
fn spawn_update_checker(app: AppHandle, st: St) {
    if cfg!(debug_assertions) {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(30));
        loop {
            if let Ok(found) = tauri::async_runtime::block_on(check_for_update(&app)) {
                let fresh = found.is_some() && lk(&st.update).is_none();
                *lk(&st.update) = found;
                if fresh {
                    emit_status(&app, &st);
                }
            }
            thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

#[tauri::command]
async fn check_update(app: AppHandle, st: State<'_, St>) -> Result<Option<UpdateInfo>, String> {
    let found = check_for_update(&app).await?;
    *lk(&st.update) = found.clone();
    emit_status(&app, &st);
    Ok(found)
}

/// Download, then hand over to the installer (it closes KillCam, updates and
/// starts it again).
#[tauri::command]
async fn install_update(app: AppHandle, st: State<'_, St>) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let st = st.inner().clone();
    if lk(&st.recording).is_some() {
        return Err("正在录制，等这局录完再更新".into());
    }
    let st_exit = st.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            stop_detector(&st_exit);
            let rec = lk(&st_exit.recording).take();
            if let Some(r) = rec {
                r.stop();
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?
    else {
        return Err("已经是最新版本".into());
    };
    let progress_app = app.clone();
    let mut got: u64 = 0;
    update
        .download_and_install(
            move |n, total| {
                got += n as u64;
                let _ = progress_app.emit("update-progress", (got, total));
            },
            || {},
        )
        .await
        .map_err(|e| format!("更新失败：{e}"))
}

/// While the game runs, putting the main window away brings the mini window
/// back (e.g. after it was closed with its own ×).
fn bring_back_mini(app: &AppHandle) {
    let app = app.clone();
    // never build windows inside a window-event handler (deadlocks on Windows)
    thread::spawn(move || {
        let Some(st) = app.try_state::<St>().map(|s| s.inner().clone()) else {
            return;
        };
        let (on, game_size) = {
            let s = lk(&st.settings);
            (
                s.onboarded && s.mini_window,
                (s.video.monitor_width, s.video.monitor_height),
            )
        };
        if !on || lk(&st.game_pid).is_none() || app.get_webview_window(mini::LABEL).is_some() {
            return;
        }
        if mini::open(&app, &st.config_dir, game_size).is_ok() {
            st.mini_open.store(true, Ordering::Relaxed);
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let s = settings::load(&config_dir);
            let state: St = Arc::new(AppState {
                config_dir,
                settings: Mutex::new(s),
                recording: Mutex::new(None),
                monitor: Mutex::new(None),
                game_pid: Mutex::new(None),
                processing: Mutex::new(None),
                notices: Mutex::new(Vec::new()),
                last_error: Mutex::new(None),
                auto_session: AtomicBool::new(false),
                process_tx: Mutex::new(None),
                ffmpeg_path: Mutex::new(None),
                hotkeys: Mutex::new(Vec::new()),
                perf_running: AtomicBool::new(false),
                gpu_scale: Mutex::new(None),
                detector: Mutex::new(None),
                waiting: Mutex::new(None),
                mini_open: AtomicBool::new(false),
                hw_cache: Mutex::new(None),
                sync_requested: AtomicBool::new(false),
                update: Mutex::new(None),
                gave_up_at: Mutex::new(None),
                version: app.package_info().version.to_string(),
            });
            app.manage(state.clone());

            // started by Windows at login: stay in the tray; otherwise show the window
            let onboarded = lk(&state.settings).onboarded;
            if !onboarded || !std::env::args().any(|a| a == AUTOSTART_ARG) {
                show_main(app.handle());
            }
            let login = lk(&state.settings).launch_at_login;
            if let Err(e) = apply_launch_at_login(app.handle(), login) {
                lk(&state.notices).push(e);
            }

            // clean leftovers from perf tests
            if let Ok(lib) = state.lib() {
                let _ = std::fs::remove_dir_all(lib.tmp_dir());
                let _ = std::fs::create_dir_all(lib.tmp_dir());
                lib.migrate_ids();
                lib.migrate_thumbs();
                lib.hide_internal_dirs();
            }

            let handle = app.handle().clone();
            let errs = register_hotkeys(&handle, &state);
            if !errs.is_empty() {
                *lk(&state.notices) = errs
                    .iter()
                    .map(|e| format!("快捷键注册失败：{e}"))
                    .collect();
            }
            spawn_status_loop(handle.clone(), state.clone());
            spawn_game_watcher(handle.clone(), state.clone());
            spawn_processor(handle.clone(), state.clone());
            spawn_update_checker(handle.clone(), state.clone());

            // tray
            let open = MenuItem::with_id(app, "open", "打开 KillCam", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("KillCam")
                .menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show_main(app),
                "quit" => {
                    let st = app.state::<St>().inner().clone();
                    stop_detector(&st);
                    let rec = lk(&st.recording).take();
                    if let Some(r) = rec {
                        r.stop();
                    }
                    app.exit(0);
                }
                _ => {}
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // keep running in the tray so recording continues
                    let _ = window.hide();
                    api.prevent_close();
                    bring_back_mini(window.app_handle());
                }
                // minimized (Windows reports it as a resize)
                tauri::WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
                    bring_back_mini(window.app_handle());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            show_main_window,
            close_mini,
            check_update,
            install_update,
            get_status,
            detect_hardware,
            list_monitors,
            game_info,
            list_audio_devices,
            start_audio_monitor,
            stop_audio_monitor,
            run_perf_test,
            verify_pubg,
            start_recording,
            stop_recording,
            add_marker,
            clear_notices,
            sync_now,
            list_matches,
            get_match,
            ensure_thumbs,
            set_favorite,
            trim_highlight,
            delete_match,
            export_clip,
            export_montage,
            reveal,
            export_diagnostics,
            open_url,
            storage_info,
            check_ffmpeg,
            default_library_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running KillCam");
}
