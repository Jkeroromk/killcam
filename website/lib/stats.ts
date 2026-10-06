// Example numbers for the stats section, shaped like the app's 数据 page.
// Generated from a fixed seed so every visitor (and the server render) sees
// the same matches; the tiles are computed from the matches, so they agree.

export type MapKey = "erangel" | "miramar" | "taego" | "vikendi" | "deston" | "rondo";

export type DemoMatch = {
  map: MapKey;
  kills: number;
  knocks: number;
  damage: number;
  place: number;
  died: boolean;
  heads: number;
};

export type Weapon = { name: string; kills: number; avgDist: number; heads: number };

export type DemoStats = {
  matches: DemoMatch[];
  n: number;
  wins: number;
  kills: number;
  knocks: number;
  deaths: number;
  damage: number;
  top10: number;
  heads: number;
  weapons: Weapon[];
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAPS: MapKey[] = ["erangel", "erangel", "miramar", "taego", "vikendi", "deston", "rondo"];

function make(n: number, seed: number): DemoMatch[] {
  const r = rng(seed);
  const out: DemoMatch[] = [];
  for (let i = 0; i < n; i++) {
    const place = r() < 0.12 ? 1 : r() < 0.45 ? 2 + Math.floor(r() * 9) : 11 + Math.floor(r() * 16);
    const good = place === 1 ? 1.6 : place <= 10 ? 1 : 0.55;
    const kills = Math.max(0, Math.round((r() * 5 + r() * 2) * good));
    const knocks = Math.max(0, Math.round(kills * 0.8 + r() * 1.8 - 0.6));
    out.push({
      map: MAPS[Math.floor(r() * MAPS.length)],
      kills,
      knocks,
      damage: Math.round(kills * 105 + r() * 220),
      place,
      died: place !== 1,
      heads: Math.round(kills * (0.18 + r() * 0.2)),
    });
  }
  // the newest match is the one in the hero: Erangel, 7 kills, chicken dinner
  out[n - 1] = { map: "erangel", kills: 7, knocks: 4, damage: 970, place: 1, died: false, heads: 1 };
  return out;
}

function summarise(matches: DemoMatch[], weaponSeed: number): DemoStats {
  const sum = (f: (m: DemoMatch) => number) => matches.reduce((a, m) => a + f(m), 0);
  const kills = sum((m) => m.kills);
  const heads = sum((m) => m.heads);
  // split kills across weapons in a fixed proportion
  const shares: [string, number, number][] = [
    ["Beryl M762", 0.34, 41],
    ["M416", 0.27, 58],
    ["Kar98k", 0.14, 186],
    ["ACE32", 0.13, 47],
    ["Mini14", 0.07, 132],
  ];
  const r = rng(weaponSeed);
  const weapons = shares.map(([name, share, dist]) => {
    const k = Math.round(kills * share);
    return { name, kills: k, avgDist: Math.round(dist * (0.9 + r() * 0.2)), heads: Math.round(k * (dist > 100 ? 0.42 : 0.2)) };
  });
  return {
    matches,
    n: matches.length,
    wins: matches.filter((m) => m.place === 1).length,
    kills,
    knocks: sum((m) => m.knocks),
    deaths: matches.filter((m) => m.died).length,
    damage: sum((m) => m.damage),
    top10: matches.filter((m) => m.place <= 10).length,
    heads,
    weapons: weapons.filter((w) => w.kills > 0).slice(0, 4),
  };
}

const ALL = make(50, 7741);

/** "last 20" is the newest 20 of the same 50 matches, oldest first */
export const DEMO: Record<20 | 50, DemoStats> = {
  20: summarise(ALL.slice(-20), 11),
  50: summarise(ALL, 11),
};

// ---------- League of Legends ----------

export type Champ = { zh: string; en: string };

export const CHAMPS: Champ[] = [
  { zh: "阿狸", en: "Ahri" },
  { zh: "李青", en: "Lee Sin" },
  { zh: "金克丝", en: "Jinx" },
  { zh: "亚索", en: "Yasuo" },
  { zh: "锤石", en: "Thresh" },
];

export type LolMatch = {
  champ: number;
  win: boolean;
  k: number;
  d: number;
  a: number;
  cs: number;
  minutes: number;
  damage: number;
  teamKills: number;
  multi: [number, number, number, number]; // double, triple, quadra, penta
};

export type LolStats = {
  matches: LolMatch[];
  n: number;
  wins: number;
  k: number;
  d: number;
  a: number;
  cs: number;
  minutes: number;
  damage: number;
  teamKills: number;
  multi: [number, number, number, number];
  champs: { champ: Champ; games: number; wins: number; kda: number }[];
};

function makeLol(n: number, seed: number): LolMatch[] {
  const r = rng(seed);
  const weights = [0.34, 0.24, 0.18, 0.14, 0.1];
  const out: LolMatch[] = [];
  for (let i = 0; i < n; i++) {
    let x = r();
    let champ = 0;
    while (champ < weights.length - 1 && x > weights[champ]) x -= weights[champ++];
    const win = r() < 0.56;
    const minutes = 22 + Math.round(r() * 14);
    const k = Math.round((win ? 6.5 : 3.5) * (0.5 + r()));
    const d = Math.round((win ? 3 : 5.5) * (0.4 + r()));
    const a = Math.round((win ? 8 : 5) * (0.5 + r()));
    const teamKills = Math.max(k + a, Math.round(minutes * (win ? 0.78 : 0.58) * (0.8 + r() * 0.4)));
    const double = k >= 5 && r() < 0.6 ? 1 + (r() < 0.25 ? 1 : 0) : 0;
    const triple = k >= 8 && r() < 0.3 ? 1 : 0;
    out.push({
      champ,
      win,
      k,
      d,
      a,
      cs: Math.round(minutes * (champ === 4 ? 1.2 : 6 + r() * 2.2)),
      minutes,
      damage: Math.round((k * 1500 + a * 600 + minutes * 450) * (0.8 + r() * 0.4)),
      teamKills,
      multi: [double, triple, 0, 0],
    });
  }
  // the newest match is the one in the hero: a penta and the win
  out[n - 1] = { champ: 0, win: true, k: 11, d: 1, a: 2, cs: 241, minutes: 30, damage: 38420, teamKills: 18, multi: [1, 1, 0, 1] };
  return out;
}

function summariseLol(matches: LolMatch[]): LolStats {
  const sum = (f: (m: LolMatch) => number) => matches.reduce((acc, m) => acc + f(m), 0);
  const multi = [0, 1, 2, 3].map((i) => sum((m) => m.multi[i])) as LolStats["multi"];
  const champs = CHAMPS.map((champ, i) => {
    const mine = matches.filter((m) => m.champ === i);
    const k = mine.reduce((a, m) => a + m.k, 0);
    const d = mine.reduce((a, m) => a + m.d, 0);
    const a = mine.reduce((acc, m) => acc + m.a, 0);
    return { champ, games: mine.length, wins: mine.filter((m) => m.win).length, kda: (k + a) / Math.max(d, 1) };
  })
    .filter((c) => c.games > 0)
    .sort((x, y) => y.games - x.games)
    .slice(0, 4);
  return {
    matches,
    n: matches.length,
    wins: matches.filter((m) => m.win).length,
    k: sum((m) => m.k),
    d: sum((m) => m.d),
    a: sum((m) => m.a),
    cs: sum((m) => m.cs),
    minutes: sum((m) => m.minutes),
    damage: sum((m) => m.damage),
    teamKills: sum((m) => m.teamKills),
    multi,
    champs,
  };
}

const ALL_LOL = makeLol(50, 2026);

export const LOL_DEMO: Record<20 | 50, LolStats> = {
  20: summariseLol(ALL_LOL.slice(-20)),
  50: summariseLol(ALL_LOL),
};
