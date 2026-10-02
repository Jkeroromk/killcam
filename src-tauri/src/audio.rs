//! WASAPI capture: game audio (per-process loopback) + microphone.
//!
//! Both sources are resampled by Windows to 48 kHz float stereo and mixed by a
//! clock-driven writer into one 4-channel stream on ffmpeg's stdin:
//! channels 0/1 = game, 2/3 = mic. ffmpeg splits them back into two tracks.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const RATE: usize = 48000;

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Debug, Clone)]
pub enum Source {
    /// loopback of one process tree (the game)
    Process(u32),
    /// loopback of an output device (everything played on it), None = default
    SystemLoopback(Option<String>),
    /// a capture device, None = default
    Mic(Option<String>),
}

pub struct SourceBuf {
    pub buf: Mutex<VecDeque<f32>>,
    /// peak since last read, stored as f32 bits
    pub level: AtomicU32,
    pub alive: AtomicBool,
    pub error: Mutex<Option<String>>,
    buffered: bool,
}

impl SourceBuf {
    fn new(buffered: bool) -> Arc<Self> {
        Arc::new(Self {
            buf: Mutex::new(VecDeque::with_capacity(RATE * 2)),
            level: AtomicU32::new(0),
            alive: AtomicBool::new(true),
            error: Mutex::new(None),
            buffered,
        })
    }
    pub fn take_level(&self) -> f32 {
        f32::from_bits(self.level.swap(0, Ordering::Relaxed))
    }
    pub fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }
}

fn capture(src: &Source, sb: &SourceBuf, stop: &AtomicBool) -> Result<(), String> {
    let _ = wasapi::initialize_mta();
    let fmt = wasapi::WaveFormat::new(32, 32, &wasapi::SampleType::Float, 48000, 2, None);

    let (mut client, period) = match src {
        Source::Process(pid) => {
            let c =
                wasapi::AudioClient::new_application_loopback_client(*pid, true).map_err(e2s)?;
            (c, 0i64)
        }
        Source::SystemLoopback(id) => {
            let en = wasapi::DeviceEnumerator::new().map_err(e2s)?;
            let dev = match id {
                Some(id) if !id.is_empty() => en.get_device(id).map_err(e2s)?,
                _ => en
                    .get_default_device(&wasapi::Direction::Render)
                    .map_err(e2s)?,
            };
            let c = dev.get_iaudioclient().map_err(e2s)?;
            let (def, _min) = c.get_device_period().map_err(e2s)?;
            (c, def)
        }
        Source::Mic(id) => {
            let en = wasapi::DeviceEnumerator::new().map_err(e2s)?;
            let dev = match id {
                Some(id) if !id.is_empty() => en.get_device(id).map_err(e2s)?,
                _ => en
                    .get_default_device(&wasapi::Direction::Capture)
                    .map_err(e2s)?,
            };
            let c = dev.get_iaudioclient().map_err(e2s)?;
            let (def, _min) = c.get_device_period().map_err(e2s)?;
            (c, def)
        }
    };

    let mode = wasapi::StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: period,
    };
    client
        .initialize_client(&fmt, &wasapi::Direction::Capture, &mode)
        .map_err(e2s)?;
    let h = client.set_get_eventhandle().map_err(e2s)?;
    let cap = client.get_audiocaptureclient().map_err(e2s)?;
    client.start_stream().map_err(e2s)?;

    let mut q: VecDeque<u8> = VecDeque::with_capacity(RATE * 8);
    let max_keep = RATE * 2 * 2; // 2 seconds of stereo
    while !stop.load(Ordering::Relaxed) {
        let _ = h.wait_for_event(200);
        loop {
            let n = cap.get_next_packet_size().map_err(e2s)?.unwrap_or(0);
            if n == 0 {
                break;
            }
            cap.read_from_device_to_deque(&mut q).map_err(e2s)?;
        }
        let nf = q.len() / 4;
        if nf == 0 {
            continue;
        }
        let mut peak = 0f32;
        let mut samples = Vec::with_capacity(nf);
        for _ in 0..nf {
            let b = [
                q.pop_front().unwrap_or(0),
                q.pop_front().unwrap_or(0),
                q.pop_front().unwrap_or(0),
                q.pop_front().unwrap_or(0),
            ];
            let v = f32::from_le_bytes(b);
            let v = if v.is_finite() { v } else { 0.0 };
            peak = peak.max(v.abs());
            samples.push(v);
        }
        let prev = f32::from_bits(sb.level.load(Ordering::Relaxed));
        if peak > prev {
            sb.level.store(peak.to_bits(), Ordering::Relaxed);
        }
        if sb.buffered {
            if let Ok(mut b) = sb.buf.lock() {
                b.extend(samples);
                while b.len() > max_keep {
                    b.pop_front();
                }
            }
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

fn spawn_capture(src: Source, sb: Arc<SourceBuf>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("audio-{:?}", src))
        .spawn(move || {
            if let Err(e) = capture(&src, &sb, &stop) {
                if let Ok(mut er) = sb.error.lock() {
                    *er = Some(e);
                }
            }
            sb.alive.store(false, Ordering::Relaxed);
        })
        .expect("spawn audio thread")
}

/// Take exactly `n` stereo frames from a source, padding with silence when it
/// is behind and dropping old audio when it has drifted ahead.
fn take(sb: Option<&Arc<SourceBuf>>, n: usize, vol: f32) -> Vec<f32> {
    let mut out = vec![0f32; n * 2];
    let Some(sb) = sb else { return out };
    let Ok(mut b) = sb.buf.lock() else { return out };
    let avail = b.len() / 2;
    let slack = (RATE as f64 * 0.35) as usize;
    if avail > n + slack {
        let drop_frames = avail - n - (RATE / 10);
        b.drain(..drop_frames * 2);
    }
    let avail = b.len() / 2;
    let k = avail.min(n);
    for (i, v) in b.drain(..k * 2).enumerate() {
        out[i] = v * vol;
    }
    out
}

pub struct AudioPipeline {
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    pub game: Option<Arc<SourceBuf>>,
    pub mic: Option<Arc<SourceBuf>>,
}

impl AudioPipeline {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
    pub fn warnings(&self) -> Vec<String> {
        let mut w = Vec::new();
        if let Some(g) = &self.game {
            if let Some(e) = g.error() {
                w.push(format!("游戏声音采集失败：{e}"));
            }
        }
        if let Some(m) = &self.mic {
            if let Some(e) = m.error() {
                w.push(format!("麦克风采集失败：{e}"));
            }
        }
        w
    }
}

/// Start capture threads and the 4-channel writer feeding ffmpeg's stdin.
pub fn start_pipeline(
    mut sink: std::process::ChildStdin,
    game: Option<Source>,
    mic: Option<Source>,
    game_vol: f32,
    mic_vol: f32,
) -> AudioPipeline {
    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();
    let game_buf = game.map(|src| {
        let sb = SourceBuf::new(true);
        handles.push(spawn_capture(src, sb.clone(), stop.clone()));
        sb
    });
    let mic_buf = mic.map(|src| {
        let sb = SourceBuf::new(true);
        handles.push(spawn_capture(src, sb.clone(), stop.clone()));
        sb
    });

    {
        let stop = stop.clone();
        let g = game_buf.clone();
        let m = mic_buf.clone();
        handles.push(
            thread::Builder::new()
                .name("audio-writer".into())
                .spawn(move || {
                    let t0 = Instant::now();
                    let delay = 0.12f64;
                    let mut written: u64 = 0;
                    let mut bytes: Vec<u8> = Vec::with_capacity(RATE * 16);
                    while !stop.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(10));
                        let el = t0.elapsed().as_secs_f64() - delay;
                        if el <= 0.0 {
                            continue;
                        }
                        let target = (el * RATE as f64) as u64;
                        if target <= written {
                            continue;
                        }
                        let n = (target - written) as usize;
                        let gs = take(g.as_ref(), n, game_vol);
                        let ms = take(m.as_ref(), n, mic_vol);
                        bytes.clear();
                        for i in 0..n {
                            for v in [gs[i * 2], gs[i * 2 + 1], ms[i * 2], ms[i * 2 + 1]] {
                                bytes.extend_from_slice(&v.clamp(-1.0, 1.0).to_le_bytes());
                            }
                        }
                        if sink.write_all(&bytes).is_err() {
                            break;
                        }
                        written = target;
                    }
                    let _ = sink.flush();
                    drop(sink);
                })
                .expect("spawn audio writer"),
        );
    }

    AudioPipeline {
        stop,
        handles,
        game: game_buf,
        mic: mic_buf,
    }
}

