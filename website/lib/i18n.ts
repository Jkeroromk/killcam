export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "zh";

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v);
}

export type EventKind = "kill" | "knock" | "knocked" | "eliminated" | "win" | "manual";

type Pair = { title: string; body: string };

export type Dict = {
  meta: { title: string; description: string; changelogTitle: string };
  nav: { features: string; stats: string; install: string; faq: string; changelog: string; source: string; otherLang: string; otherLangLabel: string; skip: string };
  hero: {
    titleA: string;
    titleB: string;
    sub: string;
    download: string;
    downloadFallback: string;
    free: string;
    source: string;
  };
  timeline: {
    label: string;
    match: string;
    replay: string;
    events: Record<EventKind, string>;
    clips: string; // {n} = number of clips
    kills: string;
    knocks: string;
  };
  features: { title: string; intro: string; items: Pair[] };
  shots: { match: string; home: string; mini: string };
  stats: {
    title: string;
    body: string;
    points: string[];
    keyNote: string;
    panelLabel: string;
    page: string;
    range: (n: number) => string;
    tiles: {
      matches: string;
      matchesSub: (wins: number, rate: string) => string;
      kills: string;
      killsSub: (kills: number, knocks: number) => string;
      kd: string;
      kdSub: (deaths: number) => string;
      damage: string;
      damageSub: (total: string) => string;
      top10: string;
      top10Sub: (n: number) => string;
      heads: string;
      headsSub: (n: number) => string;
    };
    perMatch: (metric: string) => string;
    metrics: { kills: string; damage: string; place: string };
    winLegend: string;
    weapons: string;
    weaponSub: (dist: number, heads: number) => string;
    maps: Record<"erangel" | "miramar" | "taego" | "vikendi" | "deston" | "rondo", string>;
    sample: string;
  };
  install: {
    title: string;
    steps: Pair[];
    after: string;
    smart: { heading: string; text: string; more: string; run: string; dontRun: string; app: string; publisher: string; unknown: string };
  };
  reqs: { title: string; rows: [string, string][] };
  faq: { title: string; items: { q: string; a: string }[]; more: string };
  privacy: { title: string; items: Pair[] };
  cta: { title: string; sub: string };
  footer: { license: string; issues: string; releases: string; by: string };
  changelog: {
    title: string;
    intro: string;
    latest: string;
    download: string;
    noNotes: string;
    unavailable: string;
    allOnGithub: string;
    back: string;
  };
};

