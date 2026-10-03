//! Everything that talks to ffmpeg.exe.
//!
//! The recording pipeline never brings frames into system memory:
//! ddagrab (Desktop Duplication, D3D11 texture) -> scale_d3d11 (GPU) -> NVENC / AMF.

use crate::settings::VideoSettings;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
pub const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;

/// Build a Command for ffmpeg with no console window and the given priority class.
pub fn command(ffmpeg: &Path, priority: u32) -> Command {
    let mut c = Command::new(ffmpeg);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW | priority);
    #[cfg(not(windows))]
    let _ = priority;
    c.stdin(Stdio::null());
    c
}

/// A plain hidden command for other tools (nvidia-smi, explorer...).
pub fn hidden(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.stdin(Stdio::null());
    c
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn works(p: &Path) -> bool {
    command(p, 0)
        .arg("-hide_banner")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether this ffmpeg still takes `-thread_queue_size` as an input option.
/// Newer builds moved it to the muxer and refuse it in front of `-i`, which
/// would make every recording fail to start. Probed once per ffmpeg path.
pub fn input_queue_supported(ffmpeg: &Path) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().ok().and_then(|c| c.get(ffmpeg).copied()) {
        return v;
    }
    let ok = command(ffmpeg, 0)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-thread_queue_size",
            "64",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000",
            "-t",
            "0.05",
            "-f",
            "null",
            "-",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if let Ok(mut c) = cache.lock() {
        c.insert(ffmpeg.to_path_buf(), ok);
    }
    ok
}

/// Find a usable ffmpeg: explicit setting, next to the exe, ./bin, then PATH.
pub fn locate(explicit: Option<&str>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(e) = explicit {
        if !e.trim().is_empty() {
            candidates.push(PathBuf::from(e.trim()));
        }
    }
    if let Some(d) = exe_dir() {
        candidates.push(d.join("ffmpeg.exe"));
        candidates.push(d.join("bin").join("ffmpeg.exe"));
    }
    candidates.push(PathBuf::from("ffmpeg.exe"));
    candidates.push(PathBuf::from("ffmpeg"));
    candidates.into_iter().find(|c| works(c))
}

pub fn run(ffmpeg: &Path, args: &[String], priority: u32) -> Result<Output, String> {
    command(ffmpeg, priority)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("无法启动 ffmpeg: {e}"))
}

pub fn run_ok(ffmpeg: &Path, args: &[String], priority: u32) -> Result<(), String> {
    let out = run(ffmpeg, args, priority)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(tail(&String::from_utf8_lossy(&out.stderr), 8))
    }
}

pub fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

fn s(v: &str) -> String {
    v.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub path: String,
    pub version: String,
    pub has_ddagrab: bool,
    pub has_scale_d3d11: bool,
}

pub fn info(ffmpeg: &Path) -> FfmpegInfo {
    let version = run(ffmpeg, &[s("-hide_banner"), s("-version")], 0)
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
        })
        .unwrap_or_default();
    let filters = run(ffmpeg, &[s("-hide_banner"), s("-filters")], 0)
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    FfmpegInfo {
        path: ffmpeg.to_string_lossy().to_string(),
        version,
        has_ddagrab: filters.contains(" ddagrab "),
        has_scale_d3d11: filters.contains(" scale_d3d11 "),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    pub id: String,
    pub label: String,
    pub vendor: String,
    pub available: bool,
}

