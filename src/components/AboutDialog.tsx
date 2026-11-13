import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, X } from "lucide-react";
import { api, errText, type ReleaseNote } from "../lib/api";
import { shortVersion } from "../lib/format";
import { t } from "../lib/i18n";
import { Button, Spinner } from "./ui";
import { Notes } from "./UpdateCard";

const RELEASES = "https://github.com/Jkeroromk/kerocam/releases";
const ISSUES = "https://github.com/Jkeroromk/kerocam/issues";

/** What KeroCam does, in a few lines: the same list as the README. */
function features(): [string, string][] {
  return [
    [t("自动录制", "Records by itself"), t("PUBG 一打开、英雄联盟一进对局就开始录，打完就停，不用按任何键。", "Starts when PUBG opens or a League match begins, stops when it ends. No keys to press.")],
    [t("自动找高光", "Finds the highlights"), t("PUBG 读屏识别击杀、击倒、吃鸡，填了 API Key 还有官方数据；英雄联盟用游戏的实时数据，多杀、团灭、抢龙都会标出来。", "PUBG kills, knocks and wins from the screen (and the official API with a key); League multikills, aces and steals from the game's live data.")],
    [t("一局一条记录", "One record per match"), t("地图、模式、排名、KDA、伤害，整局时间轴点哪看哪；PUBG 还有跑图路线和击杀地图。", "Map, mode, placement, KDA and damage, with a timeline to jump anywhere; PUBG also gets the route and kill map.")],
    [t("个人数据", "Your stats"), t("PUBG 场均击杀、K/D、武器和地图数据；英雄联盟胜率、KDA 和常用英雄。", "PUBG kills, K/D, weapons and maps; League win rate, KDA and most played champions.")],
    [t("剪辑", "Editor"), t("时间线剪辑：拆分、拖动、撤销，「去掉空闲」只留打架；选一首歌一键卡点，转场、音乐退场都能调。", "A timeline editor: split, move, undo, \"cut the waiting\"; pick a song for a beat-synced cut with transitions and music pulls.")],
    [t("导出", "Export"), t("原比例 / 16:9 / 竖屏，原画质到 720p，游戏声音和麦克风可以分轨。", "Source / 16:9 / vertical, original to 720p, game and mic on separate tracks if you like.")],
    [t("省空间", "Saves space"), t("可以只留高光；满了自动清理最旧的；旧录像空闲时转成 AV1，体积约减半。", "Keep only highlights; oldest go first when full; old videos turn into AV1 when idle, about half the size.")],
    [t("F9 手动标记", "F9 to mark"), t("觉得刚才那波精彩，按一下 F9 就会留下来。", "Press F9 after a good moment and it's kept.")],
  ];
}

/** 关于 KeroCam: the version, what this version changed (and the ones before),
 *  and what the app does. `updated` opens it right after an update. */
export function AboutDialog(props: { version: string | undefined; updated?: boolean; onClose: () => void }) {
  const current = shortVersion(props.version);
  const [notes, setNotes] = useState<ReleaseNote[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [older, setOlder] = useState(false);

  useEffect(() => {
    api.releaseNotes().then(setNotes).catch((e) => setErr(errText(e)));
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props.onClose]);

  const mine = notes?.find((n) => shortVersion(n.version) === current) ?? null;
  const before = (notes ?? []).filter((n) => n !== mine && newer(current, n.version));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header>
          <span className="brand-mark about-mark" aria-hidden />
          <div className="about-title">
            <h2 id="about-title">{props.updated ? t(`已更新到 v${current}`, `Updated to v${current}`) : "KeroCam"}</h2>
            <span className="muted small">
              {props.updated ? "KeroCam" : `v${current}`}
              {mine?.date ? ` · ${mine.date}` : ""}
            </span>
          </div>
          <span className="grow" />
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label={t("关闭", "Close")}>
            <X size={16} />
          </button>
        </header>

        <section className="update-notes-box">
          <h3>{t(`v${current} 更新了什么`, `What's new in v${current}`)}</h3>
          {mine?.notes.trim() ? (
            <Notes text={mine.notes} />
          ) : notes || err ? (
            <p className="muted small about-empty">
              {err ? t("现在读不到更新记录（可能没联网）。", "Can't load the release notes right now (offline?).") : t("这一版没有写更新说明。", "No notes for this version.")}
            </p>
          ) : (
            <div className="about-loading">
              <Spinner /> <span className="muted small">{t("正在读取更新记录…", "Loading release notes…")}</span>
            </div>
          )}
        </section>

        {before.length > 0 && (
          <section className="about-older">
            <button type="button" className="about-older-toggle" onClick={() => setOlder((v) => !v)} aria-expanded={older}>
              <ChevronDown size={14} className={older ? "is-open" : ""} />
              {t(`以前的版本（${before.length}）`, `Earlier versions (${before.length})`)}
            </button>
            {older && (
              <div className="about-older-list">
                {before.map((n) => (
                  <div key={n.version} className="about-release">
                    <h4>
                      v{shortVersion(n.version)} <span className="muted small">{n.date}</span>
                    </h4>
                    {n.notes.trim() ? <Notes text={n.notes} /> : <p className="muted small">{t("没有写更新说明。", "No notes.")}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {!props.updated && (
          <section className="about-features">
            <h3>{t("KeroCam 能做什么", "What KeroCam does")}</h3>
            <dl>
              {features().map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <footer>
          <Button kind="ghost" small onClick={() => api.openUrl(ISSUES)}>
            {t("反馈问题", "Report a problem")}
          </Button>
          <Button kind="ghost" small onClick={() => api.openUrl(RELEASES)}>
            <ExternalLink size={13} /> {t("所有版本", "All releases")}
          </Button>
          <span className="grow" />
          <Button kind="primary" small onClick={props.onClose}>
            {t("知道了", "Got it")}
          </Button>
        </footer>
      </div>
    </div>
  );
}

/** a is a later version than b ("2.2" vs "2.1.0") */
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

const SEEN = "kc.seenVersion";

/** The version the user last opened, and remember this one. Null on the very
 *  first run (nothing to announce then). */
export function lastSeenVersion(current: string): string | null {
  try {
    const seen = localStorage.getItem(SEEN);
    localStorage.setItem(SEEN, current);
    return seen;
  } catch {
    return null;
  }
}
