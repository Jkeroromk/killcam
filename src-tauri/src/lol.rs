//! League of Legends, read from the game's own local data: no screen reading,
//! no API key.
//!
//! * While a match runs, the game serves the Live Client Data API on
//!   https://127.0.0.1:2999/liveclientdata/ (self-signed certificate): every
//!   event with its game time (kills, multikills, dragons, barons, towers,
//!   the end), the players and their scores.
//! * After the match the League client (LCU, address and password in its
//!   `lockfile`) has the end-of-game stats: damage, gold, queue.
//!
//! The watcher writes both next to the session (lol.json, lol_eog.json); the
//! library turns them into a record once the match is over.

use crate::recorder::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub const LIVE_FILE: &str = "lol.json";
pub const EOG_FILE: &str = "lol_eog.json";
const LIVE: &str = "https://127.0.0.1:2999/liveclientdata";

/// What the watcher saw during one match.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveLog {
    /// wall clock (unix ms) of game time 0
    pub game_start_ms: Option<i64>,
    /// the player as the game names them (Riot ID, game name, summoner name)
    pub me: Vec<String>,
    /// raw events, each with "atMs" (wall clock) added
    pub events: Vec<Value>,
    /// latest allgamedata without its events (players, scores, mode)
    pub snapshot: Option<Value>,
    /// the watcher has finished (end-of-game stats fetched or given up)
    pub done: bool,
}

impl LiveLog {
    pub fn load(dir: &Path) -> Option<LiveLog> {
        let s = fs::read_to_string(dir.join(LIVE_FILE)).ok()?;
        serde_json::from_str(&s).ok()
    }

    fn save(&self, dir: &Path) {
        if let Ok(s) = serde_json::to_string(self) {
            let tmp = dir.join(format!("{LIVE_FILE}.tmp"));
            if fs::write(&tmp, s).is_ok() {
                let _ = fs::rename(&tmp, dir.join(LIVE_FILE));
            }
        }
    }
}

/// Kills / deaths / assists so far, for the mini window.
#[derive(Debug, Clone, Copy, Default)]
pub struct Score {
    pub kills: usize,
    pub deaths: usize,
    pub assists: usize,
}

fn client(timeout: Duration) -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        // both the game and the client use a self-signed certificate
        .danger_accept_invalid_certs(true)
        .timeout(timeout)
        .build()
        .ok()
}

