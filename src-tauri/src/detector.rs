//! Real-time screen reading for PUBG prompts: kills, knocks, deaths and chicken dinner.
//!
//! A second, tiny ffmpeg process duplicates only one band of the screen
//! (ddagrab crops on the GPU) at a few frames per second, downloads it as RGB
//! and pipes it here. Each frame becomes binary colour masks (orange-red
//! prompt text, white prompt text, yellow banner text) that are compared with
//! templates cut from the player's own recordings (normalized correlation,
//! with an integral-image pre-filter so empty areas cost nothing).
//!
//! Three kinds of prompt behave differently:
//! * counter ("12 淘汰数" under the crosshair): stays up, only the number
//!   changes. A settled change of the number region = a new kill.
//! * lines ("你用 Beryl M762 击倒了 XXX"): several can be stacked and they move
//!   when new ones arrive. Every line is fingerprinted by the name next to the
//!   matched words; a fingerprint not seen in the last seconds = a new knock.
//! * appear ("大吉大利！今晚吃鸡！", "X 用 Y 淘汰了你"): one detection per
//!   appearance, with an optional cooldown and a second glyph group that has to
//!   sit next to the match (the red "淘汰" before the white "了你").
//!
//! Templates live in `detector/pack.bin` (embedded at compile time).

use crate::ffmpeg;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

static PACK: &[u8] = include_bytes!("../detector/pack.bin");

const FPS: u32 = 6;
/// patch similarity below this = "different"
const CHANGE: f32 = 0.85;
/// line fingerprints closer than this are the same line
const SAME_LINE: f32 = 0.7;
/// pixels the kill counter's number may shift between frames: the match position
/// jitters a little, more on screens that are read scaled (1080p)
const COUNTER_SLACK: i32 = 3;
/// A new number must also differ at a coarser scale: when the digits get thinner or
/// thicker with what's behind them, they still look the same there (block size,
/// and the similarity below which the number counts as changed).
const POOL: i32 = 5;
const POOL_CHANGED: f32 = 0.93;
/// how long the counter animates after popping in
const COUNTER_POP_MS: i64 = 700;

const FEAT_RED: u32 = 1;
const FEAT_WHITE: u32 = 2;
const FEAT_YELLOW: u32 = 3;

const MODE_APPEAR: u32 = 0;
const MODE_COUNTER: u32 = 1;
const MODE_LINES: u32 = 2;

#[derive(Debug, Clone)]
pub struct Template {
    pub kind: String,
    pub feature: u32,
    pub mode: u32,
    /// left edge relative to the screen centre (reference pixels)
    pub cx: i32,
    pub y: i32,
    pub w: usize,
    pub h: usize,
    pub threshold: f32,
    pub search_x: i32,
    pub search_y: i32,
    /// counter: number region x0..x1 relative to the template's left edge.
    /// lines: p0 = width of the fingerprint region right of the template.
    pub p0: i32,
    pub p1: i32,
    /// on-pixels of the binary template, (row, col)
    on: Vec<(usize, usize)>,
    /// a second glyph group that must sit next to a match (cx/y = offset from the
    /// match, any feature), e.g. the red "淘汰" left of the white "了你"
    pub confirm: Option<Box<Template>>,
    /// the confirm glyphs must NOT be there (e.g. "你" right after "击倒了"
    /// means someone knocked *you*, not the other way round)
    pub confirm_negate: bool,
}

#[derive(Debug, Clone)]
pub struct Pack {
    pub ref_h: u32,
    pub scale: f32,
    pub templates: Vec<Template>,
}

fn rd_u32(b: &[u8], p: &mut usize) -> Option<u32> {
    let v = b.get(*p..*p + 4)?;
    *p += 4;
    Some(u32::from_le_bytes([v[0], v[1], v[2], v[3]]))
}

fn rd_i32(b: &[u8], p: &mut usize) -> Option<i32> {
    rd_u32(b, p).map(|v| v as i32)
}

fn rd_f32(b: &[u8], p: &mut usize) -> Option<f32> {
    rd_u32(b, p).map(f32::from_bits)
}

fn rd_bits(b: &[u8], p: &mut usize, w: usize, h: usize) -> Option<Vec<(usize, usize)>> {
    let data = b.get(*p..*p + w * h)?;
    *p += w * h;
    let mut on = Vec::new();
    for r in 0..h {
        for c in 0..w {
            if data[r * w + c] > 127 {
                on.push((r, c));
            }
        }
    }
    Some(on)
}

