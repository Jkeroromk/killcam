//! Short confirmation sounds (F9 marker), played by Windows itself.
//!
//! They come from KillCam's own process, so with the default "record the
//! game's sound only" setting they don't end up in the recording.

use std::sync::OnceLock;

const RATE: u32 = 44_100;

/// (frequency Hz, length ms); 0 Hz = silence
fn wav(notes: &[(f32, u32)]) -> Vec<u8> {
    let mut samples: Vec<i16> = Vec::new();
    for &(freq, ms) in notes {
        let n = (RATE * ms / 1000) as usize;
        let ramp = (RATE as usize * 6 / 1000).max(1); // 6 ms fade in / out, no clicks
        for i in 0..n {
            let v = if freq <= 0.0 {
                0.0
            } else {
                let env = (i.min(n - 1 - i) as f32 / ramp as f32).min(1.0);
                (2.0 * std::f32::consts::PI * freq * i as f32 / RATE as f32).sin() * 0.28 * env
            };
            samples.push((v * i16::MAX as f32) as i16);
        }
    }
    let data_len = (samples.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&RATE.to_le_bytes());
    b.extend_from_slice(&(RATE * 2).to_le_bytes()); // byte rate
    b.extend_from_slice(&2u16.to_le_bytes()); // block align
    b.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

/// Two quick rising notes: "marked".
fn marked() -> &'static [u8] {
    static W: OnceLock<Vec<u8>> = OnceLock::new();
    W.get_or_init(|| wav(&[(880.0, 60), (0.0, 25), (1320.0, 90)]))
}

/// One low note: "not recording, nothing marked".
fn refused() -> &'static [u8] {
    static W: OnceLock<Vec<u8>> = OnceLock::new();
    W.get_or_init(|| wav(&[(330.0, 140)]))
}

#[cfg(windows)]
fn play(bytes: &'static [u8]) {
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    // SND_MEMORY + SND_ASYNC: the buffer must outlive the sound, hence 'static
    unsafe {
        PlaySoundW(
            bytes.as_ptr() as *const u16,
            std::ptr::null_mut(),
            SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
        );
    }
}

#[cfg(not(windows))]
fn play(_bytes: &'static [u8]) {}

pub fn marker(ok: bool) {
    play(if ok { marked() } else { refused() });
}

#[cfg(test)]
mod tests {
    #[test]
    fn wav_header_is_consistent() {
        let w = super::wav(&[(440.0, 10)]);
        assert_eq!(&w[0..4], b"RIFF");
        let riff = u32::from_le_bytes([w[4], w[5], w[6], w[7]]) as usize;
        assert_eq!(riff + 8, w.len());
    }
}
