use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoSettings {
    /// ddagrab output index (which monitor)
    pub monitor_index: u32,
    pub monitor_width: u32,
    pub monitor_height: u32,
    /// "performance" | "balanced" | "quality" | "custom"
    pub preset: String,
    /// output height in pixels (720 / 1080 / 1440 ...). 0 = native
    pub height: u32,
    pub fps: u32,
    pub bitrate_mbps: u32,
    /// ffmpeg encoder id, e.g. h264_nvenc / hevc_nvenc / av1_nvenc / h264_amf
    pub encoder: String,
    /// "native" keeps the full ultrawide frame, "16:9" crops the center
    pub aspect: String,
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            monitor_index: 0,
            monitor_width: 0,
            monitor_height: 0,
            preset: "balanced".into(),
            height: 1080,
            fps: 60,
            bitrate_mbps: 20,
            encoder: "h264_nvenc".into(),
            aspect: "native".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    /// "process" (only the game) | "system" (everything you hear) | "off"
    pub game_source: String,
    pub game_volume: f32,
    pub mic_enabled: bool,
    /// WASAPI device id, None = system default
    pub mic_device_id: Option<String>,
    /// output device to loop back when game_source == "system", None = default
    pub system_device_id: Option<String>,
    pub mic_volume: f32,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            game_source: "process".into(),
            game_volume: 1.0,
            mic_enabled: true,
            mic_device_id: None,
            system_device_id: None,
            mic_volume: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventRule {
    pub enabled: bool,
    pub pre: f64,
    pub post: f64,
}

impl Default for EventRule {
    fn default() -> Self {
        Self {
            enabled: true,
            pre: 8.0,
            post: 3.0,
        }
    }
}

fn rule(enabled: bool, pre: f64, post: f64) -> EventRule {
    EventRule { enabled, pre, post }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventRules {
    pub kill: EventRule,
    pub knock: EventRule,
    pub death: EventRule,
    pub knocked: EventRule,
    pub win: EventRule,
    pub manual: EventRule,
    /// League of Legends: kills you helped with
    pub assist: EventRule,
    /// League of Legends: dragons, heralds, barons, towers you took part in
    pub objective: EventRule,
}

impl Default for EventRules {
    fn default() -> Self {
        Self {
            kill: rule(true, 8.0, 3.0),
            knock: rule(true, 6.0, 3.0),
            death: rule(true, 10.0, 3.0),
            knocked: rule(false, 6.0, 3.0),
            win: rule(true, 15.0, 10.0),
            manual: rule(true, 20.0, 5.0),
            assist: rule(false, 8.0, 3.0),
            objective: rule(true, 10.0, 4.0),
        }
    }
}

impl EventRules {
    /// League of Legends: a win is the nexus going down, no knocks
    pub fn lol() -> Self {
        Self {
            kill: rule(true, 8.0, 3.0),
            knock: rule(false, 6.0, 3.0),
            death: rule(true, 10.0, 3.0),
            knocked: rule(false, 6.0, 3.0),
            win: rule(true, 15.0, 6.0),
            manual: rule(true, 20.0, 5.0),
            assist: rule(false, 8.0, 3.0),
            objective: rule(true, 10.0, 4.0),
        }
    }

    pub fn get(&self, kind: &str) -> Option<&EventRule> {
        match kind {
            "kill" => Some(&self.kill),
            "knock" => Some(&self.knock),
            "death" => Some(&self.death),
            "knocked" => Some(&self.knocked),
            "win" => Some(&self.win),
            "manual" => Some(&self.manual),
            "assist" => Some(&self.assist),
            "objective" => Some(&self.objective),
            _ => None,
        }
    }
}

/// Everything that is set per game.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameSettings {
    /// start recording when the game starts
    pub enabled: bool,
    /// "full" keeps the whole match video, "highlights" keeps only clips
    pub capture_mode: String,
    pub rules: EventRules,
}

impl Default for GameSettings {
    fn default() -> Self {
        Self::for_game(crate::game::Game::Pubg)
    }
}

impl GameSettings {
    pub fn for_game(g: crate::game::Game) -> Self {
        use crate::game::Game;
        match g {
            Game::Pubg => Self {
                enabled: true,
                capture_mode: "full".into(),
                rules: EventRules::default(),
            },
            // League's own data is exact: the clips are what matter
            Game::Lol => Self {
                enabled: true,
                capture_mode: "highlights".into(),
                rules: EventRules::lol(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PubgSettings {
    pub player_name: String,
    pub api_key: String,
    pub shard: String,
    /// cached account id for player_name
    pub account_id: Option<String>,
}

impl Default for PubgSettings {
    fn default() -> Self {
        Self {
            player_name: String::new(),
            api_key: String::new(),
            shard: "steam".into(),
            account_id: None,
        }
    }
}

impl PubgSettings {
    pub fn configured(&self) -> bool {
        !self.player_name.trim().is_empty() && !self.api_key.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub highlight: String,
    pub toggle_record: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            highlight: "F9".into(),
            toggle_record: "Shift+F9".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub onboarded: bool,
    /// explicit ffmpeg.exe path, otherwise bundled / PATH
    pub ffmpeg_path: Option<String>,
    pub library_dir: String,
    pub storage_limit_gb: u32,
    /// before per-game settings: PUBG's save mode (read once, then moved to game_settings)
    #[serde(skip_serializing)]
    pub capture_mode: String,
    pub auto_record: bool,
    pub video: VideoSettings,
    pub audio: AudioSettings,
    /// before per-game settings: PUBG's highlight rules (moved to game_settings)
    #[serde(skip_serializing)]
    pub events: EventRules,
    /// game id -> its settings (see Settings::game)
    pub game_settings: BTreeMap<String, GameSettings>,
    pub pubg: PubgSettings,
    pub hotkeys: Hotkeys,
    /// shift applied to telemetry timestamps when placing them on the video
    pub telemetry_offset_ms: i64,
    /// real-time screen reading of kill / knock / death / win prompts
    pub screen_detect: bool,
    /// while the game runs: minimize the main window and show the mini status window
    pub mini_window: bool,
    /// start with Windows, hidden in the tray
    pub launch_at_login: bool,
    /// short sound when F9 marks a highlight (a low one when nothing is recording)
    pub marker_sound: bool,
    /// "auto" (the Windows display language), "zh" or "en"
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            onboarded: false,
            ffmpeg_path: None,
            library_dir: String::new(),
            storage_limit_gb: 200,
            capture_mode: "full".into(),
            auto_record: true,
            video: VideoSettings::default(),
            audio: AudioSettings::default(),
            events: EventRules::default(),
            game_settings: crate::game::Game::ALL
                .into_iter()
                .map(|g| (g.id().to_string(), GameSettings::for_game(g)))
                .collect(),
            pubg: PubgSettings::default(),
            hotkeys: Hotkeys::default(),
            telemetry_offset_ms: 0,
            screen_detect: true,
            mini_window: true,
            launch_at_login: true,
            marker_sound: true,
            language: "auto".into(),
        }
    }
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

impl Settings {
    /// One game's settings (its defaults if missing).
    pub fn game(&self, g: crate::game::Game) -> GameSettings {
        self.game_settings
            .get(g.id())
            .cloned()
            .unwrap_or_else(|| GameSettings::for_game(g))
    }

    /// Games that start a recording by themselves.
    pub fn enabled_games(&self) -> Vec<crate::game::Game> {
        crate::game::Game::ALL
            .into_iter()
            .filter(|g| self.game(*g).enabled)
            .collect()
    }

    /// Fill in games missing from game_settings. PUBG takes over the settings
    /// from before there were several games.
    pub fn migrate(&mut self, legacy: bool) {
        use crate::game::Game;
        for g in Game::ALL {
            if self.game_settings.contains_key(g.id()) {
                continue;
            }
            let mut gs = GameSettings::for_game(g);
            if g == Game::Pubg && legacy {
                gs.rules = self.events.clone();
                if self.capture_mode == "full" || self.capture_mode == "highlights" {
                    gs.capture_mode = self.capture_mode.clone();
                }
            }
            self.game_settings.insert(g.id().to_string(), gs);
        }
    }
}

pub fn load(config_dir: &Path) -> Settings {
    let p = settings_path(config_dir);
    match fs::read_to_string(&p) {
        Ok(txt) => match serde_json::from_str::<Settings>(&txt) {
            Ok(mut s) => {
                // a file without per-game settings is from before them
                let legacy = !txt.contains("\"gameSettings\"");
                if legacy {
                    s.game_settings.clear();
                }
                s.migrate(legacy);
                s
            }
            Err(_) => Settings::default(),
        },
        Err(_) => Settings::default(),
    }
}

pub fn save(config_dir: &Path, s: &Settings) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let p = settings_path(config_dir);
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Game;

    #[test]
    fn old_settings_keep_pubg_rules_and_save_mode() {
        let old = r#"{"onboarded":true,"captureMode":"highlights","events":{"kill":{"enabled":false,"pre":5,"post":2}}}"#;
        let dir = std::env::temp_dir().join(format!("kc_set_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(settings_path(&dir), old).unwrap();
        let s = load(&dir);
        let pubg = s.game(Game::Pubg);
        assert_eq!(pubg.capture_mode, "highlights");
        assert!(!pubg.rules.kill.enabled);
        assert_eq!(pubg.rules.kill.pre, 5.0);
        assert!(pubg.rules.knock.enabled);
        assert_eq!(s.game(Game::Lol).capture_mode, "highlights");
        assert_eq!(s.enabled_games(), vec![Game::Pubg, Game::Lol]);
        // saved without the old fields, loads back the same
        save(&dir, &s).unwrap();
        let txt = std::fs::read_to_string(settings_path(&dir)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
        assert!(v.get("captureMode").is_none() && v.get("events").is_none());
        assert!(v["gameSettings"]["pubg"].is_object());
        let again = load(&dir);
        assert_eq!(again.game(Game::Pubg).rules.kill.pre, 5.0);
        assert_eq!(again.game(Game::Pubg).capture_mode, "highlights");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