/// Pack v3/v4 (little endian):
/// "KCDT" | u32 3 | u32 ref_h | f32 scale | u32 count |
///   per template: u32 kind_len | kind | u32 feature | u32 mode | i32 cx | i32 y |
///   u32 w | u32 h | f32 threshold | i32 search_x | i32 search_y | i32 p0 | i32 p1 |
///   w*h bytes (0 / 255) |
///   v4 only: u32 has_confirm (0 none, 1 must match, 2 must not match) | [u32 feature | i32 dx | i32 dy | u32 w | u32 h |
///   f32 threshold | w*h bytes]
/// appear mode: p0 = cooldown in ms after a detection
pub fn load_pack() -> Option<Pack> {
    let b = PACK;
    if b.len() < 20 || &b[0..4] != b"KCDT" {
        return None;
    }
    let mut p = 4usize;
    let version = rd_u32(b, &mut p)?;
    if version != 3 && version != 4 {
        return None;
    }
    let ref_h = rd_u32(b, &mut p)?;
    let scale = rd_f32(b, &mut p)?;
    let count = rd_u32(b, &mut p)? as usize;
    let mut templates = Vec::with_capacity(count);
    for _ in 0..count {
        let kl = rd_u32(b, &mut p)? as usize;
        let kind = String::from_utf8_lossy(b.get(p..p + kl)?).to_string();
        p += kl;
        let feature = rd_u32(b, &mut p)?;
        let mode = rd_u32(b, &mut p)?;
        let cx = rd_i32(b, &mut p)?;
        let y = rd_i32(b, &mut p)?;
        let w = rd_u32(b, &mut p)? as usize;
        let h = rd_u32(b, &mut p)? as usize;
        let threshold = rd_f32(b, &mut p)?;
        let search_x = rd_i32(b, &mut p)?;
        let search_y = rd_i32(b, &mut p)?;
        let p0 = rd_i32(b, &mut p)?;
        let p1 = rd_i32(b, &mut p)?;
        let on = rd_bits(b, &mut p, w, h)?;
        let mut confirm = None;
        let mut confirm_negate = false;
        let has_confirm = if version >= 4 { rd_u32(b, &mut p)? } else { 0 };
        if has_confirm == 1 || has_confirm == 2 {
            confirm_negate = has_confirm == 2;
            let feature = rd_u32(b, &mut p)?;
            let dx = rd_i32(b, &mut p)?;
            let dy = rd_i32(b, &mut p)?;
            let cw = rd_u32(b, &mut p)? as usize;
            let ch = rd_u32(b, &mut p)? as usize;
            let threshold = rd_f32(b, &mut p)?;
            let on = rd_bits(b, &mut p, cw, ch)?;
            if !on.is_empty() {
                confirm = Some(Box::new(Template {
                    kind: String::new(),
                    feature,
                    mode: MODE_APPEAR,
                    cx: dx,
                    y: dy,
                    w: cw,
                    h: ch,
                    threshold,
                    search_x: 2,
                    search_y: 1,
                    p0: 0,
                    p1: 0,
                    on,
                    confirm: None,
                    confirm_negate: false,
                }));
            }
        }
        if on.is_empty() {
            continue;
        }
        templates.push(Template {
            kind,
            feature,
            mode,
            cx,
            y,
            w,
            h,
            threshold,
            search_x,
            search_y,
            p0,
            p1,
            on,
            confirm,
            confirm_negate,
        });
    }
    if templates.is_empty() {
        None
    } else {
        Some(Pack {
            ref_h,
            scale,
            templates,
        })
    }
}

pub fn ready() -> bool {
    load_pack().is_some()
}

/// A binary mask with an integral image for O(1) window counts.
struct Mask {
    w: usize,
    h: usize,
    px: Vec<u8>,
    /// (w+1)*(h+1) summed-area table
    sat: Vec<u32>,
}

impl Mask {
    fn build(rgb: &[u8], w: usize, h: usize, feature: u32) -> Mask {
        let mut px = Vec::with_capacity(w * h);
        for c in rgb.chunks_exact(3) {
            let (r, g, b) = (c[0] as i32, c[1] as i32, c[2] as i32);
            let on = match feature {
                FEAT_RED => r > 190 && g < 150 && b < 130 && r - g > 80,
                FEAT_WHITE => {
                    let mn = r.min(g).min(b);
                    let mx = r.max(g).max(b);
                    mn > 200 && mx - mn < 40
                }
                FEAT_YELLOW => r > 200 && g > 150 && b < 90,
                _ => false,
            };
            px.push(on as u8);
        }
        Mask::from_px(w, h, px)
    }

    fn from_px(w: usize, h: usize, px: Vec<u8>) -> Mask {
        let mut sat = vec![0u32; (w + 1) * (h + 1)];
        for y in 0..h {
            let mut row = 0u32;
            for x in 0..w {
                row += px[y * w + x] as u32;
                sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
            }
        }
        Mask { w, h, px, sat }
    }

    fn count(&self, x: usize, y: usize, w: usize, h: usize) -> u32 {
        let s = &self.sat;
        let ww = self.w + 1;
        s[(y + h) * ww + x + w] + s[y * ww + x] - s[y * ww + x + w] - s[(y + h) * ww + x]
    }

