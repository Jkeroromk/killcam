//! The games' own icons, taken from their installed files (the exe, or the
//! icon Riot keeps for its shortcuts), saved as PNG for the game switch.

use crate::game::Game;
use std::fs;
use std::path::{Path, PathBuf};

pub fn icon_path(dir: &Path, game: Game) -> PathBuf {
    dir.join(format!("{}.png", game.id()))
}

/// Saved icons, extracting the missing ones from what's installed.
/// `running`: exe of a game that runs right now (the surest source).
pub fn ensure(dir: &Path, running: Option<(Game, PathBuf)>) -> Vec<(Game, PathBuf)> {
    let _ = fs::create_dir_all(dir);
    let mut out = Vec::new();
    for g in Game::ALL {
        let png = icon_path(dir, g);
        if !png.exists() {
            let mut sources: Vec<PathBuf> = Vec::new();
            if let Some((rg, exe)) = &running {
                if *rg == g {
                    sources.push(exe.clone());
                }
            }
            sources.extend(installed(g));
            for src in sources.into_iter().filter(|p| p.exists()) {
                if let Some((w, h, rgba)) = extract(&src, 256) {
                    if fs::write(&png, encode_png(w, h, &rgba)).is_ok() {
                        break;
                    }
                }
            }
        }
        if png.exists() {
            out.push((g, png));
        }
    }
    out
}

/// Where the game usually is when it isn't running.
fn installed(g: Game) -> Vec<PathBuf> {
    match g {
        Game::Lol => {
            let mut v = vec![
                PathBuf::from(r"C:\ProgramData\Riot Games\Metadata\league_of_legends.live\league_of_legends.live.ico"),
                PathBuf::from(r"C:\Riot Games\League of Legends\LeagueClient.exe"),
            ];
            for d in ["D", "E", "F"] {
                v.push(PathBuf::from(format!(r"{d}:\Riot Games\League of Legends\LeagueClient.exe")));
            }
            v
        }
        Game::Pubg => steam_libraries()
            .into_iter()
            .map(|lib| lib.join(r"steamapps\common\PUBG\TslGame\Binaries\Win64\TslGame.exe"))
            .collect(),
    }
}

/// Steam library folders (paths listed in libraryfolders.vdf).
fn steam_libraries() -> Vec<PathBuf> {
    let root = PathBuf::from(r"C:\Program Files (x86)\Steam");
    let mut libs = vec![root.clone()];
    if let Ok(vdf) = fs::read_to_string(root.join(r"steamapps\libraryfolders.vdf")) {
        if let Ok(re) = regex::Regex::new(r#""path"\s+"([^"]+)""#) {
            for c in re.captures_iter(&vdf) {
                let p = PathBuf::from(c[1].replace(r"\\", r"\"));
                if !libs.contains(&p) {
                    libs.push(p);
                }
            }
        }
    }
    libs
}

#[cfg(windows)]
fn extract(path: &Path, size: i32) -> Option<(u32, u32, Vec<u8>)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, GetIconInfo, PrivateExtractIconsW, ICONINFO,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let mut icon = std::mem::zeroed();
        let mut id: u32 = 0;
        let n = PrivateExtractIconsW(wide.as_ptr(), 0, size, size, &mut icon, &mut id, 1, 0);
        if n == 0 || n == u32::MAX || icon as usize == 0 {
            return None;
        }
        let mut info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(icon, &mut info) == 0 {
            DestroyIcon(icon);
            return None;
        }
        let mut result = None;
        let mut bm: BITMAP = std::mem::zeroed();
        if info.hbmColor as usize != 0
            && GetObjectW(
                info.hbmColor as _,
                std::mem::size_of::<BITMAP>() as i32,
                &mut bm as *mut BITMAP as *mut _,
            ) != 0
            && bm.bmWidth > 0
            && bm.bmHeight > 0
        {
            let (w, h) = (bm.bmWidth as u32, bm.bmHeight as u32);
            let mut bmi: BITMAPINFO = std::mem::zeroed();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w as i32;
            bmi.bmiHeader.biHeight = -(h as i32); // top-down rows
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB as _;
            let mut px = vec![0u8; (w * h * 4) as usize];
            let dc = CreateCompatibleDC(std::mem::zeroed());
            let lines = GetDIBits(
                dc,
                info.hbmColor,
                0,
                h,
                px.as_mut_ptr() as *mut _,
                &mut bmi,
                DIB_RGB_COLORS,
            );
            DeleteDC(dc);
            if lines as u32 == h {
                // BGRA -> RGBA; icons without an alpha channel are fully opaque
                let no_alpha = px.chunks_exact(4).all(|p| p[3] == 0);
                for p in px.chunks_exact_mut(4) {
                    p.swap(0, 2);
                    if no_alpha {
                        p[3] = 255;
                    }
                }
                result = Some((w, h, px));
            }
        }
        if info.hbmColor as usize != 0 {
            DeleteObject(info.hbmColor as _);
        }
        if info.hbmMask as usize != 0 {
            DeleteObject(info.hbmMask as _);
        }
        DestroyIcon(icon);
        result
    }
}

#[cfg(not(windows))]
fn extract(_path: &Path, _size: i32) -> Option<(u32, u32, Vec<u8>)> {
    None
}

// ---------------------------------------------------------------------------
// a minimal PNG writer (stored deflate blocks: icons are small)

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, t) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *t = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(4 + data.len());
    body.extend_from_slice(kind);
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
}

pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let row = (w * 4) as usize;
    let mut raw = Vec::with_capacity((row + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0); // filter: none
        raw.extend_from_slice(&rgba[y * row..(y + 1) * row]);
    }
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, b) in blocks.iter().enumerate() {
        z.push(if i + 1 == blocks.len() { 1 } else { 0 });
        let len = b.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(b);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_header_and_crc() {
        let png = encode_png(1, 1, &[255, 0, 0, 255]);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
    }
}