const zh: Dict = {
  meta: {
    title: "KillCam：免费的 PUBG 自动高光录制",
    description: "打开游戏就开始录，打完自动剪出击杀、击倒、吃鸡的片段。免费、无广告、开源，录像只存在你自己的电脑上。",
    changelogTitle: "更新日志",
  },
  nav: {
    features: "功能",
    stats: "数据",
    install: "安装",
    faq: "常见问题",
    changelog: "更新日志",
    source: "GitHub",
    otherLang: "EN",
    otherLangLabel: "Switch to English",
    skip: "跳到正文",
  },
  hero: {
    titleA: "打完这一局，",
    titleB: "高光已经剪好了。",
    sub: "KillCam 是免费、无广告的 PUBG 自动高光录制。打开游戏就开始录，击杀、击倒、吃鸡自动剪成片段，不用记任何快捷键。",
    download: "下载 Windows 版",
    downloadFallback: "去 GitHub 下载",
    free: "免费，开源，不需要注册",
    source: "查看源代码",
  },
  timeline: {
    label: "一局对局的时间轴示例：KillCam 识别到的事件和剪出的高光片段",
    match: "艾伦格 四排 第 1 名",
    replay: "重新播放",
    events: {
      kill: "击杀",
      knock: "击倒",
      knocked: "被击倒",
      eliminated: "被淘汰",
      win: "大吉大利",
      manual: "F9 手动标记",
    },
    clips: "已剪出 {n} 段高光",
    kills: "击杀",
    knocks: "击倒",
  },
  features: {
    title: "装好以后，它自己会做的事",
    intro: "大部分时候你不用打开它。打游戏，然后回来看剪好的片段。",
    items: [
      { title: "自动开录", body: "开机后待在托盘里。PUBG 一打开就开始录，关掉游戏就停。" },
      { title: "自动找高光", body: "识别屏幕上的击倒、淘汰、被击倒、被淘汰和大吉大利提示。填了 PUBG API Key，还能标出每次击杀用的武器、距离和是否爆头。" },
      { title: "整局时间轴", body: "所有事件排在一条可缩放的时间轴上，点哪看哪。挤在一起的击杀会自动合并，点一下放大。" },
      { title: "剪辑导出", body: "拖动调整每段的开头和结尾，导出原比例、16:9 或竖屏，原画质、1080p 或 720p。勾选几段可以一键合成集锦。" },
      { title: "声音分开录", body: "游戏声音和麦克风录在两条音轨里。导出时可以混在一起，也可以分轨，后期好处理。" },
      { title: "F9 手动标记", body: "觉得刚才那波很精彩，按一下 F9，这一段就会被留下来。" },
      { title: "个人数据", body: "最近 20 局或 50 局的场均击杀、K/D、伤害、吃鸡率、爆头率，还有常用武器和各地图战绩。需要 PUBG API Key。" },
      { title: "不占满硬盘", body: "可以只保留高光，整局录像处理完就删。超过设定的容量会自动清理最旧的录像，收藏的不删。" },
      { title: "游戏里的迷你窗口", body: "显示录制时长和识别到的击杀数，不会被录进视频。" },
    ],
  },
  stats: {
    title: "每一局都记下来，打法自己会说话",
    body: "填了 PUBG API Key 以后，KillCam 会把每局的官方数据存在你电脑上，在「数据」页里汇总给你看。",
    points: [
      "最近 20 局、50 局或全部对局，随时切换",
      "每局击杀、伤害、排名的走势，吃鸡的局单独标出来",
      "常用武器的击杀数、平均距离和爆头数",
      "各地图战绩、击杀最多的一局和最远击杀",
    ],
    keyNote: "API Key 在 developer.pubg.com 免费申请，第一次打开时的引导里有步骤。街机和自定义房间没有官方数据，不计入统计。",
    panelLabel: "KillCam 数据页示例",
    page: "数据",
    range: (n) => `最近 ${n} 局`,
    tiles: {
      matches: "对局",
      matchesSub: (w, r) => `${w} 次吃鸡 · 吃鸡率 ${r}`,
      kills: "场均击杀",
      killsSub: (k, n) => `共 ${k} 击杀 · ${n} 击倒`,
      kd: "K/D",
      kdSub: (d) => `阵亡 ${d} 次`,
      damage: "场均伤害",
      damageSub: (t) => `共 ${t}`,
      top10: "前十率",
      top10Sub: (n) => `${n} 局进前十`,
      heads: "爆头率",
      headsSub: (n) => `${n} 次爆头击杀`,
    },
    perMatch: (m) => `每局${m}`,
    metrics: { kills: "击杀", damage: "伤害", place: "排名" },
    winLegend: "吃鸡",
    weapons: "常用武器",
    weaponSub: (d, h) => `平均 ${d} 米${h ? ` · ${h} 爆头` : ""}`,
    maps: { erangel: "艾伦格", miramar: "米拉玛", taego: "泰戈", vikendi: "维寒迪", deston: "帝斯顿", rondo: "荣都" },
    sample: "示例数据",
  },
  shots: {
    match: "单局回放：时间轴、高光列表和导出选项",
    home: "总览：最近的对局和录制状态",
    mini: "游戏时的迷你窗口",
  },
  install: {
    title: "安装",
    steps: [
      { title: "下载安装包", body: "点上面的下载按钮，或者去 GitHub Releases 下载 KillCam_x.x.x_x64-setup.exe。" },
      { title: "双击安装", body: "不需要管理员权限。FFmpeg 已经打包在里面，不用另外装。" },
      { title: "如果 Windows 拦截了", body: "点「更多信息」，再点「仍要运行」。KillCam 是免费的个人项目，还没有购买微软的代码签名证书。源代码都公开在 GitHub 上，可以自己检查。" },
      { title: "跟着引导设置", body: "第一次打开会带你选显示器、画质、声音来源和录像保存位置，最后跑一次性能测试，确认不掉帧。" },
    ],
    after: "以后有新版本，KillCam 会自己提示，点一下就装好，不用再回来下载。",
    smart: {
      heading: "Windows 已保护你的电脑",
      text: "Microsoft Defender SmartScreen 阻止了无法识别的应用启动。运行此应用可能会导致你的电脑存在风险。",
      more: "更多信息",
      run: "仍要运行",
      dontRun: "不运行",
      app: "应用",
      publisher: "发布者",
      unknown: "未知发布者",
    },
  },
  reqs: {
    title: "电脑要求",
    rows: [
      ["系统", "Windows 10（2004 及以上）或 Windows 11，64 位"],
      ["显卡", "支持 NVENC 的 NVIDIA 显卡（GTX 10 系列及以上）。AMD 显卡理论上可用，还没测试过"],
      ["游戏", "Steam 版 PUBG"],
      ["读屏识别", "目前只支持简体中文游戏界面、默认 HUD"],
    ],
  },
  faq: {
    title: "常见问题",
    more: "没找到答案？去 GitHub Issues 提问",
    items: [
      {
        q: "会不会被封号？",
        a: "KillCam 不注入游戏、不读写游戏内存、不修改任何游戏文件。它和 OBS 的「显示器采集」用的是同一种方法：通过 Windows 自带的屏幕复制功能录屏，用 Windows 的音频接口录声音，再读 PUBG 自己写在本地的日志文件和官方公开的 API。不过反作弊的规则只有游戏公司说了算，这里没办法给出保证。",
      },
      {
        q: "会掉帧吗？",
        a: "录屏会占一点显卡，和开着 OBS 显示器采集差不多。编码用的是显卡上独立的 NVENC 芯片，不占玩游戏的算力。剪高光只复制视频数据、不重新编码，用最低优先级在后台跑。帧数比较紧张的话，可以在「设置 → 画质」里把录制帧率从 60 改成 30。",
      },
      {
        q: "一定要填 PUBG API Key 吗？",
        a: "不是必须的。不填的话，靠读屏识别击杀、击倒、阵亡和吃鸡，也能自动剪高光。填了以后，普通对局会多出地图、排名、伤害、武器、距离、爆头等信息，时间点也更准。Key 可以在 developer.pubg.com 免费申请，引导里有步骤。",
      },
      {
        q: "打完多久能看到高光？",
        a: "不用关游戏。每局打完（吃鸡、被淘汰后一会儿，或者开始下一局时），这局的高光就会在后台剪好，回到大厅就能看。剪片段只是复制视频数据、不重新编码，用的是最低优先级，不影响游戏。填了 PUBG API Key 的话，普通对局会先按读屏剪好，几分钟后官方数据到了，再自动补上地图、排名、伤害和击杀详情。",
      },
      {
        q: "迷你窗口看不到，或者挡住了游戏？",
        a: "游戏要用「无边框窗口」模式，迷你窗口才能显示在游戏上面；用「全屏」模式的话它会被游戏挡住。有第二块屏幕可以把它拖过去，位置会被记住。不需要的话可以在「设置 → 启动和游戏时」关掉。",
      },
      {
        q: "录像和设置存在哪？怎么卸载？",
        a: "录像存在第一次引导时选的文件夹里，设置存在 %APPDATA%\\com.jkeroro.killcam。在 Windows「设置 → 应用」里卸载 KillCam 即可，录像文件夹不会被删除，需要的话自己删。",
      },
    ],
  },
  privacy: {
    title: "你的录像不会离开你的电脑",
    items: [
      { title: "不上传任何东西", body: "录像、截图和设置只存在你自己电脑上。KillCam 没有服务器，也不收集使用数据。" },
      { title: "只连两个地方", body: "填了 API Key 时去 PUBG 官方接口查你自己的对局；另外定期去 GitHub Releases 检查新版本。" },
      { title: "不碰游戏", body: "不注入游戏、不读写游戏内存、不修改游戏文件。" },
      { title: "代码公开", body: "全部源代码在 GitHub 上，MIT 许可证，可以自己检查或编译。" },
    ],
  },
  cta: {
    title: "下一局开始前装好它。",
    sub: "安装只要一分钟，第一次打开会带你把设置走一遍。",
  },
  footer: {
    license: "MIT 许可证",
    issues: "反馈问题",
    releases: "所有版本",
    by: "由 Jkeroro 制作。KillCam 是个人项目，与 KRAFTON 或 PUBG 官方无关。",
  },
  changelog: {
    title: "更新日志",
    intro: "每个版本都发布在 GitHub Releases。已经装了 KillCam 的话，它会自己提示更新。",
    latest: "最新版",
    download: "下载安装包",
    noNotes: "这个版本没有写更新说明。",
    unavailable: "暂时读不到版本列表。可以直接去 GitHub 看所有版本。",
    allOnGithub: "在 GitHub 上查看所有版本",
    back: "返回首页",
  },
};

