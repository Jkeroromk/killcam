//! PUBG developer API + telemetry parsing.

use serde_json::Value;
use std::time::Duration;

pub struct Api {
    key: String,
    shard: String,
    client: reqwest::blocking::Client,
}

#[derive(Debug, Clone)]
pub struct Participant {
    pub account_id: String,
    #[allow(dead_code)]
    pub name: String,
    pub kills: u32,
    pub dbnos: u32,
    pub damage: f64,
    pub win_place: u32,
    pub headshots: u32,
    pub longest_kill: f64,
}

#[derive(Debug, Clone)]
pub struct MatchInfo {
    pub id: String,
    pub created_at_ms: i64,
    pub duration_s: f64,
    pub map_name: String,
    pub game_mode: String,
    pub telemetry_url: Option<String>,
    pub participants: Vec<Participant>,
    pub teams: u32,
}

#[derive(Debug, Clone, Default)]
pub struct TEvent {
    pub kind: String,
    pub at_ms: i64,
    pub victim: Option<String>,
    pub weapon: Option<String>,
    pub distance_m: Option<f64>,
    pub headshot: bool,
    /// a kill credited to the player (they knocked them) but finished by someone
    /// else, often while they were already dead: it counts, but the screen shows
    /// the teammate, so it isn't a highlight of its own
    pub credited: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Summary {
    pub match_start_ms: Option<i64>,
    pub match_end_ms: Option<i64>,
    pub death_ms: Option<i64>,
    pub events: Vec<TEvent>,
}

pub fn parse_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn sv(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn uv(v: &Value, k: &str) -> u32 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) as u32
}

