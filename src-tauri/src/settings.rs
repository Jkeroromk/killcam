use serde::{Deserialize, Serialize};
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
        }
    }
}

impl EventRules {
    pub fn get(&self, kind: &str) -> Option<&EventRule> {
        match kind {
            "kill" => Some(&self.kill),
            "knock" => Some(&self.knock),
            "death" => Some(&self.death),
            "knocked" => Some(&self.knocked),
            "win" => Some(&self.win),
            "manual" => Some(&self.manual),
            _ => None,
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
    /// "full" keeps the whole match video, "highlights" keeps only clips
    pub capture_mode: String,
    pub auto_record: bool,
    pub video: VideoSettings,
    pub audio: AudioSettings,
    pub events: EventRules,
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
            pubg: PubgSettings::default(),
            hotkeys: Hotkeys::default(),
            telemetry_offset_ms: 0,
            screen_detect: true,
            mini_window: true,
            launch_at_login: true,
        }
    }
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> Settings {
    let p = settings_path(config_dir);
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
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
