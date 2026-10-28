//! Old recordings re-encoded to AV1 in the background: usually about half the
//! size, hard to tell apart. Only on the GPU (no CPU cost) and only to AV1,
//! which the app's player (WebView2) always plays; HEVC needs a Windows
//! extension that may be missing, so it isn't used.
//!
//! A file is replaced only after the new one checks out (same length, clearly
//! smaller) and the original hasn't changed meanwhile.

use crate::ffmpeg;
use crate::i18n::tr;
use crate::library::{Lib, MatchRecord};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

/// ffmpeg's priority while compressing (Windows IDLE_PRIORITY_CLASS)
const IDLE: u32 = 0x0000_0040;
/// keep the new file only when it's at most this share of the old one
const KEEP_IF_BELOW: f64 = 0.85;

/// The GPU's AV1 encoder, if it has one that works.
pub fn av1_encoder(ff: &Path) -> Option<&'static str> {
    for enc in ["av1_nvenc"] {
        let args: Vec<String> = [
            "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v",
            "10", "-c:v", enc, "-f", "null", "-",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if ffmpeg::run(ff, &args, IDLE).map(|o| o.status.success()).unwrap_or(false) {
            return Some(enc);
        }
    }
    None
}

fn encoder_args(enc: &str) -> Vec<String> {
    let a: &[&str] = match enc {
        // constant quality: busy scenes get the bits they need, static ones don't
        "av1_nvenc" => &["-c:v", "av1_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "30", "-b:v", "0"],
        _ => &[],
    };
    a.iter().map(|s| s.to_string()).collect()
}

/// The video files of a recording (the full match and / or the highlight clips).
pub fn files_of(rec: &MatchRecord) -> Vec<PathBuf> {
    let dir = Path::new(&rec.dir);
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(v) = &rec.video {
        out.push(dir.join(v));
    }
    for h in &rec.highlights {
        if let Some(f) = &h.file {
            let p = dir.join(f);
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out.into_iter().filter(|p| p.exists()).collect()
}

/// Is this recording due: old enough and not done yet?
pub fn due(rec: &MatchRecord, older_than_days: u32, now_ms: i64) -> bool {
    !rec.compressed && rec.created_at_ms > 0 && now_ms - rec.created_at_ms > older_than_days as i64 * 86_400_000
}

fn stamp(p: &Path) -> Option<(u64, SystemTime)> {
    let m = fs::metadata(p).ok()?;
    Some((m.len(), m.modified().ok()?))
}

pub enum FileResult {
    /// replaced; bytes saved
    Saved(u64),
    /// AV1 wasn't smaller enough (already small, mostly static…): kept the original
    Kept,
}

/// Re-encode one file. `stop` is asked twice a second; when it says so the
/// encode is abandoned and the original stays.
pub fn compress_file(ff: &Path, file: &Path, enc: &str, stop: &dyn Fn() -> bool) -> Result<FileResult, String> {
    let before = stamp(file).ok_or_else(|| tr("找不到录像文件", "Recording file not found"))?;
    let dur = ffmpeg::probe_duration(ff, file);
    let tmp = file.with_extension("av1.tmp.mp4");
    let _ = fs::remove_file(&tmp);
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-i"].iter().map(|s| s.to_string()).collect();
    args.push(file.to_string_lossy().to_string());
    // every stream as it is (all audio tracks, their names), only the video re-encoded
    args.extend(["-map", "0", "-map_metadata", "0"].iter().map(|s| s.to_string()));
    args.extend(encoder_args(enc));
    args.extend(["-g", "240", "-c:a", "copy", "-movflags", "+faststart"].iter().map(|s| s.to_string()));
    args.push(tmp.to_string_lossy().to_string());

    let mut child = ffmpeg::command(ff, IDLE)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let mut err = String::new();
                    if let Some(mut s) = child.stderr.take() {
                        use std::io::Read;
                        let _ = s.read_to_string(&mut err);
                    }
                    let _ = fs::remove_file(&tmp);
                    return Err(tr(
                        format!("压缩失败：{}", ffmpeg::tail(&err, 4)),
                        format!("Compression failed: {}", ffmpeg::tail(&err, 4)),
                    ));
                }
                break;
            }
            Ok(None) => {
                if stop() {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&tmp);
                    return Err(tr("压缩暂停了", "Compression paused"));
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
        }
    }

    let old_len = before.0;
    let new_len = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    // the new file must be whole: same length as the original
    let same_len = match (dur, ffmpeg::probe_duration(ff, &tmp)) {
        (Some(a), Some(b)) => (a - b).abs() < 1.0,
        (None, _) => true,
        _ => false,
    };
    if new_len == 0 || !same_len {
        let _ = fs::remove_file(&tmp);
        return Err(tr("压缩后的文件不完整，原文件保留", "The compressed file was incomplete; kept the original"));
    }
    if (new_len as f64) > old_len as f64 * KEEP_IF_BELOW {
        let _ = fs::remove_file(&tmp);
        return Ok(FileResult::Kept);
    }
    // changed while compressing (re-cut, replaced): this result is stale
    if stamp(file) != Some(before) {
        let _ = fs::remove_file(&tmp);
        return Err(tr("录像在压缩期间被改动了，下次再试", "The recording changed while compressing; will retry"));
    }
    // fails while the file is open elsewhere (playing in KillCam, Explorer preview): retried later
    fs::rename(&tmp, file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        tr(format!("替换原文件失败：{e}"), format!("Couldn't replace the original: {e}"))
    })?;
    Ok(FileResult::Saved(old_len.saturating_sub(new_len)))
}

/// Compress one recording's files. Marks it done when every file is done
/// (compressed or not worth it); on a stop or error it stays due.
pub fn compress_record(lib: &Lib, ff: &Path, id: &str, enc: &str, stop: &dyn Fn() -> bool) -> Result<u64, String> {
    let rec = lib.get(id).ok_or_else(|| tr("找不到这场录像", "Recording not found"))?;
    let mut saved = 0u64;
    for f in files_of(&rec) {
        if stop() {
            return Err(tr("压缩暂停了", "Compression paused"));
        }
        if let FileResult::Saved(n) = compress_file(ff, &f, enc, stop)? {
            saved += n;
        }
    }
    // re-read: the user may have changed it meanwhile (favorite, trims)
    let mut now = lib.get(id).ok_or_else(|| tr("找不到这场录像", "Recording not found"))?;
    now.compressed = true;
    now.saved_bytes += saved;
    now.size_bytes = crate::library::folder_size(Path::new(&now.dir));
    lib.save(&now)?;
    Ok(saved)
}

/// Recordings due for compression, oldest first.
pub fn due_list(lib: &Lib, older_than_days: u32, now_ms: i64) -> Vec<MatchRecord> {
    let mut v: Vec<MatchRecord> = lib.list().into_iter().filter(|m| due(m, older_than_days, now_ms)).collect();
    v.sort_by_key(|m| m.created_at_ms);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_after_the_set_days_only_once() {
        let day = 86_400_000i64;
        let now = 100 * day;
        let mut m = MatchRecord {
            created_at_ms: now - 15 * day,
            ..Default::default()
        };
        assert!(due(&m, 14, now));
        assert!(!due(&m, 30, now));
        m.compressed = true;
        assert!(!due(&m, 14, now));
        let fresh = MatchRecord {
            created_at_ms: now - day,
            ..Default::default()
        };
        assert!(!due(&fresh, 14, now));
    }
}