    /// Normalized correlation of a binary template at (x, y).
    fn score(&self, t: &Template, x: usize, y: usize) -> f32 {
        let n = (t.w * t.h) as f32;
        let tc = t.on.len() as f32;
        let s = self.count(x, y, t.w, t.h) as f32;
        // windows with far too few or too many lit pixels cannot match
        if s < tc * 0.4 || s > tc * 2.5 {
            return 0.0;
        }
        let mut hit = 0u32;
        for &(r, c) in &t.on {
            hit += self.px[(y + r) * self.w + x + c] as u32;
        }
        let num = hit as f32 - s * tc / n;
        let den = (s * (1.0 - s / n)).max(1e-6).sqrt() * (tc * (1.0 - tc / n)).max(1e-6).sqrt();
        num / den
    }

    fn patch(&self, x0: i32, y0: i32, w: i32, h: i32) -> Option<Vec<f32>> {
        if x0 < 0 || y0 < 0 || w <= 0 || h <= 0 {
            return None;
        }
        let (x0, y0, w, h) = (x0 as usize, y0 as usize, w as usize, h as usize);
        if y0 + h > self.h || x0 >= self.w {
            return None;
        }
        let mut out = Vec::with_capacity(w * h);
        for r in 0..h {
            for c in 0..w {
                let x = x0 + c;
                out.push(if x < self.w {
                    self.px[(y0 + r) * self.w + x] as f32
                } else {
                    0.0
                });
            }
        }
        Some(out)
    }
}

impl Mask {
    /// The patch averaged over POOL x POOL blocks: how thick the strokes come out
    /// (it changes with what's behind the half-transparent digits) matters less
    /// than their shape.
    fn pooled(&self, x0: i32, y0: i32, w: i32, h: i32, k: i32) -> Option<Vec<f32>> {
        let p = self.patch(x0, y0, w, h)?;
        if k <= 1 {
            return Some(p);
        }
        let (pw, ph) = ((w / k).max(1), (h / k).max(1));
        let mut out = vec![0f32; (pw * ph) as usize];
        for r in 0..(ph * k).min(h) {
            for c in 0..(pw * k).min(w) {
                out[((r / k) * pw + c / k) as usize] += p[(r * w + c) as usize];
            }
        }
        Some(out)
    }

    /// Best similarity of `reference` with the (pooled) patch at (x0, y0), allowing a small shift.
    fn ncc_near(&self, reference: &[f32], x0: i32, y0: i32, w: i32, h: i32, k: i32) -> f32 {
        let mut best = 0f32;
        for dy in -COUNTER_SLACK..=COUNTER_SLACK {
            for dx in -COUNTER_SLACK..=COUNTER_SLACK {
                if let Some(p) = self.pooled(x0 + dx, y0 + dy, w, h, k) {
                    best = best.max(ncc2(&p, reference));
                }
            }
        }
        best
    }
}

/// NCC between two equally sized patches.
fn ncc2(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let n = a.len() as f32;
    let ma = a.iter().sum::<f32>() / n;
    let mb = b.iter().sum::<f32>() / n;
    let (mut num, mut da, mut db) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b.iter()) {
        let (p, q) = (x - ma, y - mb);
        num += p * q;
        da += p * p;
        db += q * q;
    }
    if da <= 1e-6 || db <= 1e-6 {
        return if da <= 1e-6 && db <= 1e-6 { 1.0 } else { 0.0 };
    }
    num / (da.sqrt() * db.sqrt())
}

#[derive(Debug, Clone)]
pub struct Detection {
    pub kind: String,
    pub at_ms: i64,
    pub score: f32,
}

struct Line {
    sig: Vec<f32>,
    y: i32,
    first_ms: i64,
    seen_ms: i64,
}

#[derive(Default)]
struct Track {
    absent: u32,
    // appear
    last_fire: Option<i64>,
    // counter
    prev: Option<Vec<f32>>,
    reference: Option<Vec<f32>>,
    ref_pooled: Option<Vec<f32>>,
    appeared_ms: i64,
    drop_at: Option<i64>,
    drop_frames: u32,
    // lines
    recent: Vec<Line>,
    pending: Vec<(Vec<f32>, i64)>,
}

struct Placed {
    t: Template,
    px: i32,
    py: i32,
}

/// All matches of a template above threshold, best first, at most one per row band.
/// Whether the confirm glyphs sit next to a match at (x, y).
fn confirmed(cm: Option<&Mask>, c: &Template, x: i32, y: i32) -> bool {
    let Some(cm) = cm else { return false };
    for dy in -c.search_y..=c.search_y {
        for dx in -c.search_x..=c.search_x {
            let (cx, cy) = (x + c.cx + dx, y + c.y + dy);
            if cx < 0 || cy < 0 || cx as usize + c.w > cm.w || cy as usize + c.h > cm.h {
                continue;
            }
            if cm.score(c, cx as usize, cy as usize) >= c.threshold {
                return true;
            }
        }
    }
    false
}