fn get(c: &reqwest::blocking::Client, url: &str) -> Option<Value> {
    let r = c.get(url).send().ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json::<Value>().ok()
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn names_of(p: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for k in ["riotId", "riotIdGameName", "summonerName"] {
        let n = s(p, k);
        if !n.is_empty() {
            if let Some((game_name, _)) = n.split_once('#') {
                out.push(game_name.to_string());
            }
            out.push(n);
        }
    }
    out.dedup();
    out
}

/// Is `name` (as it appears in an event) one of `me`?
pub fn is_me(me: &[String], name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let bare = name.split_once('#').map(|(a, _)| a).unwrap_or(name);
    me.iter()
        .any(|m| m.eq_ignore_ascii_case(name) || m.eq_ignore_ascii_case(bare))
}

/// Follow one match. Runs until the game stops answering (or `stop` is set and
/// it never answered), then fetches the end-of-game stats from the client and
/// calls `on_done`. `league_dir` is the League install folder (lockfile).
pub fn watch<S, D>(
    dir: PathBuf,
    league_dir: Option<PathBuf>,
    stop: Arc<AtomicBool>,
    on_score: S,
    on_done: D,
) where
    S: Fn(Score) + Send + 'static,
    D: FnOnce() + Send + 'static,
{
    thread::spawn(move || {
        let Some(c) = client(Duration::from_secs(2)) else {
            return;
        };
        let mut log = LiveLog::load(&dir).unwrap_or_default();
        log.done = false;
        let mut seen_api = false;
        let mut misses = 0u32;
        let mut last_id: i64 = log
            .events
            .iter()
            .filter_map(|e| e.get("EventID").and_then(|x| x.as_i64()))
            .max()
            .unwrap_or(-1);
        let mut n = 0u64;
        let mut score = Score::default();
        loop {
            n += 1;
            let mut dirty = false;
            // game time -> wall clock: the smallest (now - game time) seen is the
            // one with the least request delay in it
            let sent = now_ms();
            let stats = get(&c, &format!("{LIVE}/gamestats"));
            if let Some(gt) = stats.as_ref().and_then(|v| v.get("gameTime")).and_then(|x| x.as_f64()) {
                if gt > 0.0 {
                    let est = sent - (gt * 1000.0) as i64;
                    if log.game_start_ms.map(|g| est < g).unwrap_or(true) {
                        log.game_start_ms = Some(est);
                        dirty = true;
                    }
                }
            }
            if stats.is_some() {
                seen_api = true;
                misses = 0;
            } else {
                misses += 1;
            }
            // who the player is, the scoreboard: every few seconds
            if stats.is_some() && (log.me.is_empty() || n % 5 == 0) {
                if let Some(mut all) = get(&c, &format!("{LIVE}/allgamedata")) {
                    if let Some(ap) = all.get("activePlayer") {
                        let me = names_of(ap);
                        if !me.is_empty() {
                            log.me = me;
                        }
                    }
                    if let Some(o) = all.as_object_mut() {
                        o.remove("events");
                        o.remove("activePlayer");
                    }
                    log.snapshot = Some(all);
                    dirty = true;
                }
            }
            if stats.is_some() {
                if let Some(ev) = get(&c, &format!("{LIVE}/eventdata")) {
                    let list = ev.get("Events").and_then(|x| x.as_array()).cloned().unwrap_or_default();
                    for mut e in list {
                        let id = e.get("EventID").and_then(|x| x.as_i64()).unwrap_or(-1);
                        if id <= last_id {
                            continue;
                        }
                        last_id = id;
                        let t = e.get("EventTime").and_then(|x| x.as_f64()).unwrap_or(0.0);
                        let at = log.game_start_ms.map(|g| g + (t * 1000.0) as i64).unwrap_or_else(now_ms);
                        if let Some(o) = e.as_object_mut() {
                            o.insert("atMs".into(), Value::from(at));
                        }
                        log.events.push(e);
                        dirty = true;
                    }
                }
                if dirty && !log.me.is_empty() {
                    let mut sc = Score::default();
                    for e in &log.events {
                        if s(e, "EventName") != "ChampionKill" {
                            continue;
                        }
                        if is_me(&log.me, &s(e, "KillerName")) {
                            sc.kills += 1;
                        }
                        if is_me(&log.me, &s(e, "VictimName")) {
                            sc.deaths += 1;
                        }
                        if assisters(e).iter().any(|a| is_me(&log.me, a)) {
                            sc.assists += 1;
                        }
                    }
                    if sc.kills != score.kills || sc.deaths != score.deaths || sc.assists != score.assists {
                        score = sc;
                        on_score(sc);
                    }
                }
            }
            if dirty {
                log.save(&dir);
            }
            // the match is over when the game stops answering; a recording that
            // stopped before the game ever answered has nothing to wait for
            if (seen_api && misses >= 8) || (!seen_api && stop.load(Ordering::Relaxed)) {
                break;
            }
            // never answered for 10 minutes (e.g. watching a replay): give up
            if !seen_api && n > 600 {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }

        if seen_api {
            if let Some(eog) = end_of_game(league_dir.as_deref()) {
                if let Ok(txt) = serde_json::to_string(&eog) {
                    let _ = fs::write(dir.join(EOG_FILE), txt);
                }
            }
        }
        log.done = true;
        log.save(&dir);
        on_done();
    });
}

/// The League install folder of a running game or client (the lockfile is there).
pub fn league_dir(game_exe_dir: Option<PathBuf>) -> Option<PathBuf> {
    // the game runs from <League>\Game, the client from <League>
    let mut cands = Vec::new();
    if let Some(d) = game_exe_dir {
        if let Some(p) = d.parent() {
            cands.push(p.to_path_buf());
        }
        cands.push(d);
    }
    cands.push(PathBuf::from(r"C:\Riot Games\League of Legends"));
    cands.into_iter().find(|d| d.join("lockfile").exists() || d.join("LeagueClient.exe").exists())
}

/// End-of-game stats from the League client, for up to two minutes after the match.
fn end_of_game(league_dir: Option<&Path>) -> Option<Value> {
    let c = client(Duration::from_secs(5))?;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(120) {
        if let Some((port, pass)) = league_dir.and_then(read_lockfile) {
            let url = format!("https://127.0.0.1:{port}/lol-end-of-game/v1/eog-stats-block");
            if let Ok(r) = c.get(&url).basic_auth("riot", Some(pass)).send() {
                if r.status().is_success() {
                    if let Ok(v) = r.json::<Value>() {
                        if v.get("teams").is_some() || v.get("localPlayer").is_some() {
                            return Some(v);
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_secs(3));
    }
    None
}

/// lockfile: "LeagueClient:<pid>:<port>:<password>:https"
fn read_lockfile(dir: &Path) -> Option<(u16, String)> {
    let txt = fs::read_to_string(dir.join("lockfile")).ok()?;
    let parts: Vec<&str> = txt.trim().split(':').collect();
    if parts.len() < 4 {
        return None;
    }
    Some((parts[2].parse().ok()?, parts[3].to_string()))
}

fn assisters(e: &Value) -> Vec<String> {
    e.get("Assisters")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// turning a match into events and stats

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LolPlayer {
    pub name: String,
    pub champion: String,
    /// Data Dragon key (e.g. "MonkeyKing"), for the icon
    pub champion_key: String,
    /// ORDER (blue) | CHAOS (red)
    pub team: String,
    pub level: u32,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub cs: u32,
    pub damage: Option<u64>,
    pub gold: Option<u64>,
    pub me: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LolStats {
    pub champion: String,
    pub champion_key: String,
    pub level: u32,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub cs: u32,
    pub vision: f64,
    pub gold: Option<u64>,
    pub damage: Option<u64>,
    pub win: Option<bool>,
    /// e.g. 单双排位, 极地大乱斗
    pub queue: String,
    /// biggest multikill (2 = double ... 5 = penta)
    pub best_multikill: u32,
    /// game time of the match (seconds)
    pub game_length_s: f64,
    pub players: Vec<LolPlayer>,
}

/// One of the player's moments, on the wall clock.
#[derive(Debug, Clone)]
pub struct Moment {
    /// kill | death | assist | objective | win
    pub kind: &'static str,
    pub at_ms: i64,
    /// champion killed / killed by, or the objective's name
    pub victim: Option<String>,
    /// 双杀 / 一血 / 抢龙 ...
    pub detail: Option<String>,
}

pub struct Summary {
    pub moments: Vec<Moment>,
    pub stats: LolStats,
    /// (map label, mode label)
    pub labels: (String, String),
    pub game_start_ms: Option<i64>,
    pub game_end_ms: Option<i64>,
}

fn multikill_label(n: i64) -> Option<&'static str> {
    match n {
        2 => Some("双杀"),
        3 => Some("三杀"),
        4 => Some("四杀"),
        n if n >= 5 => Some("五杀"),
        _ => None,
    }
}

fn dragon_label(t: &str) -> String {
    match t {
        "Fire" => "炼狱亚龙",
        "Water" => "海洋亚龙",
        "Earth" => "山脉亚龙",
        "Air" => "云端亚龙",
        "Hextech" => "海克斯亚龙",
        "Chemtech" => "炼金亚龙",
        "Elder" => "远古巨龙",
        _ => "小龙",
    }
    .into()
}

fn objective_label(e: &Value) -> Option<String> {
    Some(match s(e, "EventName").as_str() {
        "DragonKill" => dragon_label(&s(e, "DragonType")),
        "HeraldKill" => "峡谷先锋".into(),
        "BaronKill" => "纳什男爵".into(),
        "HordeKill" => "虚空巢虫".into(),
        "AtakhanKill" => "阿塔坎".into(),
        _ => return None,
    })
}

/// Queue (from the client) or game mode (from the game) as a label.
pub fn mode_label(queue_type: &str, game_mode: &str) -> String {
    let q = queue_type.to_ascii_uppercase();
    let label = if q.contains("RANKED_SOLO") {
        "单双排位"
    } else if q.contains("RANKED_FLEX") {
        "灵活排位"
    } else if q.contains("ARAM") {
        "极地大乱斗"
    } else if q.contains("URF") {
        "无限火力"
    } else if q.contains("CHERRY") {
        "斗魂竞技场"
    } else if q.contains("BOT") {
        "人机对战"
    } else if q.contains("NORMAL") || q.contains("DRAFT") || q.contains("BLIND") || q.contains("QUICKPLAY") {
        "匹配"
    } else {
        match game_mode.to_ascii_uppercase().as_str() {
            "ARAM" => "极地大乱斗",
            "URF" | "ARURF" => "无限火力",
            "CHERRY" => "斗魂竞技场",
            "ONEFORALL" => "克隆大作战",
            "PRACTICETOOL" => "训练模式",
            "TUTORIAL" | "TUTORIAL_MODULE_1" | "TUTORIAL_MODULE_2" | "TUTORIAL_MODULE_3" => "新手教程",
            "CLASSIC" => "召唤师峡谷",
            "" => "对局",
            _ => "娱乐模式",
        }
    };
    label.into()
}

fn champion_key(p: &Value) -> String {
    // "game_character_displayname_MonkeyKing" -> "MonkeyKing"
    let raw = s(p, "rawChampionName");
    raw.rsplit('_').next().unwrap_or("").to_string()
}

fn u(v: Option<&Value>) -> u32 {
    v.and_then(|x| x.as_f64()).map(|f| f.max(0.0) as u32).unwrap_or(0)
}

fn eog_stat(p: &Value, k: &str) -> Option<u64> {
    p.get("stats").and_then(|st| st.get(k)).and_then(|x| x.as_f64()).map(|f| f.max(0.0) as u64)
}

/// Everything the record needs, from what the watcher saved in `dir`.
pub fn summarize(dir: &Path) -> Option<Summary> {
    let log = LiveLog::load(dir)?;
    let eog: Option<Value> = fs::read_to_string(dir.join(EOG_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let me = &log.me;
    let snap = log.snapshot.clone().unwrap_or(Value::Null);
    let all_players: Vec<Value> = snap
        .get("allPlayers")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let champ_of = |name: &str| -> Option<String> {
        all_players
            .iter()
            .find(|p| is_me(&names_of(p), name))
            .map(|p| s(p, "championName"))
            .filter(|c| !c.is_empty())
    };
    let at = |e: &Value| e.get("atMs").and_then(|x| x.as_i64()).unwrap_or(0);
    let etime = |e: &Value| e.get("EventTime").and_then(|x| x.as_f64()).unwrap_or(0.0);

    // --- the player's moments
    let mut moments: Vec<(f64, Moment)> = Vec::new();
    let mut won: Option<bool> = None;
    let mut end_ms: Option<i64> = None;
    let mut best_multi = 0i64;
    for e in &log.events {
        let name = s(e, "EventName");
        let killer = s(e, "KillerName");
        let helped = assisters(e).iter().any(|a| is_me(me, a));
        match name.as_str() {
            "ChampionKill" => {
                let victim = s(e, "VictimName");
                if is_me(me, &killer) {
                    moments.push((etime(e), Moment {
                        kind: "kill",
                        at_ms: at(e),
                        victim: champ_of(&victim).or(Some(victim)),
                        detail: None,
                    }));
                } else if is_me(me, &victim) {
                    moments.push((etime(e), Moment {
                        kind: "death",
                        at_ms: at(e),
                        victim: champ_of(&killer).or(Some(killer)).filter(|k| !k.is_empty()),
                        detail: None,
                    }));
                } else if helped {
                    moments.push((etime(e), Moment {
                        kind: "assist",
                        at_ms: at(e),
                        victim: champ_of(&victim).or(Some(victim)),
                        detail: None,
                    }));
                }
            }
            "Multikill" if is_me(me, &killer) => {
                let n = e.get("KillStreak").and_then(|x| x.as_i64()).unwrap_or(0);
                best_multi = best_multi.max(n);
                // the kill that made it: the player's last kill at or before this
                if let Some(label) = multikill_label(n) {
                    if let Some((_, m)) = moments
                        .iter_mut()
                        .rev()
                        .find(|(t, m)| m.kind == "kill" && *t <= etime(e) + 0.5)
                    {
                        m.detail = Some(label.into());
                    }
                }
            }
            "FirstBlood" if is_me(me, &s(e, "Recipient")) => {
                if let Some((_, m)) = moments
                    .iter_mut()
                    .rev()
                    .find(|(t, m)| m.kind == "kill" && *t <= etime(e) + 0.5)
                {
                    if m.detail.is_none() {
                        m.detail = Some("一血".into());
                    }
                }
            }
            "Ace" if is_me(me, &s(e, "Acer")) => {
                if let Some((_, m)) = moments
                    .iter_mut()
                    .rev()
                    .find(|(t, m)| m.kind == "kill" && *t <= etime(e) + 0.5)
                {
                    m.detail = Some(match &m.detail {
                        Some(d) => format!("{d} · 团灭"),
                        None => "团灭".into(),
                    });
                }
            }
            "DragonKill" | "HeraldKill" | "BaronKill" | "HordeKill" | "AtakhanKill"
                if is_me(me, &killer) || helped =>
            {
                let stolen = truthy(e.get("Stolen"));
                moments.push((etime(e), Moment {
                    kind: "objective",
                    at_ms: at(e),
                    victim: objective_label(e),
                    detail: if stolen { Some("抢".into()) } else { None },
                }));
            }
            "TurretKilled" | "InhibKilled" if is_me(me, &killer) => {
                moments.push((etime(e), Moment {
                    kind: "objective",
                    at_ms: at(e),
                    victim: Some(if name == "TurretKilled" { "防御塔" } else { "水晶" }.into()),
                    detail: None,
                }));
            }
            "GameEnd" => {
                let r = s(e, "Result");
                won = Some(r.eq_ignore_ascii_case("Win"));
                end_ms = Some(at(e));
                if won == Some(true) {
                    moments.push((etime(e), Moment {
                        kind: "win",
                        at_ms: at(e),
                        victim: None,
                        detail: None,
                    }));
                }
            }
            _ => {}
        }
    }

    // --- stats: the game's last scoreboard, completed by the client's end-of-game screen
    let eog_players: Vec<Value> = eog
        .as_ref()
        .and_then(|v| v.get("teams"))
        .and_then(|t| t.as_array())
        .map(|teams| {
            teams
                .iter()
                .flat_map(|t| t.get("players").and_then(|p| p.as_array()).cloned().unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();
    let eog_of = |champion: &str, names: &[String]| -> Option<&Value> {
        eog_players.iter().find(|p| {
            names_of(p).iter().any(|n| is_me(names, n)) || (!champion.is_empty() && s(p, "championName") == champion)
        })
    };
    let mut players: Vec<LolPlayer> = all_players
        .iter()
        .map(|p| {
            let sc = p.get("scores");
            let names = names_of(p);
            let champion = s(p, "championName");
            let e = eog_of(&champion, &names);
            LolPlayer {
                name: {
                    let n = s(p, "riotIdGameName");
                    if n.is_empty() { s(p, "summonerName") } else { n }
                },
                champion_key: champion_key(p),
                champion,
                team: s(p, "team"),
                level: u(p.get("level")),
                kills: u(sc.and_then(|x| x.get("kills"))),
                deaths: u(sc.and_then(|x| x.get("deaths"))),
                assists: u(sc.and_then(|x| x.get("assists"))),
                cs: u(sc.and_then(|x| x.get("creepScore"))),
                damage: e.and_then(|x| eog_stat(x, "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS")),
                gold: e.and_then(|x| eog_stat(x, "GOLD_EARNED")),
                me: names.iter().any(|n| is_me(me, n)),
            }
        })
        .collect();
    // the end-of-game screen has the final numbers
    for p in players.iter_mut() {
        if let Some(e) = eog_of(&p.champion, &[p.name.clone()]) {
            if let Some(k) = eog_stat(e, "CHAMPIONS_KILLED") {
                p.kills = k as u32;
            }
            if let Some(d) = eog_stat(e, "NUM_DEATHS") {
                p.deaths = d as u32;
            }
            if let Some(a) = eog_stat(e, "ASSISTS") {
                p.assists = a as u32;
            }
            let minions = eog_stat(e, "MINIONS_KILLED");
            let neutral = eog_stat(e, "NEUTRAL_MINIONS_KILLED");
            if minions.is_some() || neutral.is_some() {
                p.cs = (minions.unwrap_or(0) + neutral.unwrap_or(0)) as u32;
            }
            if let Some(l) = eog_stat(e, "LEVEL") {
                p.level = l as u32;
            }
        }
    }
    let mine = players.iter().find(|p| p.me).cloned().unwrap_or_default();
    let my_snap = all_players.iter().find(|p| names_of(p).iter().any(|n| is_me(me, n)));
    let vision = my_snap
        .and_then(|p| p.get("scores"))
        .and_then(|x| x.get("wardScore"))
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    if won.is_none() {
        // no GameEnd event seen (e.g. the recording stopped early): the client knows
        won = eog
            .as_ref()
            .and_then(|v| v.get("teams"))
            .and_then(|t| t.as_array())
            .and_then(|teams| {
                teams.iter().find(|t| {
                    t.get("players")
                        .and_then(|p| p.as_array())
                        .map(|ps| ps.iter().any(|p| names_of(p).iter().any(|n| is_me(me, n))))
                        .unwrap_or(false)
                })
            })
            .and_then(|t| t.get("isWinningTeam"))
            .and_then(|x| x.as_bool());
    }
    let game_mode = snap
        .get("gameData")
        .map(|g| s(g, "gameMode"))
        .unwrap_or_default();
    let queue_type = eog.as_ref().map(|v| s(v, "queueType")).unwrap_or_default();
    let queue = mode_label(&queue_type, &game_mode);
    let game_length_s = eog
        .as_ref()
        .and_then(|v| v.get("gameLength"))
        .and_then(|x| x.as_f64())
        .or_else(|| snap.get("gameData").and_then(|g| g.get("gameTime")).and_then(|x| x.as_f64()))
        .unwrap_or(0.0);

    moments.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Some(Summary {
        moments: moments.into_iter().map(|(_, m)| m).collect(),
        stats: LolStats {
            champion: mine.champion.clone(),
            champion_key: mine.champion_key.clone(),
            level: mine.level,
            kills: mine.kills,
            deaths: mine.deaths,
            assists: mine.assists,
            cs: mine.cs,
            vision,
            gold: mine.gold,
            damage: mine.damage,
            win: won,
            queue: queue.clone(),
            best_multikill: best_multi.max(0) as u32,
            game_length_s,
            players,
        },
        labels: ("英雄联盟".into(), queue),
        game_start_ms: log.game_start_ms,
        game_end_ms: end_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_match() {
        let dir = std::env::temp_dir().join(format!("kc_lol_{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let log = LiveLog {
            game_start_ms: Some(1_000_000),
            me: vec!["Jason#NA1".into(), "Jason".into()],
            events: vec![
                json!({"EventID":0,"EventName":"GameStart","EventTime":0.0,"atMs":1_000_000}),
                json!({"EventID":1,"EventName":"ChampionKill","EventTime":300.0,"KillerName":"Jason","VictimName":"Bob","Assisters":[],"atMs":1_300_000}),
                json!({"EventID":2,"EventName":"FirstBlood","EventTime":300.0,"Recipient":"Jason","atMs":1_300_000}),
                json!({"EventID":3,"EventName":"ChampionKill","EventTime":303.0,"KillerName":"Jason","VictimName":"Al","Assisters":["Mia"],"atMs":1_303_000}),
                json!({"EventID":4,"EventName":"Multikill","EventTime":303.0,"KillerName":"Jason","KillStreak":2,"atMs":1_303_000}),
                json!({"EventID":5,"EventName":"ChampionKill","EventTime":400.0,"KillerName":"Mia","VictimName":"Bob","Assisters":["Jason"],"atMs":1_400_000}),
                json!({"EventID":6,"EventName":"DragonKill","EventTime":500.0,"KillerName":"Mia","DragonType":"Fire","Stolen":"True","Assisters":["Jason"],"atMs":1_500_000}),
                json!({"EventID":7,"EventName":"ChampionKill","EventTime":600.0,"KillerName":"Al","VictimName":"Jason","Assisters":[],"atMs":1_600_000}),
                json!({"EventID":8,"EventName":"TurretKilled","EventTime":700.0,"KillerName":"Mia","TurretKilled":"Turret_T2_L_03_A","Assisters":[],"atMs":1_700_000}),
                json!({"EventID":9,"EventName":"GameEnd","EventTime":900.0,"Result":"Win","atMs":1_900_000}),
            ],
            snapshot: Some(json!({
                "allPlayers": [
                    {"riotId":"Jason#NA1","riotIdGameName":"Jason","championName":"Ahri","rawChampionName":"game_character_displayname_Ahri","team":"ORDER","level":14,"scores":{"kills":2,"deaths":1,"assists":2,"creepScore":180,"wardScore":21.5}},
                    {"riotId":"Mia#NA1","riotIdGameName":"Mia","championName":"Lee Sin","rawChampionName":"game_character_displayname_LeeSin","team":"ORDER","level":13,"scores":{"kills":3,"deaths":2,"assists":4,"creepScore":120,"wardScore":30.0}},
                    {"riotId":"Bob#NA1","riotIdGameName":"Bob","championName":"Garen","rawChampionName":"game_character_displayname_Garen","team":"CHAOS","level":12,"scores":{"kills":0,"deaths":2,"assists":0,"creepScore":150,"wardScore":8.0}},
                    {"riotId":"Al#NA1","riotIdGameName":"Al","championName":"Wukong","rawChampionName":"game_character_displayname_MonkeyKing","team":"CHAOS","level":12,"scores":{"kills":1,"deaths":1,"assists":0,"creepScore":140,"wardScore":9.0}}
                ],
                "gameData": {"gameMode":"CLASSIC","gameTime":905.0}
            })),
            done: true,
        };
        log.save(&dir);
        let sum = summarize(&dir).unwrap();
        let kinds: Vec<&str> = sum.moments.iter().map(|m| m.kind).collect();
        assert_eq!(kinds, vec!["kill", "kill", "assist", "objective", "death", "win"]);
        assert_eq!(sum.moments[0].detail.as_deref(), Some("一血"));
        assert_eq!(sum.moments[0].victim.as_deref(), Some("Garen"));
        assert_eq!(sum.moments[1].detail.as_deref(), Some("双杀"));
        assert_eq!(sum.moments[3].victim.as_deref(), Some("炼狱亚龙"));
        assert_eq!(sum.moments[3].detail.as_deref(), Some("抢"));
        assert_eq!(sum.moments[4].victim.as_deref(), Some("Wukong"));
        assert_eq!(sum.stats.champion_key, "Ahri");
        assert_eq!(sum.stats.win, Some(true));
        assert_eq!(sum.stats.best_multikill, 2);
        assert_eq!((sum.stats.kills, sum.stats.deaths, sum.stats.assists, sum.stats.cs), (2, 1, 2, 180));
        assert_eq!(sum.labels.1, "召唤师峡谷");
        assert_eq!(sum.stats.players.iter().find(|p| p.champion == "Wukong").unwrap().champion_key, "MonkeyKing");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn modes() {
        assert_eq!(mode_label("RANKED_SOLO_5x5", "CLASSIC"), "单双排位");
        assert_eq!(mode_label("", "ARAM"), "极地大乱斗");
        assert_eq!(mode_label("NORMAL", "CLASSIC"), "匹配");
    }
}
