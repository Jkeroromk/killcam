//! Detecting the supported games, and reading PUBG's display settings.

use serde::Serialize;
use std::path::PathBuf;
use sysinfo::{ProcessesToUpdate, System};

pub const GAME_EXE: &str = "TslGame.exe";

/// The games KillCam records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Game {
    Pubg,
    Lol,
}

impl Game {
    pub const ALL: [Game; 2] = [Game::Pubg, Game::Lol];

    /// stored in sessions and records
    pub fn id(self) -> &'static str {
        match self {
            Game::Pubg => "pubg",
            Game::Lol => "lol",
        }
    }

    pub fn from_id(id: &str) -> Game {
        match id {
            "lol" => Game::Lol,
            _ => Game::Pubg,
        }
    }

    /// the process that runs while a game (a match, for League) is on
    pub fn exe(self) -> &'static str {
        match self {
            Game::Pubg => GAME_EXE,
            Game::Lol => "League of Legends.exe",
        }
    }
}

pub struct Watcher {
    sys: System,
}

impl Watcher {
    pub fn new() -> Self {
        Self { sys: System::new() }
    }

    /// The running game among `games` (first one wins) and its pid.
    pub fn find(&mut self, games: &[Game]) -> Option<(Game, u32)> {
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        games.iter().find_map(|g| {
            self.sys
                .processes()
                .values()
                .find(|p| p.name().to_string_lossy().eq_ignore_ascii_case(g.exe()))
                .map(|p| (*g, p.pid().as_u32()))
        })
    }

    /// Folder of a running process's exe (e.g. where the League client keeps its lockfile).
    pub fn exe_dir(&mut self, exe: &str) -> Option<PathBuf> {
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        self.sys
            .processes()
            .values()
            .find(|p| p.name().to_string_lossy().eq_ignore_ascii_case(exe))
            .and_then(|p| p.exe())
            .and_then(|e| e.parent())
            .map(|d| d.to_path_buf())
    }

    /// CPU usage of one process in percent of the whole machine.
    pub fn cpu_of(&mut self, pid: u32) -> Option<f32> {
        let pid = sysinfo::Pid::from_u32(pid);
        self.sys
            .refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1) as f32;
        self.sys.process(pid).map(|p| p.cpu_usage() / cores)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub running: bool,
    pub pid: Option<u32>,
    pub config_found: bool,
    /// 0 fullscreen, 1 borderless, 2 windowed
    pub fullscreen_mode: Option<i32>,
    pub resolution: Option<String>,
    pub frame_limit: Option<String>,
}

fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(base)
            .join("TslGame")
            .join("Saved")
            .join("Config")
            .join("WindowsNoEditor")
            .join("GameUserSettings.ini"),
    )
}

pub fn info(pid: Option<u32>) -> GameInfo {
    let mut g = GameInfo {
        running: pid.is_some(),
        pid,
        config_found: false,
        fullscreen_mode: None,
        resolution: None,
        frame_limit: None,
    };
    let Some(p) = config_path() else { return g };
    let Ok(text) = std::fs::read_to_string(&p) else {
        return g;
    };
    g.config_found = true;
    let mut rx: Option<String> = None;
    let mut ry: Option<String> = None;
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "FullscreenMode" | "LastConfirmedFullscreenMode" => {
                if g.fullscreen_mode.is_none() {
                    g.fullscreen_mode = v.parse().ok();
                }
            }
            "ResolutionSizeX" => rx = Some(v.to_string()),
            "ResolutionSizeY" => ry = Some(v.to_string()),
            "FrameRateLimit" => g.frame_limit = Some(v.to_string()),
            _ => {}
        }
    }
    if let (Some(x), Some(y)) = (rx, ry) {
        g.resolution = Some(format!("{x}×{y}"));
    }
    g
}
