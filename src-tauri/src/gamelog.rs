//! PUBG's own log (`%LOCALAPPDATA%\TslGame\Saved\Logs`). Almost everything in it
//! is encrypted, but every time the client joins a game server it writes a
//! plain line with the mode:
//!
//! `[2026.10.02-17.59.43:133][238][bdcc]UTslGameInstance::JoinToDedicatedServer() [GameModeAliase=TDM]`
//!
//! That marks where one game ends and the next begins, also for arcade,
//! custom and training games that PUBG's API knows nothing about.
//!
//! Leaving a game (back to the lobby) leaves a plain line too, a few seconds
//! after the player quits the match:
//!
//! `[2026.10.04-03.35.17:...][...][...]Command not recognized: Stat DumpHitches -stop`

use regex::Regex;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Join {
    /// UTC wall clock, ms
    pub at_ms: i64,
    /// GameModeAliase, e.g. BATTLEROYALE, TDM, MOD
    pub mode: String,
}

impl Join {
    /// Official modes show up in PUBG's API (normal and ranked battle royale).
    pub fn official(&self) -> bool {
        self.mode == "BATTLEROYALE"
    }

    /// Modes whose games show up in PUBG's API as well: KillCam waits for
    /// their match data before a record is final.
    pub fn in_api(&self) -> bool {
        self.official() || self.mode == "TDM"
    }

    /// (map label, mode label) for games without API data.
    pub fn labels(&self) -> (String, String) {
        let m = self.mode.as_str();
        let (map, mode) = match m {
            "TDM" => ("街机", "团队死斗"),
            "MOD" => ("自定义", ""),
            "BATTLEROYALE" => ("自定义 / 训练", ""),
            _ if m.contains("TRAIN") => ("训练场", ""),
            _ => ("街机", ""),
        };
        (map.to_string(), mode.to_string())
    }
}

fn logs_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(base)
            .join("TslGame")
            .join("Saved")
            .join("Logs"),
    )
}

fn stamp_ms(c: &regex::Captures) -> Option<i64> {
    let n = |i: usize| {
        c.get(i)
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .unwrap_or(0)
    };
    let date = chrono::NaiveDate::from_ymd_opt(n(1) as i32, n(2), n(3))?;
    let dt = date.and_hms_milli_opt(n(4), n(5), n(6), n(7))?;
    Some(dt.and_utc().timestamp_millis())
}

const STAMP: &str = r"^\W*\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]";

fn parse(text: &str, re: &Regex, from_ms: i64, to_ms: i64, out: &mut Vec<Join>) {
    for line in text.lines() {
        if !line.contains("JoinToDedicatedServer") {
            continue;
        }
        let Some(c) = re.captures(line) else { continue };
        let Some(at_ms) = stamp_ms(&c) else { continue };
        if at_ms >= from_ms && at_ms <= to_ms {
            out.push(Join {
                at_ms,
                mode: c.get(8).map(|m| m.as_str().to_string()).unwrap_or_default(),
            });
        }
    }
}

fn parse_leaves(text: &str, re: &Regex, from_ms: i64, to_ms: i64, out: &mut Vec<i64>) {
    for line in text.lines() {
        if !line.contains("DumpHitches -stop") {
            continue;
        }
        let Some(c) = re.captures(line) else { continue };
        if let Some(at_ms) = stamp_ms(&c) {
            if at_ms >= from_ms && at_ms <= to_ms {
                out.push(at_ms);
            }
        }
    }
}

/// The text of PUBG's logs written since `from_ms` (the running game keeps
/// TslGame.log open; reading it is still allowed).
fn recent_logs(from_ms: i64) -> Vec<String> {
    let Some(dir) = logs_dir() else {
        return Vec::new();
    };
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let newer_than = std::time::UNIX_EPOCH
        + std::time::Duration::from_millis(from_ms.max(0) as u64)
        - std::time::Duration::from_secs(60);
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with("TslGame") && name.ends_with(".log")) {
            continue;
        }
        let fresh = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t >= newer_than)
            .unwrap_or(true);
        if fresh {
            if let Ok(bytes) = fs::read(e.path()) {
                out.push(String::from_utf8_lossy(&bytes).to_string());
            }
        }
    }
    out
}

/// Times (UTC ms) the player left a game for the lobby, oldest first.
pub fn leaves(from_ms: i64, to_ms: i64) -> Vec<i64> {
    let Ok(re) = Regex::new(STAMP) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for text in recent_logs(from_ms) {
        parse_leaves(&text, &re, from_ms, to_ms, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

/// Server joins between `from_ms` and `to_ms`, oldest first. Empty when the log
/// can't be read (the session is then handled as one piece, like before).
pub fn joins(from_ms: i64, to_ms: i64) -> Vec<Join> {
    let Ok(re) = Regex::new(&format!(
        r"{STAMP}.*JoinToDedicatedServer\(\)\s*\[GameModeAliase=([A-Za-z0-9_]+)\]"
    )) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for text in recent_logs(from_ms) {
        parse(&text, &re, from_ms, to_ms, &mut out);
    }
    out.sort_by_key(|j| j.at_ms);
    out.dedup_by_key(|j| j.at_ms);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_join_lines() {
        let re = Regex::new(
            r"^\W*\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\].*JoinToDedicatedServer\(\)\s*\[GameModeAliase=([A-Za-z0-9_]+)\]",
        )
        .unwrap();
        let text = "\u{feff}[2026.10.02-17.57.22:575][  0][0000]Log file open\n[2026.10.02-17.59.43:133][238][bdcc]UTslGameInstance::JoinToDedicatedServer() [GameModeAliase=TDM]\n";
        let mut out = Vec::new();
        parse(text, &re, 0, i64::MAX, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].mode, "TDM");
        assert_eq!(out[0].at_ms, 1790963983133);
    }

    #[test]
    fn parses_leave_lines() {
        let re = Regex::new(STAMP).unwrap();
        let text = "[2026.10.04-03.35.17:120][  9][3690]Command not recognized: Stat DumpHitches -stop\n[2026.10.04-03.35.56:025][418][3690]UTslGameInstance::JoinToDedicatedServer() [GameModeAliase=BATTLEROYALE]\n";
        let mut out = Vec::new();
        parse_leaves(text, &re, 0, i64::MAX, &mut out);
        assert_eq!(out, vec![1791084917120]);
    }
}
