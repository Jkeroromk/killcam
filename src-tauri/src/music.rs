//! The background music for an edit: tempo, beats, drum hits and where the
//! song kicks in (the "drop"), so cuts and kills can land on the music.
//!
//! The song is decoded by ffmpeg to mono samples; everything else is plain
//! signal work on a 10 ms grid: bass and treble energy, their rises (onsets),
//! tempo by autocorrelation, then a beat grid fitted to the onsets.

use crate::ffmpeg;
use crate::i18n::tr;
use serde::Serialize;
use std::path::Path;

const RATE: f64 = 11_025.0;
/// analysis step: 10 ms
const HOP: usize = 110;
const STEP: f64 = HOP as f64 / RATE;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MusicInfo {
    pub duration: f64,
    pub bpm: f64,
    /// seconds per beat
    pub beat: f64,
    pub beats: Vec<f64>,
    /// first beat of each bar (4/4)
    pub downbeats: Vec<f64>,
    /// drum hits and other sharp sounds: (time, strength 0..1)
    pub onsets: Vec<(f64, f32)>,
    /// loudness of each beat, 0..1
    pub energy: Vec<f32>,
    /// where the song kicks in hardest
    pub drop: f64,
}

/// Decode a song to mono samples at RATE.
fn decode(ff: &Path, file: &Path) -> Result<Vec<f32>, String> {
    let args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-i"]
        .iter()
        .map(|s| s.to_string())
        .chain([file.to_string_lossy().to_string()])
        .chain(["-vn", "-ac", "1", "-ar", "11025", "-f", "f32le", "pipe:1"].iter().map(|s| s.to_string()))
        .collect();
    let out = ffmpeg::run(ff, &args, ffmpeg::BELOW_NORMAL_PRIORITY_CLASS)?;
    if !out.status.success() || out.stdout.len() < 4 * 11_025 * 5 {
        return Err(tr(
            format!("读不了这首歌：{}", ffmpeg::tail(&String::from_utf8_lossy(&out.stderr), 3)),
            format!("Couldn't read this song: {}", ffmpeg::tail(&String::from_utf8_lossy(&out.stderr), 3)),
        ));
    }
    Ok(out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

pub fn analyze_file(ff: &Path, file: &Path) -> Result<MusicInfo, String> {
    let s = decode(ff, file)?;
    Ok(analyze(&s))
}

fn db(x: f64) -> f64 {
    10.0 * (x + 1e-10).log10()
}

/// The analysis on raw samples (mono, RATE).
pub fn analyze(samples: &[f32]) -> MusicInfo {
    let duration = samples.len() as f64 / RATE;
    // bass (under ~150 Hz) and the rest, from a one-pole low-pass
    let a = (-2.0 * std::f64::consts::PI * 150.0 / RATE).exp();
    let mut lp = 0.0f64;
    let n = samples.len() / HOP;
    let mut low = vec![0.0f64; n];
    let mut high = vec![0.0f64; n];
    for f in 0..n {
        let (mut el, mut eh) = (0.0, 0.0);
        for &x in &samples[f * HOP..(f + 1) * HOP] {
            let x = x as f64;
            lp = a * lp + (1.0 - a) * x;
            el += lp * lp;
            eh += (x - lp) * (x - lp);
        }
        low[f] = db(el / HOP as f64);
        high[f] = db(eh / HOP as f64);
    }
    // onset strength: how sharply bass and treble get louder
    let mut on = vec![0.0f64; n];
    for f in 1..n {
        on[f] = (low[f] - low[f - 1]).max(0.0) + 0.5 * (high[f] - high[f - 1]).max(0.0);
    }
    let on: Vec<f64> = (0..n)
        .map(|f| (on[f.saturating_sub(1)] + on[f] + on[(f + 1).min(n.saturating_sub(1))]) / 3.0)
        .collect();

    // tempo: the lag where the onsets repeat best, leaning towards 100-150 BPM
    let mean = on.iter().sum::<f64>() / n.max(1) as f64;
    let x: Vec<f64> = on.iter().map(|v| v - mean).collect();
    let (lo, hi) = ((0.3 / STEP) as usize, (1.0 / STEP) as usize);
    let mut best = (0.0f64, 50usize);
    for lag in lo..=hi.min(n.saturating_sub(1)) {
        let mut acc = 0.0;
        for i in lag..n {
            acc += x[i] * x[i - lag];
        }
        let bpm = 60.0 / (lag as f64 * STEP);
        let w = (-((bpm / 125.0).log2().powi(2)) / (2.0 * 0.5f64.powi(2))).exp();
        let score = acc * w;
        if score > best.0 {
            best = (score, lag);
        }
    }
    // the beat grid: period (refined below a frame: a song has hundreds of
    // beats, so 1 ms off per beat drifts a lot) and offset whose beats sit on
    // the most onset
    let at = |t: f64| -> f64 {
        let i = (t / STEP).round() as isize;
        (-2..=2)
            .map(|d| i + d)
            .filter(|&j| j >= 0 && (j as usize) < n)
            .map(|j| on[j as usize])
            .fold(0.0, f64::max)
    };
    let coarse = best.1 as f64 * STEP;
    let mut phase = (0.0f64, 0.0f64);
    let mut beat = coarse;
    let mut per = coarse - 1.2 * STEP;
    while per <= coarse + 1.2 * STEP {
        let mut p = 0.0;
        while p < per {
            let mut sc = 0.0;
            let mut t = p;
            while t < duration {
                sc += at(t);
                t += per;
            }
            if sc > phase.0 {
                phase = (sc, p);
                beat = per;
            }
            p += STEP / 2.0;
        }
        per += STEP / 20.0;
    }
    // then the offset exactly, without the tolerance used to find the period
    let exact = |t: f64| -> f64 {
        let i = (t / STEP).round() as usize;
        if i < n {
            on[i]
        } else {
            0.0
        }
    };
    let mut fine = (f64::MIN, phase.1);
    for d in -4..=4 {
        let p = phase.1 + d as f64 * STEP / 2.0;
        if p < 0.0 {
            continue;
        }
        let mut sc = 0.0;
        let mut t = p;
        while t < duration {
            sc += exact(t);
            t += beat;
        }
        if sc > fine.0 {
            fine = (sc, p);
        }
    }
    phase.1 = fine.1;
    let bpm = 60.0 / beat;
    let mut beats = Vec::new();
    let mut t = phase.1;
    while t < duration - 0.05 {
        beats.push((t * 1000.0).round() / 1000.0);
        t += beat;
    }

    // bars: the beat of four with the heaviest bass hits starts them
    let bass_on = |t: f64| -> f64 {
        let i = (t / STEP).round() as isize;
        (-2..=2)
            .map(|d| i + d)
            .filter(|&j| j >= 1 && (j as usize) < n)
            .map(|j| (low[j as usize] - low[j as usize - 1]).max(0.0))
            .fold(0.0, f64::max)
    };
    let mut bar = (0.0f64, 0usize);
    for k in 0..4 {
        let sc: f64 = beats.iter().skip(k).step_by(4).map(|&t| bass_on(t)).sum();
        if sc > bar.0 {
            bar = (sc, k);
        }
    }
    let downbeats: Vec<f64> = beats.iter().skip(bar.1).step_by(4).copied().collect();

    // loudness per beat
    let full: Vec<f64> = (0..n).map(|f| db(10f64.powf(low[f] / 10.0) + 10f64.powf(high[f] / 10.0))).collect();
    let mut energy: Vec<f64> = beats
        .iter()
        .map(|&t| {
            let a = (t / STEP) as usize;
            let b = (((t + beat) / STEP) as usize).min(n);
            if b > a {
                full[a..b].iter().sum::<f64>() / (b - a) as f64
            } else {
                -100.0
            }
        })
        .collect();
    let (emin, emax) = energy.iter().fold((f64::MAX, f64::MIN), |(a, b), &v| (a.min(v), b.max(v)));
    for e in energy.iter_mut() {
        *e = if emax > emin { (*e - emin) / (emax - emin) } else { 0.5 };
    }

    // the drop: the bar where the next 8 beats get loudest compared with the 8 before
    let mut drop = (f64::MIN, beats.first().copied().unwrap_or(0.0));
    for (bi, &t) in beats.iter().enumerate() {
        if bi % 4 != bar.1 || t < 6.0 || t > duration - 12.0 || bi < 8 || bi + 8 > energy.len() {
            continue;
        }
        let after: f64 = energy[bi..bi + 8].iter().sum::<f64>() / 8.0;
        let before: f64 = energy[bi - 8..bi].iter().sum::<f64>() / 8.0;
        let sc = after - before + 0.3 * after;
        if sc > drop.0 {
            drop = (sc, t);
        }
    }

    // drum hits: local peaks clearly above their surroundings
    let mut onsets = Vec::new();
    let omax = on.iter().cloned().fold(0.0, f64::max).max(1e-9);
    let w = 25;
    for f in 1..n.saturating_sub(1) {
        if on[f] < on[f - 1] || on[f] < on[f + 1] {
            continue;
        }
        let a = f.saturating_sub(w);
        let b = (f + w).min(n);
        let mut win: Vec<f64> = on[a..b].to_vec();
        win.sort_by(|x, y| x.total_cmp(y));
        let med = win[win.len() / 2];
        if on[f] > med * 2.5 + omax * 0.08 {
            let t = f as f64 * STEP;
            if onsets.last().map(|&(p, _): &(f64, f32)| t - p < 0.1).unwrap_or(false) {
                continue;
            }
            onsets.push(((t * 1000.0).round() / 1000.0, (on[f] / omax) as f32));
        }
    }

    MusicInfo {
        duration,
        bpm: (bpm * 10.0).round() / 10.0,
        beat,
        beats,
        downbeats,
        onsets,
        energy: energy.into_iter().map(|e| e as f32).collect(),
        drop: drop.1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 128 BPM track: kick on every beat, quiet for 16 bars-ish, then loud.
    fn track() -> Vec<f32> {
        let beat = 60.0 / 128.0;
        let len = 60.0;
        let n = (len * RATE) as usize;
        let mut s = vec![0.0f32; n];
        let offset = 0.2;
        let mut k = 0;
        loop {
            let t0 = offset + k as f64 * beat;
            if t0 >= len {
                break;
            }
            let loud = if t0 >= 30.0 { 1.0 } else { 0.25 };
            // the first beat of every bar a bit heavier
            let accent = if k % 4 == 0 { 1.0 } else { 0.6 };
            let start = (t0 * RATE) as usize;
            for i in 0..(0.15 * RATE) as usize {
                if start + i >= n {
                    break;
                }
                let t = i as f64 / RATE;
                s[start + i] += (loud * accent * (2.0 * std::f64::consts::PI * 60.0 * t).sin() * (-t * 25.0).exp()) as f32;
            }
            // hats in between
            let h = ((t0 + beat / 2.0) * RATE) as usize;
            for i in 0..200 {
                if h + i < n {
                    s[h + i] += (loud * 0.2 * (((i * 7919) % 13) as f64 / 6.0 - 1.0)) as f32;
                }
            }
            k += 1;
        }
        s
    }

    #[test]
    fn finds_tempo_beats_and_drop() {
        let m = analyze(&track());
        assert!((m.bpm - 128.0).abs() < 2.0, "bpm {}", m.bpm);
        // beats line up with the kicks (0.2 s + k * 0.469)
        let beat = 60.0 / 128.0;
        let off = ((m.beats[3] - 0.2) / beat).fract();
        assert!(off < 0.06 || off > 0.94, "beat phase {}", m.beats[3]);
        // the bars start on the accented kick
        let k = ((m.downbeats[2] - 0.2) / beat).round() as i64;
        assert_eq!(k % 4, 0, "downbeat {}", m.downbeats[2]);
        // the loud part starts at 30 s
        assert!((m.drop - 30.0).abs() < 2.0, "drop {}", m.drop);
        assert!(m.onsets.len() > 50);
    }
}