fn matches(m: &Mask, cm: Option<&Mask>, p: &Placed, max: usize) -> Vec<(f32, i32, i32)> {
    let t = &p.t;
    let mut found: Vec<(f32, i32, i32)> = Vec::new();
    let mut all: Vec<(f32, i32, i32)> = Vec::new();
    for dy in -t.search_y..=t.search_y {
        let y = p.py + dy;
        if y < 0 || y as usize + t.h > m.h {
            continue;
        }
        for dx in -t.search_x..=t.search_x {
            let x = p.px + dx;
            if x < 0 || x as usize + t.w > m.w {
                continue;
            }
            let s = m.score(t, x as usize, y as usize);
            if s >= t.threshold {
                all.push((s, x, y));
            }
        }
    }
    all.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    for c in all {
        if found.iter().all(|f| (f.2 - c.2).abs() > 15) {
            if let Some(conf) = &t.confirm {
                if confirmed(cm, conf, c.1, c.2) == t.confirm_negate {
                    continue;
                }
            }
            found.push(c);
            if found.len() >= max {
                break;
            }
        }
    }
    found
}

fn step(p: &Placed, tr: &mut Track, m: &Mask, cm: Option<&Mask>, now_ms: i64) -> Vec<Detection> {
    let t = &p.t;
    let hits = matches(m, cm, p, if t.mode == MODE_LINES { 4 } else { 1 });
    let mut out = Vec::new();
    if hits.is_empty() {
        tr.absent += 1;
        // one missed frame (a muzzle flash over the digits) keeps the counter's
        // number: a kill that lands in that frame still shows up as a change
        if tr.absent >= 2 {
            tr.prev = None;
            tr.reference = None;
            tr.ref_pooled = None;
            tr.drop_at = None;
        }
        tr.pending.clear();
        tr.recent.retain(|l| now_ms - l.seen_ms < 8_000);
        return out;
    }
    let appeared = tr.absent >= 2;
    tr.absent = 0;
    let det = |at: i64, s: f32| Detection {
        kind: t.kind.clone(),
        at_ms: at,
        score: s,
    };

    match t.mode {
        MODE_APPEAR => {
            let cooling = tr
                .last_fire
                .map(|at| now_ms - at < t.p0.max(0) as i64)
                .unwrap_or(false);
            if appeared && !cooling {
                tr.last_fire = Some(now_ms);
                out.push(det(now_ms, hits[0].0));
            }
        }
        MODE_COUNTER => {
            let (s, bx, by) = hits[0];
            let (nx, nw, nh) = (bx + t.p0, t.p1 - t.p0, t.h as i32);
            let (Some(nm), Some(np)) = (m.pooled(nx, by, nw, nh, 1), m.pooled(nx, by, nw, nh, POOL)) else {
                return out;
            };
            if appeared || tr.reference.is_none() || tr.prev.is_none() {
                tr.reference = Some(nm.clone());
                tr.ref_pooled = Some(np);
                tr.prev = Some(nm);
                tr.drop_at = None;
                if appeared {
                    tr.appeared_ms = now_ms;
                    out.push(det(now_ms, s));
                }
                return out;
            }
            if now_ms - tr.appeared_ms < COUNTER_POP_MS {
                // the counter pops in with a little animation
                tr.reference = Some(nm.clone());
                tr.ref_pooled = Some(np);
                tr.prev = Some(nm);
                tr.drop_at = None;
                return out;
            }
            let c_prev = m.ncc_near(tr.prev.as_deref().unwrap_or(&[]), nx, by, nw, nh, 1);
            match tr.drop_at {
                None => {
                    if c_prev < CHANGE {
                        tr.drop_at = Some(now_ms);
                        tr.drop_frames = 0;
                    } else {
                        tr.reference = Some(nm.clone());
                        tr.ref_pooled = Some(np);
                    }
                }
                Some(at) => {
                    tr.drop_frames += 1;
                    if c_prev >= CHANGE {
                        let c_ref = m.ncc_near(tr.reference.as_deref().unwrap_or(&[]), nx, by, nw, nh, 1);
                        let c_pooled = m.ncc_near(tr.ref_pooled.as_deref().unwrap_or(&[]), nx, by, nw, nh, POOL);
                        if c_ref < CHANGE && c_pooled < POOL_CHANGED {
                            out.push(det(at, s));
                        }
                        tr.reference = Some(nm.clone());
                        tr.ref_pooled = Some(np);
                        tr.drop_at = None;
                    } else if tr.drop_frames > 8 {
                        tr.reference = Some(nm.clone());
                        tr.ref_pooled = Some(np);
                        tr.drop_at = None;
                    }
                }
            }
            tr.prev = Some(nm);
        }
        MODE_LINES => {
            let sig_w = t.p0.max(8);
            let mut next_pending: Vec<(Vec<f32>, i64)> = Vec::new();
            for &(s, x, y) in &hits {
                let Some(sig) = m.patch(x + t.w as i32, y - 2, sig_w, t.h as i32 + 4) else {
                    continue;
                };
                // a line we already know (maybe moved up the stack)
                if let Some(l) = tr
                    .recent
                    .iter_mut()
                    .find(|l| ncc2(&sig, &l.sig) >= SAME_LINE)
                {
                    l.seen_ms = now_ms;
                    continue;
                }
                // still animating in: same row as a line that just appeared
                if let Some(l) = tr
                    .recent
                    .iter_mut()
                    .find(|l| (l.y - y).abs() <= 8 && now_ms - l.first_ms < 1_500)
                {
                    l.sig = sig;
                    l.seen_ms = now_ms;
                    continue;
                }
                // new: confirm on the next frame
                if let Some(pos) = tr
                    .pending
                    .iter()
                    .position(|q| ncc2(&sig, &q.0) >= SAME_LINE)
                {
                    let first = tr.pending[pos].1;
                    out.push(det(first, s));
                    tr.recent.push(Line {
                        sig,
                        y,
                        first_ms: first,
                        seen_ms: now_ms,
                    });
                } else {
                    next_pending.push((sig, now_ms));
                }
            }
            tr.pending = next_pending;
            tr.recent.retain(|l| now_ms - l.seen_ms < 8_000);
        }
        _ => {}
    }
    out
}