const en: Dict = {
  meta: {
    title: "KillCam: free automatic highlights for PUBG",
    description: "Starts recording when PUBG opens and cuts your kills, knocks and chicken dinners into clips. Free, no ads, open source, and your recordings never leave your PC.",
    changelogTitle: "Changelog",
  },
  nav: {
    features: "Features",
    stats: "Stats",
    install: "Install",
    faq: "FAQ",
    changelog: "Changelog",
    source: "GitHub",
    otherLang: "中文",
    otherLangLabel: "切换到中文",
    skip: "Skip to content",
  },
  hero: {
    titleA: "Finish the match.",
    titleB: "The highlights are already cut.",
    sub: "KillCam is a free, ad-free highlight recorder for PUBG. It starts recording when the game opens and cuts your kills, knocks and chicken dinners into clips on its own. No hotkeys to remember.",
    download: "Download for Windows",
    downloadFallback: "Download on GitHub",
    free: "Free, open source, no account",
    source: "View the source",
  },
  timeline: {
    label: "Example match timeline: the events KillCam detected and the highlight clips it cut",
    match: "Erangel squad, placed #1",
    replay: "Replay",
    events: {
      kill: "Kill",
      knock: "Knock",
      knocked: "Knocked",
      eliminated: "Eliminated",
      win: "Chicken dinner",
      manual: "F9 marker",
    },
    clips: "{n} highlights cut",
    kills: "Kills",
    knocks: "Knocks",
  },
  features: {
    title: "What it does once it's installed",
    intro: "Most of the time you won't open it. Play, then come back to clips that are already cut.",
    items: [
      { title: "Records on its own", body: "Waits in the tray. Starts recording when PUBG opens and stops when you close it." },
      { title: "Finds the highlights", body: "Reads the on-screen knock, kill, knocked, eliminated and chicken dinner prompts. Add a PUBG API key and every kill also gets its weapon, distance and headshot." },
      { title: "Whole-match timeline", body: "Every event sits on one zoomable timeline; click anywhere to jump there. Kills that pile up are grouped, and one click zooms in." },
      { title: "Trim and export", body: "Drag the start and end of any clip. Export original, 16:9 or vertical, at source quality, 1080p or 720p. Tick a few clips to stitch a montage." },
      { title: "Separate audio tracks", body: "Game audio and your mic are recorded on separate tracks. Export them mixed or split for editing." },
      { title: "F9 to keep a moment", body: "Did something worth keeping? Press F9 and that moment stays." },
      { title: "Your stats", body: "Average kills, K/D, damage, win rate and headshot rate over your last 20 or 50 matches, plus favourite weapons and per-map results. Needs a PUBG API key." },
      { title: "Keeps your drive in check", body: "Keep only the highlights and drop full recordings once they're processed. Past your size limit, the oldest recordings are cleared; favourites stay." },
      { title: "In-game mini window", body: "Shows recording time and kills detected. It never shows up in your recordings." },
    ],
  },
  stats: {
    title: "Every match, on the record",
    body: "Add your PUBG API key and KillCam keeps each match's official data on your PC, then sums it up on the Stats page.",
    points: [
      "Last 20, last 50 or every match, one click apart",
      "Kills, damage and placement match by match, with wins marked",
      "Your go-to weapons: kills, average distance and headshots",
      "Results by map, your best match and your longest kill",
    ],
    keyNote: "API keys are free at developer.pubg.com, and the first-run setup walks you through it. Arcade and custom matches have no official data, so they're not counted.",
    panelLabel: "Example of the KillCam stats page",
    page: "Stats",
    range: (n) => `Last ${n}`,
    tiles: {
      matches: "Matches",
      matchesSub: (w, r) => `${w} wins · ${r} win rate`,
      kills: "Kills per match",
      killsSub: (k, n) => `${k} kills · ${n} knocks`,
      kd: "K/D",
      kdSub: (d) => `${d} deaths`,
      damage: "Damage per match",
      damageSub: (t) => `${t} total`,
      top10: "Top 10 rate",
      top10Sub: (n) => `${n} top-10 finishes`,
      heads: "Headshot rate",
      headsSub: (n) => `${n} headshot kills`,
    },
    perMatch: (m) => `${m} per match`,
    metrics: { kills: "Kills", damage: "Damage", place: "Placement" },
    winLegend: "Win",
    weapons: "Top weapons",
    weaponSub: (d, h) => `avg ${d} m${h ? ` · ${h} headshots` : ""}`,
    maps: { erangel: "Erangel", miramar: "Miramar", taego: "Taego", vikendi: "Vikendi", deston: "Deston", rondo: "Rondo" },
    sample: "Example data",
  },
  shots: {
    match: "Match view: timeline, highlight list and export options",
    home: "Overview: recent matches and recording status",
    mini: "The in-game mini window",
  },
  install: {
    title: "Install",
    steps: [
      { title: "Download the installer", body: "Use the download button above, or grab KillCam_x.x.x_x64-setup.exe from GitHub Releases." },
      { title: "Run it", body: "No admin rights needed. FFmpeg is bundled, so there's nothing else to install." },
      { title: "If Windows blocks it", body: "Click “More info”, then “Run anyway”. KillCam is a free personal project without a paid Microsoft code-signing certificate. All the source code is public on GitHub if you'd like to check it." },
      { title: "Follow the setup", body: "The first launch walks you through display, quality, audio sources and where to save recordings, then runs a quick test to make sure you don't drop frames." },
    ],
    after: "New versions show up inside KillCam. One click installs them; you won't need to come back here.",
    smart: {
      heading: "Windows protected your PC",
      text: "Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.",
      more: "More info",
      run: "Run anyway",
      dontRun: "Don't run",
      app: "App",
      publisher: "Publisher",
      unknown: "Unknown publisher",
    },
  },
  reqs: {
    title: "Requirements",
    rows: [
      ["System", "Windows 10 (2004 or later) or Windows 11, 64-bit"],
      ["Graphics", "NVIDIA GPU with NVENC (GTX 10 series or newer). AMD may work but hasn't been tested"],
      ["Game", "PUBG on Steam"],
      ["Screen detection", "Simplified Chinese game language with the default HUD, for now"],
      ["App language", "The app itself is in Chinese for now"],
    ],
  },
  faq: {
    title: "FAQ",
    more: "Didn't find your answer? Ask on GitHub Issues",
    items: [
      {
        q: "Can this get me banned?",
        a: "KillCam doesn't inject into the game, read or write game memory, or change any game files. It records the same way OBS display capture does: Windows' own screen duplication for video, Windows audio APIs for sound, plus the log files PUBG writes locally and PUBG's public API. That said, only the game's publisher decides what anti-cheat allows, so no one can guarantee it.",
      },
      {
        q: "Will it cost me frames?",
        a: "Recording uses a little GPU, about the same as OBS display capture. Encoding runs on the GPU's separate NVENC chip, not the part rendering your game, and cutting highlights only copies video data, at the lowest priority. If frames are tight, drop the recording frame rate from 60 to 30 in Settings → Quality.",
      },
      {
        q: "Do I need a PUBG API key?",
        a: "No. Without one, KillCam still finds kills, knocks, deaths and wins from the screen and cuts highlights. With one, regular matches also get map, placement, damage, weapon, distance and headshots, with more precise timing. Keys are free at developer.pubg.com, and the setup shows you how.",
      },
      {
        q: "How soon are my highlights ready?",
        a: "You don't need to close the game. When a match ends (a win, shortly after you're eliminated, or when the next match starts), its highlights are cut in the background and waiting when you're back in the lobby. Cutting only copies video data without re-encoding, at the lowest priority, so it doesn't affect the game. With a PUBG API key, regular matches are cut from screen detection first; when the official data arrives a few minutes later, map, placement, damage and kill details are filled in automatically.",
      },
      {
        q: "I can't see the mini window, or it covers the game",
        a: "Use borderless windowed mode so the mini window can sit on top of the game; in fullscreen the game covers it. With a second monitor you can drag it there and it remembers the spot. Turn it off under Settings → Startup & in-game if you don't need it.",
      },
      {
        q: "Where are recordings and settings stored? How do I uninstall?",
        a: "Recordings go to the folder you chose during setup, and settings live in %APPDATA%\\com.jkeroro.killcam. Uninstall from Windows Settings → Apps. Your recordings folder is left alone; delete it yourself if you want.",
      },
    ],
  },
  privacy: {
    title: "Your recordings stay on your PC",
    items: [
      { title: "Nothing is uploaded", body: "Recordings, screenshots and settings stay on your own PC. KillCam has no server and collects no usage data." },
      { title: "Only two connections", body: "PUBG's official API to look up your own matches when you add a key, and GitHub Releases to check for updates." },
      { title: "Hands off the game", body: "No injection, no reading or writing game memory, no changes to game files." },
      { title: "Open source", body: "All of the code is on GitHub under the MIT license. Read it or build it yourself." },
    ],
  },
  cta: {
    title: "Install it before your next drop.",
    sub: "Setup takes a minute, and the first launch walks you through everything.",
  },
  footer: {
    license: "MIT license",
    issues: "Report a problem",
    releases: "All releases",
    by: "Made by Jkeroro. KillCam is a personal project, not affiliated with KRAFTON or PUBG.",
  },
  changelog: {
    title: "Changelog",
    intro: "Every version is published on GitHub Releases. If KillCam is already installed, it will offer the update itself.",
    latest: "Latest",
    download: "Download installer",
    noNotes: "No release notes for this version.",
    unavailable: "The release list can't be loaded right now. You can see every version on GitHub.",
    allOnGithub: "See all releases on GitHub",
    back: "Back to home",
  },
};

export const DICTS: Record<Locale, Dict> = { zh, en };
export const getDict = (l: Locale) => DICTS[l];