/// Try a tiny real encode with each hardware encoder.
pub fn probe_encoders(ffmpeg: &Path) -> Vec<EncoderInfo> {
    let list = [
        ("h264_nvenc", "H.264 (NVENC)", "nvidia"),
        ("hevc_nvenc", "HEVC / H.265 (NVENC)", "nvidia"),
        ("av1_nvenc", "AV1 (NVENC)", "nvidia"),
        ("h264_amf", "H.264 (AMD AMF)", "amd"),
        ("hevc_amf", "HEVC (AMD AMF)", "amd"),
        ("av1_amf", "AV1 (AMD AMF)", "amd"),
    ];
    list.iter()
        .map(|(id, label, vendor)| {
            let args = vec![
                s("-hide_banner"),
                s("-loglevel"),
                s("error"),
                s("-f"),
                s("lavfi"),
                s("-i"),
                s("color=c=black:s=1280x720:r=30"),
                s("-frames:v"),
                s("10"),
                s("-c:v"),
                s(id),
                s("-f"),
                s("null"),
                s("-"),
            ];
            let available = run(ffmpeg, &args, 0)
                .map(|o| o.status.success())
                .unwrap_or(false);
            EncoderInfo {
                id: s(id),
                label: s(label),
                vendor: s(vendor),
                available,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub thumbnail: String,
}

/// Enumerate DXGI outputs by grabbing one frame from each until ddagrab fails.
pub fn list_monitors(ffmpeg: &Path, thumb_dir: &Path) -> Vec<MonitorInfo> {
    let _ = std::fs::create_dir_all(thumb_dir);
    let re = Regex::new(r"\bs:(\d+)x(\d+)").unwrap();
    let mut out = Vec::new();
    for i in 0..6u32 {
        let thumb = thumb_dir.join(format!("monitor_{i}.jpg"));
        let args = vec![
            s("-hide_banner"),
            s("-loglevel"),
            s("info"),
            s("-y"),
            s("-filter_complex"),
            format!(
                "ddagrab=output_idx={i}:draw_mouse=0,hwdownload,format=bgra,showinfo,scale=640:-2"
            ),
            s("-frames:v"),
            s("1"),
            s("-q:v"),
            s("4"),
            thumb.to_string_lossy().to_string(),
        ];
        let Ok(o) = run(ffmpeg, &args, 0) else { break };
        if !o.status.success() {
            break;
        }
        let err = String::from_utf8_lossy(&o.stderr);
        let (w, h) = re
            .captures(&err)
            .map(|c| (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0)))
            .unwrap_or((0, 0));
        out.push(MonitorInfo {
            index: i,
            width: w,
            height: h,
            thumbnail: thumb.to_string_lossy().to_string(),
        });
    }
    out
}

/// scale_d3d11 exists in many builds but fails on some driver / GPU combos
/// ("Failed to configure output pad"). Run a 3-frame test to find out.
pub fn probe_gpu_scale(ffmpeg: &Path, monitor_index: u32) -> bool {
    let args = vec![
        s("-hide_banner"),
        s("-loglevel"),
        s("error"),
        s("-filter_complex"),
        format!(
            "ddagrab=output_idx={monitor_index}:framerate=30:draw_mouse=0,scale_d3d11=width=1280:height=720:format=nv12"
        ),
        s("-frames:v"),
        s("3"),
        s("-c:v"),
        s("h264_nvenc"),
        s("-f"),
        s("null"),
        s("-"),
    ];
    run(ffmpeg, &args, 0)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Duration of a media file in seconds (parsed from `ffmpeg -i`).
pub fn probe_duration(ffmpeg: &Path, file: &Path) -> Option<f64> {
    let o = run(
        ffmpeg,
        &[
            s("-hide_banner"),
            s("-i"),
            file.to_string_lossy().to_string(),
        ],
        0,
    )
    .ok()?;
    let err = String::from_utf8_lossy(&o.stderr);
    let re = Regex::new(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)").ok()?;
    let c = re.captures(&err)?;
    let h: f64 = c[1].parse().ok()?;
    let m: f64 = c[2].parse().ok()?;
    let sec: f64 = c[3].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

fn even(v: u32) -> u32 {
    v - (v % 2)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePlan {
    pub filter: String,
    pub out_width: u32,
    pub out_height: u32,
}

/// Build the GPU-only capture filter for the recording.
pub fn capture_plan(v: &VideoSettings, has_scale_d3d11: bool) -> CapturePlan {
    let fps = if v.fps == 0 { 60 } else { v.fps };
    let mut f = format!(
        "ddagrab=output_idx={}:framerate={}:draw_mouse=0",
        v.monitor_index, fps
    );
    let (sw, sh) = (v.monitor_width, v.monitor_height);
    if sw == 0 || sh == 0 {
        if has_scale_d3d11 {
            f.push_str(",scale_d3d11=format=nv12");
        }
        return CapturePlan {
            filter: f,
            out_width: 0,
            out_height: 0,
        };
    }
    // optional 16:9 center crop, done by ddagrab itself (no copy)
    let mut cw = sw;
    if v.aspect == "16:9" && (sw as u64) * 9 > (sh as u64) * 16 {
        cw = even(sh * 16 / 9);
        let ox = (sw - cw) / 2;
        f.push_str(&format!(
            ":video_size={}x{}:offset_x={}:offset_y=0",
            cw, sh, ox
        ));
    }
    let th = if v.height == 0 || v.height >= sh {
        sh
    } else {
        v.height
    };
    let tw = even(((cw as f64) * (th as f64) / (sh as f64)).round() as u32);
    let th = even(th);
    if has_scale_d3d11 {
        if th == sh && tw == cw {
            f.push_str(",scale_d3d11=format=nv12");
        } else {
            f.push_str(&format!(
                ",scale_d3d11=width={}:height={}:format=nv12",
                tw, th
            ));
        }
        CapturePlan {
            filter: f,
            out_width: tw,
            out_height: th,
        }
    } else {
        CapturePlan {
            filter: f,
            out_width: cw,
            out_height: sh,
        }
    }
}

/// Encoder arguments for the live recording.
pub fn encoder_args(encoder: &str, bitrate_mbps: u32, fps: u32) -> Vec<String> {
    let b = bitrate_mbps.max(2);
    let gop = (fps.max(30) * 2).to_string();
    let mut a: Vec<String> = vec![s("-c:v"), s(encoder)];
    if encoder.ends_with("_nvenc") {
        let cq = if encoder.starts_with("h264") {
            "23"
        } else if encoder.starts_with("hevc") {
            "26"
        } else {
            "30"
        };
        a.extend([
            s("-preset"),
            s("p4"),
            s("-tune"),
            s("hq"),
            s("-rc"),
            s("vbr"),
            s("-cq"),
            s(cq),
            s("-b:v"),
            format!("{}M", b),
            s("-maxrate"),
            format!("{}M", b * 3 / 2),
            s("-bufsize"),
            format!("{}M", b * 2),
        ]);
    } else if encoder.ends_with("_amf") {
        a.extend([
            s("-usage"),
            s("transcoding"),
            s("-quality"),
            s("balanced"),
            s("-rc"),
            s("vbr_peak"),
            s("-b:v"),
            format!("{}M", b),
            s("-maxrate"),
            format!("{}M", b * 3 / 2),
        ]);
    } else {
        a.extend([s("-b:v"), format!("{}M", b)]);
    }
    a.extend([s("-g"), gop]);
    a
}

/// Encoder arguments for exports (quality first, not live).
pub fn export_encoder_args(encoder: &str) -> Vec<String> {
    if encoder.ends_with("_nvenc") {
        vec![
            s("-c:v"),
            s("h264_nvenc"),
            s("-preset"),
            s("p5"),
            s("-rc"),
            s("vbr"),
            s("-cq"),
            s("20"),
            s("-b:v"),
            s("0"),
            s("-maxrate"),
            s("60M"),
            s("-bufsize"),
            s("120M"),
            s("-profile:v"),
            s("high"),
        ]
    } else if encoder.ends_with("_amf") {
        vec![
            s("-c:v"),
            s("h264_amf"),
            s("-quality"),
            s("quality"),
            s("-rc"),
            s("cqp"),
            s("-qp_i"),
            s("20"),
            s("-qp_p"),
            s("22"),
        ]
    } else {
        vec![
            s("-c:v"),
            s("libx264"),
            s("-preset"),
            s("veryfast"),
            s("-crf"),
            s("20"),
        ]
    }
}

/// Read GPU name via nvidia-smi, falling back to WMI through PowerShell.
pub fn gpu_name() -> String {
    if let Ok(o) = hidden("nvidia-smi")
        .args(["--query-gpu=name,driver_version", "--format=csv,noheader"])
        .output()
    {
        if o.status.success() {
            let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !t.is_empty() {
                let mut parts = t.lines().next().unwrap_or("").split(',');
                let name = parts.next().unwrap_or("").trim().to_string();
                let drv = parts.next().unwrap_or("").trim().to_string();
                return if drv.is_empty() {
                    name
                } else {
                    format!("{name}（驱动 {drv}）")
                };
            }
        }
    }
    if let Ok(o) = hidden("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ' / '",
        ])
        .output()
    {
        let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    "未知显卡".into()
}