pub struct Detector {
    stop: Arc<AtomicBool>,
    children: Vec<Arc<Mutex<Child>>>,
    handles: Vec<JoinHandle<()>>,
    pub error: Arc<Mutex<Option<String>>>,
}

impl Detector {
    pub fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        for c in &self.children {
            if let Ok(mut c) = c.lock() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        for h in self.handles {
            let _ = h.join();
        }
    }
}

/// Duplicate one rectangle of the screen (screen px) at `fps`, scaled to aw x ah, as RGB on stdout.
fn grab(
    ffmpeg_path: &Path,
    monitor_index: u32,
    fps: u32,
    (bx, by, bw, bh): (u32, u32, u32, u32),
    (aw, ah): (usize, usize),
    upscale: &str,
) -> Result<Child, String> {
    let scale_filter = if (aw as u32, ah as u32) == (bw, bh) {
        String::new()
    } else if (ah as u32) > bh {
        // smaller screens are read at the 1440p reference size
        format!(",scale={aw}:{ah}:flags={upscale}")
    } else {
        format!(",scale={aw}:{ah}:flags=area")
    };
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-filter_complex".into(),
        format!(
            "ddagrab=output_idx={monitor_index}:framerate={fps}:draw_mouse=0:video_size={bw}x{bh}:offset_x={bx}:offset_y={by},hwdownload,format=bgra{scale_filter},format=rgb24"
        ),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgb24".into(),
        "pipe:1".into(),
    ];
    ffmpeg::command(ffmpeg_path, ffmpeg::BELOW_NORMAL_PRIORITY_CLASS)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法启动识别进程：{e}"))
}

// ---- spectating ------------------------------------------------------------
//
// After the player is eliminated PUBG shows the teammate being watched: a card
// in the top left (name, "Lv.xxx", emblems) with an eye icon and the viewer
// count under it. Kills and knocks on screen during that time are the
// teammate's. The card's art differs per player, so only the white "Lv." and
// the eye are matched (1440p reference pixels, anchored to the left edge).

const SPEC_FPS: u32 = 2;
const SPEC_THRESHOLD: f32 = 0.55;
/// eye icon, top-left corner
const EYE_X: i32 = 48;
const EYE_Y: i32 = 218;
/// how far right of EYE_X the card may sit, and up / down
const EYE_SEARCH_X: i32 = 120;
const EYE_SEARCH_Y: i32 = 8;
/// "Lv." relative to the eye
const LV_DX: i32 = 148;
const LV_DY: i32 = -41;
/// the card hides while the map is open or when switching teammates;
/// spectating only ends when it stays away this long
const SPEC_HOLD_MS: i64 = 8_000;

static EYE: [&str; 32] = [
    "............................................",
    "............................................",
    "............................................",
    "............................................",
    "......................#.....................",
    ".................###......##................",
    "..............####..........####............",
    "............####..............###...........",
    "...........####................####.........",
    ".........#####..................####........",
    "........######...................####.......",
    ".......######........###.........#####......",
    "......#######......####..........######.....",
    "......######.......####...........######....",
    ".....#######......#####...........#######...",
    "....########......######..........#######...",
    "....########......##########......#######...",
    ".....#######......##########......#######...",
    "......######.......#########......######....",
    "......#######......########......######.....",
    ".......######.......######.......#####......",
    "........######..................######......",
    ".........#####..................#####.......",
    "..........#####................####.........",
    "............####..............####..........",
    "..............####..........####............",
    "................#####....####...............",
    ".....................####...................",
    "............................................",
    "............................................",
    "............................................",
    "............................................",
];

