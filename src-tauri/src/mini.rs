//! The small always-on-top status window shown while the game runs.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "mini";
const W: f64 = 300.0;
const H: f64 = 108.0;
const MARGIN: f64 = 24.0;

fn pos_file(config_dir: &Path) -> PathBuf {
    config_dir.join("mini.json")
}

fn load_pos(config_dir: &Path) -> Option<(i32, i32)> {
    let s = fs::read_to_string(pos_file(config_dir)).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_pos(config_dir: &Path, p: (i32, i32)) {
    if let Ok(s) = serde_json::to_string(&p) {
        let _ = fs::write(pos_file(config_dir), s);
    }
}

/// A spot for the window: on another monitor than the recorded one if there is
/// one (top-right corner), otherwise the recorded monitor's top-left corner.
fn default_pos(app: &AppHandle, game_size: (u32, u32)) -> Option<(i32, i32)> {
    let mons = app.available_monitors().ok()?;
    if mons.is_empty() {
        return None;
    }
    let is_game =
        |m: &tauri::Monitor| m.size().width == game_size.0 && m.size().height == game_size.1;
    let primary = app.primary_monitor().ok().flatten();
    let others: Vec<&tauri::Monitor> = mons.iter().filter(|m| !is_game(*m)).collect();
    let pick_other = others
        .iter()
        .find(|m| {
            primary
                .as_ref()
                .map(|p| p.position() == m.position())
                .unwrap_or(false)
        })
        .or_else(|| others.first())
        .copied();
    if let Some(m) = pick_other {
        let s = m.scale_factor();
        let x = m.position().x + m.size().width as i32 - ((W + MARGIN) * s) as i32;
        let y = m.position().y + (MARGIN * s) as i32;
        return Some((x, y));
    }
    let m = mons.iter().find(|m| is_game(*m)).unwrap_or(&mons[0]);
    let s = m.scale_factor();
    Some((
        m.position().x + (MARGIN * s) as i32,
        m.position().y + (MARGIN * s) as i32,
    ))
}

/// Saved position, if it is still on a connected monitor.
fn saved_pos(app: &AppHandle, config_dir: &Path) -> Option<(i32, i32)> {
    let (x, y) = load_pos(config_dir)?;
    let mons = app.available_monitors().ok()?;
    let visible = mons.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x - 40
            && y >= p.y - 10
            && x < p.x + s.width as i32 - 60
            && y < p.y + s.height as i32 - 40
    });
    visible.then_some((x, y))
}

pub fn open(app: &AppHandle, config_dir: &Path, game_size: (u32, u32)) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("KillCam")
        .inner_size(W, H)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // don't pull focus away from the game when it pops up
        .focused(false)
        // keeps it out of screen captures, including our own recording
        .content_protected(true)
        .background_color(tauri::window::Color(11, 11, 11, 255));
    if let Some((x, y)) = saved_pos(app, config_dir).or_else(|| default_pos(app, game_size)) {
        // the builder takes logical coordinates of the monitor the point lands on
        let scale = app
            .available_monitors()
            .ok()
            .and_then(|ms| {
                ms.into_iter().find(|m| {
                    let p = m.position();
                    let s = m.size();
                    x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
                })
            })
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        b = b.position(x as f64 / scale, y as f64 / scale);
    }
    b.build().map_err(|e| e.to_string())?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.minimize();
    }
    Ok(())
}

/// Close the mini window (remembering where it was) and bring the main window back.
pub fn close(app: &AppHandle, config_dir: &Path, restore_main: bool) {
    if let Some(w) = app.get_webview_window(LABEL) {
        if let Ok(p) = w.outer_position() {
            save_pos(config_dir, (p.x, p.y));
        }
        let _ = w.destroy();
    }
    if restore_main {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }
}
