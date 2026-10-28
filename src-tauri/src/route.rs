//! A PUBG match on the map: where the player landed and ran, and where each
//! knock, kill and death happened, from the match's telemetry (fetched once,
//! then cached). The map images are PUBG's own (github.com/pubg/api-assets),
//! downloaded the first time a map is shown.

use crate::i18n::tr;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A spot on the map: `x` / `y` from 0 to 1 (left / top to right / bottom).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Spot {
    /// wall clock (unix ms)
    pub ms: i64,
    pub x: f32,
    pub y: f32,
}

/// knock | kill | knocked | death, with the other player and the weapon
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Mark {
    pub kind: String,
    pub at: Spot,
    pub other: Option<String>,
    pub weapon: Option<String>,
    pub distance_m: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Route {
    pub map_name: String,
    pub landing: Option<Spot>,
    /// on foot / in a vehicle after landing, about every 10 seconds
    pub path: Vec<Spot>,
    pub marks: Vec<Mark>,
}

/// Map side length in centimeters (telemetry units).
pub fn map_size_cm(map: &str) -> Option<f64> {
    Some(match map {
        "Baltic_Main" | "Erangel_Main" | "Desert_Main" | "DihorOtok_Main" | "Kiki_Main" | "Tiger_Main" | "Neon_Main" => 816_000.0,
        "Savage_Main" => 408_000.0,
        "Chimera_Main" => 306_000.0,
        "Summerland_Main" | "Range_Main" => 204_000.0,
        "Heaven_Main" => 102_000.0,
        _ => return None,
    })
}

/// File name of the map image in pubg/api-assets.
fn map_asset(map: &str) -> Option<&'static str> {
    Some(match map {
        "Baltic_Main" | "Erangel_Main" => "Erangel_Main_Low_Res.png",
        "Desert_Main" => "Miramar_Main_Low_Res.png",
        "DihorOtok_Main" => "Vikendi_Main_Low_Res.png",
        "Kiki_Main" => "Deston_Main_Low_Res.png",
        "Tiger_Main" => "Taego_Main_Low_Res.png",
        // the labelled Rondo image there is an empty placeholder
        "Neon_Main" => "Rondo_Main_No_Text_Low_Res.png",
        "Savage_Main" => "Sanhok_Main_Low_Res.png",
        "Chimera_Main" => "Paramo_Main_Low_Res.png",
        "Summerland_Main" => "Karakin_Main_Low_Res.png",
        "Heaven_Main" => "Haven_Main_Low_Res.png",
        "Range_Main" => "Camp_Jackal_Main_Low_Res.png",
        _ => return None,
    })
}

/// The map image, downloaded once into `dir`.
pub fn map_image(dir: &Path, map: &str) -> Option<PathBuf> {
    let file = map_asset(map)?;
    let path = dir.join(file);
    if path.exists() {
        return Some(path);
    }
    let c = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().ok()?;
    let r = c
        .get(format!("https://raw.githubusercontent.com/pubg/api-assets/master/Assets/Maps/{file}"))
        .send()
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let bytes = r.bytes().ok()?;
    if bytes.len() < 10_000 {
        return None;
    }
    fs::create_dir_all(dir).ok()?;
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, &bytes).ok()?;
    fs::rename(&tmp, &path).ok()?;
    Some(path)
}

/// The sharp map: PUBG's 8192 px image (about 100 MB, downloaded once per
/// map) scaled to 4096 px. None until it's there.
pub fn map_hd_cached(dir: &Path, map: &str) -> Option<PathBuf> {
    let file = map_asset(map)?;
    let p = dir.join(file.replace("_Low_Res.png", "_4k.jpg"));
    p.exists().then_some(p)
}