static LV: [&str; 20] = [
    "............................",
    "............................",
    "....##......................",
    "....##......................",
    "....##......................",
    "....##......................",
    "....##........##....##......",
    "....##........##....##......",
    "....##........###..###......",
    "....##........###..##.......",
    "....##.........##..##.......",
    "....##.........##..##.......",
    "....##.........##..##.......",
    "....##..........####........",
    "....##..........####........",
    "....###.........####.....##.",
    "....########....####.....###",
    "....########.....##......##.",
    "............................",
    "............................",
];

fn bitmap(kind: &str, rows: &[&str]) -> Template {
    let on = rows
        .iter()
        .enumerate()
        .flat_map(|(r, row)| {
            row.bytes()
                .enumerate()
                .filter(|(_, b)| *b == b'#')
                .map(move |(c, _)| (r, c))
        })
        .collect();
    Template {
        kind: kind.into(),
        feature: FEAT_WHITE,
        mode: MODE_APPEAR,
        cx: 0,
        y: 0,
        w: rows[0].len(),
        h: rows.len(),
        threshold: SPEC_THRESHOLD,
        search_x: 0,
        search_y: 0,
        p0: 0,
        p1: 0,
        on,
        confirm: None,
        confirm_negate: false,
    }
}

/// Is the spectate card on screen? `eye_y` = the eye's reference row inside the mask.
fn card_visible(m: &Mask, eye: &Template, lv: &Template, eye_y: i32) -> bool {
    let mut best = (0.0f32, 0i32, 0i32);
    for y in (eye_y - EYE_SEARCH_Y)..=(eye_y + EYE_SEARCH_Y) {
        if y < 0 || y as usize + eye.h > m.h {
            continue;
        }
        for x in 0..=(EYE_X + EYE_SEARCH_X) {
            if x as usize + eye.w > m.w {
                break;
            }
            let s = m.score(eye, x as usize, y as usize);
            if s > best.0 {
                best = (s, x, y);
            }
        }
    }
    if best.0 < SPEC_THRESHOLD {
        return false;
    }
    for dy in -3..=3 {
        for dx in -3..=3 {
            let (x, y) = (best.1 + LV_DX + dx, best.2 + LV_DY + dy);
            if x < 0 || y < 0 || x as usize + lv.w > m.w || y as usize + lv.h > m.h {
                continue;
            }
            if m.score(lv, x as usize, y as usize) >= SPEC_THRESHOLD {
                return true;
            }
        }
    }
    false
}

/// The analysed area for the card, in reference pixels: (x0, y0, x1, y1).
fn card_area() -> (i32, i32, i32, i32) {
    let eye_w = EYE[0].len() as i32;
    let lv_w = LV[0].len() as i32;
    let x1 = (EYE_X + EYE_SEARCH_X + eye_w).max(EYE_X + EYE_SEARCH_X + LV_DX + 3 + lv_w) + 4;
    let y0 = EYE_Y - EYE_SEARCH_Y + LV_DY - 3 - 4;
    let y1 = EYE_Y + EYE_SEARCH_Y + EYE.len() as i32 + 4;
    (0, y0, x1, y1)
}

/// Screen rectangle (y, w, h; it starts at the left edge), analysed size and the
/// eye's reference row inside it.
fn card_geometry(screen_w: u32, screen_h: u32, ref_h: u32) -> Result<(u32, u32, u32, usize, usize, i32), String> {
    let f = ref_h as f32 / screen_h as f32;
    let (_, y0, x1, y1) = card_area();
    let by = ((y0 as f32 / f).floor().max(0.0) as u32) & !1;
    let bw = (((x1 as f32 / f).ceil() as u32 + 1) & !1).min(screen_w & !1);
    let bh = ((((y1 as f32 / f).ceil() as u32).saturating_sub(by) + 1) & !1).min(screen_h.saturating_sub(by) & !1);
    if bw < 8 || bh < 8 {
        return Err("观战识别区域无效".into());
    }
    let aw = ((bw as f32 * f).round() as usize).max(8);
    let ah = ((bh as f32 * f).round() as usize).max(8);
    let eye_y = (EYE_Y as f32 - by as f32 * f).round() as i32;
    Ok((by, bw, bh, aw, ah, eye_y))
}

