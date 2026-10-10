// Chinese and English UI.
//
// UI text is written in place as t("中文", "English"): the Chinese is the
// original, the English sits right next to it. Labels that the backend stores
// in a recording (map, mode, weapon, highlight titles…) are always Chinese on
// disk; label() / title() show them in the current language, so switching
// back and forth works for old recordings too.

export type Lang = "zh" | "en";
export type LangSetting = "auto" | "zh" | "en";

let current: Lang = "zh";

/** The Windows display language, as WebView2 reports it. */
export function systemLang(): Lang {
  try {
    return (navigator.languages?.[0] ?? navigator.language ?? "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

export function resolveLang(setting: LangSetting | string | undefined | null): Lang {
  return setting === "zh" || setting === "en" ? setting : systemLang();
}

export function setLang(l: Lang) {
  current = l;
  try {
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  } catch {
    /* no document (tests) */
  }
}

export function lang(): Lang {
  return current;
}

export const isEn = () => current === "en";

/** UI text in the current language. */
export function t(zh: string, en: string): string {
  return current === "en" ? en : zh;
}

/** "1 kill" / "3 kills"; Chinese has no plural. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// ---------------------------------------------------------------------------
// labels stored in recordings (Chinese on disk)

const LABELS: Record<string, string> = {
  // PUBG maps
  艾伦格: "Erangel",
  米拉玛: "Miramar",
  萨诺: "Sanhok",
  维寒迪: "Vikendi",
  卡拉金: "Karakin",
  帕拉莫: "Paramo",
  褐湾: "Haven",
  泰戈: "Taego",
  帝斯顿: "Deston",
  荣都: "Rondo",
  训练场: "Training Ground",
  未知地图: "Unknown map",
  // PUBG modes and record kinds
  四排: "Squad",
  双排: "Duo",
  单排: "Solo",
  团队死斗: "Team Deathmatch",
  街机: "Arcade",
  自定义: "Custom",
  "自定义 / 训练": "Custom / Training",
  普通对局: "Match",
  大逃杀: "Battle Royale",
  手动片段: "Manual clips",
  // weapons and causes with Chinese names
  短管霰弹: "Sawed-off",
  十字弩: "Crossbow",
  铁拳火箭筒: "Panzerfaust",
  迫击炮: "Mortar",
  手雷: "Frag Grenade",
  燃烧瓶: "Molotov",
  黏性炸弹: "Sticky Bomb",
  平底锅: "Pan",
  蝎式手枪: "Skorpion",
  拳头: "Fists",
  红区: "Red Zone",
  毒圈: "Blue Zone",
  载具: "Vehicle",
  // moments
  击杀: "Kill",
  击倒: "Knock",
  阵亡: "Death",
  被击倒: "Knocked",
  吃鸡: "Chicken Dinner",
  手动标记: "Marker",
  助攻: "Assist",
  资源: "Objective",
  事件: "Event",
  高光: "Highlight",
  胜利: "Victory",
  一血: "First Blood",
  团灭: "Ace",
  双杀: "Double Kill",
  三杀: "Triple Kill",
  四杀: "Quadra Kill",
  五杀: "Penta Kill",
  // League of Legends
  英雄联盟: "League of Legends",
  炼狱亚龙: "Infernal Drake",
  海洋亚龙: "Ocean Drake",
  山脉亚龙: "Mountain Drake",
  云端亚龙: "Cloud Drake",
  海克斯亚龙: "Hextech Drake",
  炼金亚龙: "Chemtech Drake",
  远古巨龙: "Elder Dragon",
  小龙: "Dragon",
  峡谷先锋: "Rift Herald",
  纳什男爵: "Baron Nashor",
  虚空巢虫: "Voidgrubs",
  阿塔坎: "Atakhan",
  防御塔: "Turret",
  水晶: "Inhibitor",
  单双排位: "Ranked Solo/Duo",
  灵活排位: "Ranked Flex",
  极地大乱斗: "ARAM",
  无限火力: "URF",
  斗魂竞技场: "Arena",
  人机对战: "Co-op vs. AI",
  匹配: "Normal",
  克隆大作战: "One for All",
  训练模式: "Practice Tool",
  新手教程: "Tutorial",
  召唤师峡谷: "Summoner's Rift",
  对局: "Match",
  娱乐模式: "Featured Mode",
};

// plurals for "3 击杀" -> "3 Kills"
const PLURAL: Record<string, string> = {
  击杀: "Kills",
  击倒: "Knocks",
  阵亡: "Deaths",
  被击倒: "Times Knocked",
  手动标记: "Markers",
  助攻: "Assists",
};

/** A stored label (map, mode, weapon, kind…) in the current language. */
export function label(s: string | null | undefined): string {
  if (!s) return "";
  if (current === "zh") return s;
  const direct = LABELS[s];
  if (direct) return direct;
  // "四排 FPP"
  const fpp = s.match(/^(.+) FPP$/);
  if (fpp && LABELS[fpp[1]]) return `${LABELS[fpp[1]]} FPP`;
  return s;
}

function part(p: string): string {
  const direct = LABELS[p];
  if (direct) return direct;
  // "3 击杀"
  const n = p.match(/^(\d+) (.+)$/);
  if (n) return `${n[1]} ${PLURAL[n[2]] ?? label(n[2])}`;
  // "抢纳什男爵"
  const steal = p.match(/^抢(.+)$/);
  if (steal) return `${label(steal[1])} Steal`;
  // "双杀 · 团灭"
  if (p.includes(" · ")) return p.split(" · ").map(part).join(" · ");
  return label(p);
}

/** A stored highlight title ("2 击杀 + 击倒") in the current language. */
export function title(s: string | null | undefined): string {
  if (!s) return "";
  if (current === "zh") return s;
  return s.split(" + ").map(part).join(" + ");
}