// ---------------------------------------------------------------------------
// level monitor for the onboarding / settings screen

pub struct Monitor {
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
}

impl Monitor {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Levels {
    pub game: f32,
    pub mic: f32,
    pub game_error: Option<String>,
    pub mic_error: Option<String>,
}

pub fn start_monitor<F>(game: Option<Source>, mic: Option<Source>, on_level: F) -> Monitor
where
    F: Fn(Levels) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();
    let g = game.map(|src| {
        let sb = SourceBuf::new(false);
        handles.push(spawn_capture(src, sb.clone(), stop.clone()));
        sb
    });
    let m = mic.map(|src| {
        let sb = SourceBuf::new(false);
        handles.push(spawn_capture(src, sb.clone(), stop.clone()));
        sb
    });
    {
        let stop = stop.clone();
        handles.push(thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(66));
                on_level(Levels {
                    game: g.as_ref().map(|s| s.take_level()).unwrap_or(0.0),
                    mic: m.as_ref().map(|s| s.take_level()).unwrap_or(0.0),
                    game_error: g.as_ref().and_then(|s| s.error()),
                    mic_error: m.as_ref().and_then(|s| s.error()),
                });
            }
        }));
    }
    Monitor { stop, handles }
}

// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

fn list_dir(
    en: &wasapi::DeviceEnumerator,
    dir: &wasapi::Direction,
) -> Result<Vec<AudioDevice>, String> {
    let default_id = en
        .get_default_device(dir)
        .ok()
        .and_then(|d| d.get_id().ok());
    let coll = en.get_device_collection(dir).map_err(e2s)?;
    let mut out = Vec::new();
    for dev in &coll {
        let Ok(dev) = dev else { continue };
        let id = dev.get_id().unwrap_or_default();
        let name = dev.get_friendlyname().unwrap_or_else(|_| id.clone());
        out.push(AudioDevice {
            is_default: Some(&id) == default_id.as_ref(),
            id,
            name,
        });
    }
    Ok(out)
}

pub fn list_devices() -> Result<AudioDevices, String> {
    thread::spawn(|| {
        let _ = wasapi::initialize_mta();
        let en = wasapi::DeviceEnumerator::new().map_err(e2s)?;
        Ok(AudioDevices {
            inputs: list_dir(&en, &wasapi::Direction::Capture)?,
            outputs: list_dir(&en, &wasapi::Direction::Render)?,
        })
    })
    .join()
    .map_err(|_| "audio thread panicked".to_string())?
}