pub fn map_hd(dir: &Path, ff: &Path, map: &str) -> Result<PathBuf, String> {
    if let Some(p) = map_hd_cached(dir, map) {
        return Ok(p);
    }
    let file = map_asset(map).ok_or_else(|| tr("这张地图还不支持", "This map isn't supported yet"))?;
    let high = file.replace("_Low_Res", "_High_Res");
    let out = dir.join(file.replace("_Low_Res.png", "_4k.jpg"));
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let png = dir.join(format!("{high}.download"));
    let c = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    // the large images are stored with Git LFS
    let mut r = c
        .get(format!("https://media.githubusercontent.com/media/pubg/api-assets/master/Assets/Maps/{high}"))
        .send()
        .map_err(|e| tr(format!("高清地图下载失败：{e}"), format!("Couldn't download the sharp map: {e}")))?;
    if !r.status().is_success() {
        return Err(tr(format!("高清地图下载失败（{}）", r.status()), format!("Couldn't download the sharp map ({})", r.status())));
    }
    let res = (|| -> Result<(), String> {
        let mut f = fs::File::create(&png).map_err(|e| e.to_string())?;
        r.copy_to(&mut f).map_err(|e| e.to_string())?;
        drop(f);
        let tmp = dir.join(format!("{}.tmp.jpg", file));
        let args: Vec<String> = [
            "-hide_banner", "-loglevel", "error", "-y", "-f", "png_pipe", "-i",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain([png.to_string_lossy().to_string()])
        .chain(["-vf", "scale=4096:4096:flags=lanczos", "-q:v", "3", "-frames:v", "1"].iter().map(|s| s.to_string()))
        .chain([tmp.to_string_lossy().to_string()])
        .collect();
        crate::ffmpeg::run_ok(ff, &args, crate::ffmpeg::BELOW_NORMAL_PRIORITY_CLASS)?;
        fs::rename(&tmp, &out).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&png);
    res.map(|_| out)
}

fn acc(v: Option<&Value>) -> Option<&str> {
    v.and_then(|c| c.get("accountId")).and_then(|a| a.as_str())
}

fn name(v: Option<&Value>) -> Option<String> {
    v.and_then(|c| c.get("name")).and_then(|a| a.as_str()).map(|s| s.to_string())
}

fn spot(v: Option<&Value>, ms: i64, size: f64) -> Option<Spot> {
    let l = v?.get("location")?;
    let x = l.get("x")?.as_f64()?;
    let y = l.get("y")?.as_f64()?;
    // (0, 0) = no position (e.g. killed by the zone with nobody near)
    if x == 0.0 && y == 0.0 {
        return None;
    }
    Some(Spot {
        ms,
        x: (x / size).clamp(0.0, 1.0) as f32,
        y: (y / size).clamp(0.0, 1.0) as f32,
    })
}

/// The player's route and moments out of a match's telemetry.
pub fn from_telemetry(events: &[Value], me: &str, map: &str) -> Result<Route, String> {
    let size = map_size_cm(map).ok_or_else(|| tr("这张地图还不支持", "This map isn't supported yet"))?;
    let mut r = Route {
        map_name: map.to_string(),
        ..Default::default()
    };
    for e in events {
        let Some(t) = e.get("_T").and_then(|t| t.as_str()) else {
            continue;
        };
        let Some(ms) = e.get("_D").and_then(|d| d.as_str()).and_then(crate::pubg::parse_time) else {
            continue;
        };
        match t {
            "LogParachuteLanding" if acc(e.get("character")) == Some(me) => {
                if r.landing.is_none() {
                    r.landing = spot(e.get("character"), ms, size);
                }
            }
            "LogPlayerPosition" if acc(e.get("character")) == Some(me) => {
                // before landing it is the starting island and the plane
                if r.landing.is_some() {
                    if let Some(s) = spot(e.get("character"), ms, size) {
                        r.path.push(s);
                    }
                }
            }
            "LogPlayerMakeGroggy" => {
                let (a, v) = (e.get("attacker"), e.get("victim"));
                let weapon = e.get("damageCauserName").and_then(|w| w.as_str()).map(crate::pubg::weapon_name);
                let distance_m = e.get("distance").and_then(|d| d.as_f64()).map(|d| d / 100.0);
                if acc(a) == Some(me) && acc(v) != Some(me) {
                    if let Some(at) = spot(v, ms, size) {
                        r.marks.push(Mark { kind: "knock".into(), at, other: name(v), weapon, distance_m });
                    }
                } else if acc(v) == Some(me) {
                    if let Some(at) = spot(v, ms, size) {
                        r.marks.push(Mark { kind: "knocked".into(), at, other: name(a), weapon, distance_m });
                    }
                }
            }
            "LogPlayerKillV2" | "LogPlayerKill" => {
                let (k, v) = (e.get("killer"), e.get("victim"));
                let info = e.get("killerDamageInfo");
                let weapon = info
                    .and_then(|i| i.get("damageCauserName"))
                    .or_else(|| e.get("damageCauserName"))
                    .and_then(|w| w.as_str())
                    .map(crate::pubg::weapon_name);
                let distance_m = info
                    .and_then(|i| i.get("distance"))
                    .or_else(|| e.get("distance"))
                    .and_then(|d| d.as_f64())
                    .map(|d| d / 100.0);
                if acc(k) == Some(me) && acc(v) != Some(me) {
                    if let Some(at) = spot(v, ms, size) {
                        r.marks.push(Mark { kind: "kill".into(), at, other: name(v), weapon, distance_m });
                    }
                } else if acc(v) == Some(me) {
                    let by = name(k).or_else(|| name(e.get("finisher")));
                    if let Some(at) = spot(v, ms, size) {
                        r.marks.push(Mark { kind: "death".into(), at, other: by, weapon, distance_m });
                    }
                }
            }
            _ => {}
        }
    }
    // after the last death there is nothing of the player's own to draw
    if let Some(last) = r.marks.iter().filter(|m| m.kind == "death").map(|m| m.at.ms).max() {
        r.path.retain(|s| s.ms <= last);
    }
    Ok(r)
}

pub fn cache_path(dir: &Path, match_id: &str) -> PathBuf {
    let safe: String = match_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    dir.join(format!("{safe}.json"))
}

pub fn load_cached(dir: &Path, match_id: &str) -> Option<Route> {
    serde_json::from_str(&fs::read_to_string(cache_path(dir, match_id)).ok()?).ok()
}

pub fn save_cached(dir: &Path, match_id: &str, r: &Route) {
    if fs::create_dir_all(dir).is_ok() {
        if let Ok(j) = serde_json::to_string(r) {
            let _ = fs::write(cache_path(dir, match_id), j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn route_from_telemetry() {
        let me = "account.me";
        let pos = |d: &str, x: f64, y: f64| json!({"_T": "LogPlayerPosition", "_D": d, "character": {"accountId": me, "location": {"x": x, "y": y, "z": 0}}});
        let tele = vec![
            // on the plane: not part of the route
            pos("2026-10-22T21:17:00.000Z", 100_000.0, 100_000.0),
            json!({"_T": "LogParachuteLanding", "_D": "2026-10-22T21:18:00.000Z", "character": {"accountId": me, "location": {"x": 408_000.0, "y": 204_000.0, "z": 0}}}),
            pos("2026-10-22T21:18:10.000Z", 408_000.0, 204_000.0),
            json!({"_T": "LogPlayerMakeGroggy", "_D": "2026-10-22T21:21:36.000Z", "attacker": {"accountId": me, "name": "me"}, "victim": {"accountId": "b", "name": "ishashiskie", "location": {"x": 816_000.0, "y": 0.0}}, "damageCauserName": "WeapSLR_C", "distance": 5000.0}),
            json!({"_T": "LogPlayerKillV2", "_D": "2026-10-22T21:32:36.000Z", "killer": {"accountId": "c", "name": "SEEN"}, "victim": {"accountId": me, "name": "me", "location": {"x": 204_000.0, "y": 612_000.0}}}),
            pos("2026-10-22T21:33:00.000Z", 1.0, 1.0),
        ];
        let r = from_telemetry(&tele, me, "Tiger_Main").unwrap();
        assert_eq!(r.landing.as_ref().map(|s| (s.x, s.y)), Some((0.5, 0.25)));
        // the plane point before landing and the one after death are left out
        assert_eq!(r.path.len(), 1);
        let kinds: Vec<&str> = r.marks.iter().map(|m| m.kind.as_str()).collect();
        assert_eq!(kinds, vec!["knock", "death"]);
        assert_eq!(r.marks[0].other.as_deref(), Some("ishashiskie"));
        assert_eq!(r.marks[0].distance_m, Some(50.0));
        assert_eq!((r.marks[1].at.x, r.marks[1].at.y), (0.25, 0.75));
        assert_eq!(r.marks[1].other.as_deref(), Some("SEEN"));
        assert!(from_telemetry(&tele, me, "Unknown_Main").is_err());
    }
}