fn watch_spectate<G>(
    ffmpeg_path: &Path,
    monitor_index: u32,
    screen_w: u32,
    screen_h: u32,
    ref_h: u32,
    stop: Arc<AtomicBool>,
    on_spectate: G,
) -> Result<(Arc<Mutex<Child>>, JoinHandle<()>), String>
where
    G: Fn(bool, i64) + Send + 'static,
{
    let (by, bw, bh, aw, ah, eye_y) = card_geometry(screen_w, screen_h, ref_h)?;

    let mut child = grab(ffmpeg_path, monitor_index, SPEC_FPS, (0, by, bw, bh), (aw, ah), "bicubic")?;
    let mut out = child.stdout.take().ok_or("识别进程没有输出")?;
    let child = Arc::new(Mutex::new(child));
    let handle = thread::Builder::new()
        .name("spectate".into())
        .spawn(move || {
            let eye = bitmap("eye", &EYE);
            let lv = bitmap("lv", &LV);
            let mut frame = vec![0u8; aw * ah * 3];
            let mut open = false;
            let mut last_seen = 0i64;
            while !stop.load(Ordering::Relaxed) {
                if out.read_exact(&mut frame).is_err() {
                    break;
                }
                // the frame was taken up to half a frame ago
                let now_ms = crate::recorder::now_ms() - 250;
                let m = Mask::build(&frame, aw, ah, FEAT_WHITE);
                if card_visible(&m, &eye, &lv, eye_y) {
                    if !open {
                        open = true;
                        on_spectate(true, now_ms);
                    }
                    last_seen = now_ms;
                } else if open && now_ms - last_seen > SPEC_HOLD_MS {
                    open = false;
                    on_spectate(false, last_seen + 500);
                }
            }
            if open {
                on_spectate(false, last_seen + 500);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok((child, handle))
}

/// Start watching. `on_detect` is called from the reader thread.
pub fn start<F, G>(
    ffmpeg_path: &Path,
    monitor_index: u32,
    screen_w: u32,
    screen_h: u32,
    on_detect: F,
    on_spectate: G,
) -> Result<Detector, String>
where
    F: Fn(Detection) + Send + 'static,
    G: Fn(bool, i64) + Send + 'static,
{
    let pack = load_pack().ok_or("还没有识别样本")?;
    if screen_w == 0 || screen_h == 0 {
        return Err("还没有识别显示器分辨率".into());
    }
    // f: screen pixels -> analysis pixels (= reference pixels). The HUD scales with height.
    let f = pack.scale * pack.ref_h as f32 / screen_h as f32;
    let center = screen_w as f32 / 2.0;

    // one band covering every template, its search window and side regions (screen px)
    let mut x0 = f32::MAX;
    let mut y0 = f32::MAX;
    let mut x1 = f32::MIN;
    let mut y1 = f32::MIN;
    for t in &pack.templates {
        let (mut extra_l, mut extra_r) = match t.mode {
            MODE_COUNTER => (t.p0.min(0), t.p1.max(t.w as i32)),
            MODE_LINES => (0, t.w as i32 + t.p0),
            _ => (0, t.w as i32),
        };
        if let Some(c) = &t.confirm {
            extra_l = extra_l.min(c.cx - c.search_x);
            extra_r = extra_r.max(c.cx + c.w as i32 + c.search_x);
        }
        let left = (t.cx - t.search_x + extra_l) as f32 - 2.0;
        let right = (t.cx + t.search_x + extra_r) as f32 + 2.0;
        x0 = x0.min(center + left / f);
        x1 = x1.max(center + right / f);
        y0 = y0.min((t.y - t.search_y - 4) as f32 / f);
        y1 = y1.max((t.y + t.h as i32 + t.search_y + 4) as f32 / f);
    }
    let bx = (x0.max(0.0) as u32) & !1;
    let by = (y0.max(0.0) as u32) & !1;
    let bw = ((x1.min(screen_w as f32) as u32).saturating_sub(bx) + 1) & !1;
    let bh = ((y1.min(screen_h as f32) as u32).saturating_sub(by) + 1) & !1;
    if bw < 8 || bh < 8 {
        return Err("识别区域无效".into());
    }
    let aw = ((bw as f32 * f).round() as usize).max(8);
    let ah = ((bh as f32 * f).round() as usize).max(8);

    let mut child = grab(ffmpeg_path, monitor_index, FPS, (bx, by, bw, bh), (aw, ah), "area")?;
    let mut out = child.stdout.take().ok_or("识别进程没有输出")?;

    let placed: Vec<Placed> = pack
        .templates
        .iter()
        .map(|t| Placed {
            t: t.clone(),
            px: (t.cx as f32 - (bx as f32 - center) * f).round() as i32,
            py: (t.y as f32 - by as f32 * f).round() as i32,
        })
        .collect();
    let mut features: Vec<u32> = placed
        .iter()
        .flat_map(|p| std::iter::once(p.t.feature).chain(p.t.confirm.as_ref().map(|c| c.feature)))
        .collect();
    features.sort();
    features.dedup();

    let stop = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None));
    let child = Arc::new(Mutex::new(child));
    let handle = {
        let stop = stop.clone();
        let error = error.clone();
        thread::Builder::new()
            .name("detector".into())
            .spawn(move || {
                let mut frame = vec![0u8; aw * ah * 3];
                let mut tracks: Vec<Track> = placed.iter().map(|_| Track::default()).collect();
                while !stop.load(Ordering::Relaxed) {
                    if out.read_exact(&mut frame).is_err() {
                        if !stop.load(Ordering::Relaxed) {
                            if let Ok(mut e) = error.lock() {
                                *e = Some("识别进程退出了".into());
                            }
                        }
                        break;
                    }
                    let now_ms = crate::recorder::now_ms() - 80;
                    let masks: Vec<(u32, Mask)> = features
                        .iter()
                        .map(|&f| (f, Mask::build(&frame, aw, ah, f)))
                        .collect();
                    for (p, tr) in placed.iter().zip(tracks.iter_mut()) {
                        let Some((_, m)) = masks.iter().find(|(f, _)| *f == p.t.feature) else {
                            continue;
                        };
                        let cm = p.t.confirm.as_ref().and_then(|c| {
                            masks.iter().find(|(f, _)| *f == c.feature).map(|(_, m)| m)
                        });
                        for d in step(p, tr, m, cm, now_ms) {
                            on_detect(d);
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?
    };

    let mut children = vec![child];
    let mut handles = vec![handle];
    // the spectate card is a nice-to-have: without it, kills after the player's
    // own elimination are left out instead
    if let Ok((c, h)) = watch_spectate(ffmpeg_path, monitor_index, screen_w, screen_h, pack.ref_h, stop.clone(), on_spectate) {
        children.push(c);
        handles.push(h);
    }

    Ok(Detector {
        stop,
        children,
        handles,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(b: &[u8], p: &mut usize) -> usize {
        let (mut v, mut shift) = (0usize, 0);
        loop {
            let x = b[*p];
            *p += 1;
            v |= ((x & 0x7f) as usize) << shift;
            if x & 0x80 == 0 {
                return v;
            }
            shift += 7;
        }
    }

    /// The red mask around the kill counter, frame by frame (6 fps), cut from
    /// real recordings: "KCFX" | u16 w | u16 h | u32 frames | u16 x, y of the
    /// template's spot | per frame: run count, then alternating off / on runs.
    fn fixture(b: &[u8]) -> (i32, i32, Vec<Mask>) {
        assert_eq!(&b[..4], b"KCFX");
        let rd16 = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]) as usize;
        let (w, h) = (rd16(4), rd16(6));
        let n = u32::from_le_bytes([b[8], b[9], b[10], b[11]]) as usize;
        let (x, y) = (rd16(12) as i32, rd16(14) as i32);
        let mut p = 16;
        let mut frames = Vec::with_capacity(n);
        for _ in 0..n {
            let runs = varint(b, &mut p);
            let mut px = Vec::with_capacity(w * h);
            for r in 0..runs {
                let len = varint(b, &mut p);
                px.extend(std::iter::repeat((r % 2) as u8).take(len));
            }
            assert_eq!(px.len(), w * h);
            frames.push(Mask::from_px(w, h, px));
        }
        (x, y, frames)
    }

    fn kills(b: &[u8]) -> usize {
        let (x, y, frames) = fixture(b);
        let t = load_pack()
            .unwrap()
            .templates
            .into_iter()
            .find(|t| t.kind == "kill")
            .unwrap();
        let p = Placed { t, px: x, py: y };
        let mut tr = Track::default();
        frames
            .iter()
            .enumerate()
            .map(|(i, m)| step(&p, &mut tr, m, None, 1_000_000 + i as i64 * 1000 / 6).len())
            .sum()
    }

    // a team deathmatch played at 1920x1080 (read at the 1440p reference
    // size): the digits change thickness with what's behind them, pop in
    // with an animation and are sometimes hidden for a frame. The counter
    // went 1 -> 13 over these four clips, each kill counted once.
    #[test]
    fn counter_1080p_counts_every_kill_once() {
        assert_eq!(kills(include_bytes!("../detector/fixtures/tdm1080_a.rle")), 1);
        assert_eq!(kills(include_bytes!("../detector/fixtures/tdm1080_b.rle")), 3);
        assert_eq!(kills(include_bytes!("../detector/fixtures/tdm1080_c.rle")), 5);
        assert_eq!(kills(include_bytes!("../detector/fixtures/tdm1080_d.rle")), 4);
    }

    // a battle royale clip at 3440x1440 (native reference size) with 11 kills
    // in under a minute
    #[test]
    fn counter_1440p_counts_every_kill_once() {
        assert_eq!(kills(include_bytes!("../detector/fixtures/br1440.rle")), 11);
    }
}