fn fv(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

impl Api {
    pub fn new(key: &str, shard: &str) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            key: key.trim().to_string(),
            shard: if shard.trim().is_empty() {
                "steam".into()
            } else {
                shard.trim().to_string()
            },
            client,
        }
    }

    fn get_api(&self, url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        let resp = self
            .client
            .get(url)
            .query(query)
            .header("Authorization", format!("Bearer {}", self.key))
            .header("Accept", "application/vnd.api+json")
            .send()
            .map_err(|e| format!("网络错误：{e}"))?;
        let status = resp.status().as_u16();
        match status {
            200 => resp.json::<Value>().map_err(|e| format!("解析失败：{e}")),
            401 => Err("API Key 无效（401）".into()),
            404 => Err("找不到这个玩家（404），检查游戏 ID 大小写和平台".into()),
            429 => Err("请求太频繁（429），稍后自动重试".into()),
            s => Err(format!("PUBG API 返回 {s}")),
        }
    }

    /// Returns (account id, recent match ids newest first)
    pub fn player(&self, name: &str) -> Result<(String, Vec<String>), String> {
        let url = format!("https://api.pubg.com/shards/{}/players", self.shard);
        let v = self.get_api(&url, &[("filter[playerNames]", name.trim())])?;
        let p = v
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .ok_or("找不到这个玩家")?;
        let id = sv(p, "id").ok_or("返回数据缺少玩家 ID")?;
        let matches = p
            .pointer("/relationships/matches/data")
            .and_then(|m| m.as_array())
            .map(|a| a.iter().filter_map(|m| sv(m, "id")).collect())
            .unwrap_or_default();
        Ok((id, matches))
    }

    pub fn match_info(&self, id: &str) -> Result<MatchInfo, String> {
        let url = format!("https://api.pubg.com/shards/{}/matches/{}", self.shard, id);
        let v = self.get_api(&url, &[])?;
        let attrs = v
            .pointer("/data/attributes")
            .cloned()
            .unwrap_or(Value::Null);
        let created = sv(&attrs, "createdAt")
            .and_then(|s| parse_time(&s))
            .unwrap_or(0);
        let mut info = MatchInfo {
            id: id.to_string(),
            created_at_ms: created,
            duration_s: fv(&attrs, "duration"),
            map_name: sv(&attrs, "mapName").unwrap_or_default(),
            game_mode: sv(&attrs, "gameMode").unwrap_or_default(),
            telemetry_url: None,
            participants: Vec::new(),
            teams: 0,
        };
        if let Some(inc) = v.get("included").and_then(|i| i.as_array()) {
            for item in inc {
                match item.get("type").and_then(|t| t.as_str()) {
                    Some("asset") => {
                        if let Some(u) = item.pointer("/attributes/URL").and_then(|u| u.as_str()) {
                            info.telemetry_url = Some(u.to_string());
                        }
                    }
                    Some("roster") => info.teams += 1,
                    Some("participant") => {
                        if let Some(st) = item.pointer("/attributes/stats") {
                            info.participants.push(Participant {
                                account_id: sv(st, "playerId").unwrap_or_default(),
                                name: sv(st, "name").unwrap_or_default(),
                                kills: uv(st, "kills"),
                                dbnos: uv(st, "DBNOs"),
                                damage: fv(st, "damageDealt"),
                                win_place: uv(st, "winPlace"),
                                headshots: uv(st, "headshotKills"),
                                longest_kill: fv(st, "longestKill"),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(info)
    }

    pub fn telemetry(&self, url: &str) -> Result<Vec<Value>, String> {
        let resp = self
            .client
            .get(url)
            .header("Accept-Encoding", "gzip")
            .send()
            .map_err(|e| format!("下载 telemetry 失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("telemetry 返回 {}", resp.status()));
        }
        let v: Value = resp
            .json()
            .map_err(|e| format!("解析 telemetry 失败：{e}"))?;
        match v {
            Value::Array(a) => Ok(a),
            _ => Err("telemetry 格式不对".into()),
        }
    }
}

fn acc(v: Option<&Value>) -> Option<&str> {
    v.and_then(|c| c.get("accountId")).and_then(|a| a.as_str())
}

fn name_of(v: Option<&Value>) -> Option<String> {
    v.and_then(|c| c.get("name"))
        .and_then(|a| a.as_str())
        .map(|s| s.to_string())
}

/// Pull my knocks / kills / deaths / win out of the telemetry.
pub fn summarize(events: &[Value], me: &str, won: bool) -> Summary {
    let mut s = Summary::default();
    for e in events {
        let Some(t) = e.get("_T").and_then(|t| t.as_str()) else {
            continue;
        };
        let at = match e.get("_D").and_then(|d| d.as_str()).and_then(parse_time) {
            Some(x) => x,
            None => continue,
        };
        match t {
            "LogMatchStart" => {
                if s.match_start_ms.is_none() {
                    s.match_start_ms = Some(at);
                }
            }
            "LogMatchEnd" => s.match_end_ms = Some(at),
            "LogPlayerMakeGroggy" => {
                let attacker = e.get("attacker");
                let victim = e.get("victim");
                let dist = e
                    .get("distance")
                    .and_then(|d| d.as_f64())
                    .map(|d| d / 100.0);
                let weapon = e
                    .get("damageCauserName")
                    .and_then(|w| w.as_str())
                    .map(weapon_name);
                if acc(attacker) == Some(me) && acc(victim) != Some(me) {
                    s.events.push(TEvent {
                        kind: "knock".into(),
                        at_ms: at,
                        victim: name_of(victim),
                        weapon,
                        distance_m: dist,
                        headshot: e.get("damageReason").and_then(|r| r.as_str())
                            == Some("HeadShot"),
                        credited: false,
                    });
                } else if acc(victim) == Some(me) {
                    s.events.push(TEvent {
                        kind: "knocked".into(),
                        at_ms: at,
                        victim: name_of(attacker),
                        weapon,
                        distance_m: dist,
                        headshot: false,
                        credited: false,
                    });
                }
            }
            "LogPlayerKillV2" | "LogPlayerKill" => {
                let killer = e.get("killer");
                let victim = e.get("victim");
                let info = e.get("killerDamageInfo");
                let weapon = info
                    .and_then(|i| i.get("damageCauserName"))
                    .or_else(|| e.get("damageCauserName"))
                    .and_then(|w| w.as_str())
                    .map(weapon_name);
                let dist = info
                    .and_then(|i| i.get("distance"))
                    .or_else(|| e.get("distance"))
                    .and_then(|d| d.as_f64())
                    .map(|d| d / 100.0);
                let reason = info
                    .and_then(|i| i.get("damageReason"))
                    .or_else(|| e.get("damageReason"))
                    .and_then(|r| r.as_str());
                if acc(killer) == Some(me) && acc(victim) != Some(me) {
                    let finisher = acc(e.get("finisher"));
                    s.events.push(TEvent {
                        kind: "kill".into(),
                        at_ms: at,
                        victim: name_of(victim),
                        weapon,
                        distance_m: dist,
                        headshot: reason == Some("HeadShot"),
                        credited: finisher.is_some() && finisher != Some(me),
                    });
                } else if acc(victim) == Some(me) {
                    let by = name_of(killer).or_else(|| name_of(e.get("finisher")));
                    // you can come back (recall / comeback): the game ends for you
                    // at the last death, not the first
                    s.death_ms = Some(s.death_ms.map_or(at, |d| d.max(at)));
                    s.events.push(TEvent {
                        kind: "death".into(),
                        at_ms: at,
                        victim: by,
                        weapon,
                        distance_m: dist,
                        headshot: false,
                        credited: false,
                    });
                }
            }
            _ => {}
        }
    }
    if won {
        if let Some(end) = s.match_end_ms {
            s.events.push(TEvent {
                kind: "win".into(),
                at_ms: end,
                victim: None,
                weapon: None,
                distance_m: None,
                headshot: false,
                credited: false,
            });
        }
    }
    s.events.sort_by_key(|e| e.at_ms);
    s
}

pub fn map_label(raw: &str) -> String {
    let m = match raw {
        "Baltic_Main" | "Erangel_Main" => "艾伦格",
        "Desert_Main" => "米拉玛",
        "Savage_Main" => "萨诺",
        "DihorOtok_Main" => "维寒迪",
        "Summerland_Main" => "卡拉金",
        "Chimera_Main" => "帕拉莫",
        "Heaven_Main" => "褐湾",
        "Tiger_Main" => "泰戈",
        "Kiki_Main" => "帝斯顿",
        "Neon_Main" => "荣都",
        "Range_Main" => "训练场",
        "" => "未知地图",
        other => return other.trim_end_matches("_Main").to_string(),
    };
    m.to_string()
}

pub fn weapon_name(raw: &str) -> String {
    let known = [
        ("WeapHK416_C", "M416"),
        ("WeapAK47_C", "AKM"),
        ("WeapBerylM762_C", "Beryl M762"),
        ("WeapSCAR-L_C", "SCAR-L"),
        ("WeapM16A4_C", "M16A4"),
        ("WeapAUG_C", "AUG"),
        ("WeapGroza_C", "Groza"),
        ("WeapQBZ95_C", "QBZ"),
        ("WeapACE32_C", "ACE32"),
        ("WeapMk47Mutant_C", "Mk47"),
        ("WeapG36C_C", "G36C"),
        ("WeapK2_C", "K2"),
        ("WeapFamasG2_C", "FAMAS"),
        ("WeapKar98k_C", "Kar98k"),
        ("WeapM24_C", "M24"),
        ("WeapAWM_C", "AWM"),
        ("WeapMosinNagant_C", "Mosin"),
        ("WeapWin94_C", "Win94"),
        ("WeapL6_C", "Lynx AMR"),
        ("WeapMini14_C", "Mini14"),
        ("WeapSKS_C", "SKS"),
        ("WeapSLR_C", "SLR"),
        ("WeapMk14_C", "Mk14"),
        ("WeapQBU88_C", "QBU"),
        ("WeapVSS_C", "VSS"),
        ("WeapMk12_C", "Mk12"),
        ("WeapDragunov_C", "Dragunov"),
        ("WeapUMP_C", "UMP45"),
        ("WeapUZI_C", "Micro UZI"),
        ("WeapVector_C", "Vector"),
        ("WeapThompson_C", "Tommy Gun"),
        ("WeapBizonPP19_C", "PP-19 Bizon"),
        ("WeapMP5K_C", "MP5K"),
        ("WeapP90_C", "P90"),
        ("WeapJS9_C", "JS9"),
        ("WeapMP9_C", "MP9"),
        ("WeapM249_C", "M249"),
        ("WeapDP28_C", "DP-28"),
        ("WeapMG3_C", "MG3"),
        ("WeapSaiga12_C", "S12K"),
        ("WeapBerreta686_C", "S686"),
        ("WeapWinchester_C", "S1897"),
        ("WeapDP12_C", "DBS"),
        ("WeapOriginS12_C", "O12"),
        ("WeapSawnoff_C", "短管霰弹"),
        ("WeapCrossbow_1_C", "十字弩"),
        ("WeapPanzerFaust100M1_C", "铁拳火箭筒"),
        ("WeapMortar_C", "迫击炮"),
        ("ProjGrenade_C", "手雷"),
        ("ProjMolotov_C", "燃烧瓶"),
        ("ProjStickyGrenade_C", "黏性炸弹"),
        ("WeapPan_C", "平底锅"),
        ("WeapG18_C", "P18C"),
        ("WeapM1911_C", "P1911"),
        ("WeapM9_C", "P92"),
        ("WeapNagantM1895_C", "R1895"),
        ("WeapRhino_C", "R45"),
        ("WeapDesertEagle_C", "Deagle"),
        ("WeapSkorpion_C", "蝎式手枪"),
        ("PlayerMale_A_C", "拳头"),
        ("PlayerFemale_A_C", "拳头"),
        ("BlueZoneBomb_EffectActor_C", "红区"),
        ("RedZoneBomb_C", "红区"),
    ];
    for (k, v) in known {
        if raw == k {
            return v.to_string();
        }
    }
    let low = raw.to_lowercase();
    if low.contains("bluezone") || raw == "None" {
        return "毒圈".into();
    }
    if raw.starts_with("BP_")
        || low.contains("vehicle")
        || low.contains("uaz")
        || low.contains("dacia")
    {
        return "载具".into();
    }
    raw.trim_start_matches("Weap")
        .trim_start_matches("Proj")
        .trim_end_matches("_C")
        .to_string()
}

pub fn mode_label(raw: &str) -> String {
    let r = raw.to_lowercase();
    // arcade modes the API also lists
    if r.starts_with("tdm") {
        return "团队死斗".into();
    }
    let team = if r.contains("squad") {
        "四排"
    } else if r.contains("duo") {
        "双排"
    } else if r.contains("solo") {
        "单排"
    } else {
        ""
    };
    let fpp = if r.contains("fpp") { " FPP" } else { "" };
    if team.is_empty() {
        raw.to_string()
    } else {
        format!("{team}{fpp}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_labels() {
        assert_eq!(mode_label("squad-fpp"), "四排 FPP");
        assert_eq!(mode_label("duo"), "双排");
        assert_eq!(mode_label("tdm"), "团队死斗");
    }
}
