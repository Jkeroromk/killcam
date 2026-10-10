import { useEffect, useMemo, useState } from "react";
import { Check, CheckSquare, Crosshair, RefreshCw, Skull, Star, Film, Trash2 } from "lucide-react";
import { api, fileUrl, joinPath, type GameId, type MatchRecord } from "../lib/api";
import { GameSwitch } from "../components/GameSwitch";
import { clock, isLol, when } from "../lib/format";
import { Button, Spinner, Tape } from "../components/ui";
import { label, plural, t } from "../lib/i18n";

// champion portraits are downloaded once and kept on disk
const champCache = new Map<string, Promise<string | null>>();
function useChampionIcon(key: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    let p = champCache.get(key);
    if (!p) {
      p = api.championIcon(key).catch(() => null);
      champCache.set(key, p);
    }
    p.then((path) => live && setSrc(path ? fileUrl(path) : null));
    return () => {
      live = false;
    };
  }, [key]);
  return src;
}

/** Round champion portrait; falls back to the first letter when offline. */
export function ChampIcon(props: { k: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const src = useChampionIcon(props.k);
  const size = props.size ?? 22;
  return broken || !src ? (
    <span className="champ champ-fallback" style={{ width: size, height: size }}>
      {props.name.slice(0, 1)}
    </span>
  ) : (
    <img className="champ" src={src} alt={props.name} width={size} height={size} onError={() => setBroken(true)} />
  );
}

const MULTI = ["", "", "双杀", "三杀", "四杀", "五杀"];

function LolCard(props: { m: MatchRecord; onOpen: () => void; onFavorite?: (v: boolean) => void }) {
  const m = props.m;
  const l = m.lol;
  const kills = l?.kills ?? m.events.filter((e) => e.kind === "kill").length;
  const deaths = l?.deaths ?? m.events.filter((e) => e.kind === "death").length;
  const assists = l?.assists ?? m.events.filter((e) => e.kind === "assist").length;
  const mins = (l?.gameLengthS || m.durationS) / 60;
  return (
    <div className="mcard" role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(e) => e.key === "Enter" && props.onOpen()}>
      <div className="mcard-thumb">
        {m.thumbnail ? <img src={fileUrl(joinPath(m.thumbDir, m.thumbnail))} alt="" loading="lazy" /> : null}
        <div className="mcard-top">
          {l?.win != null && <span className={"place" + (l.win ? " is-win" : "")}>{l.win ? t("胜利", "Victory") : t("失败", "Defeat")}</span>}
          {l && l.bestMultikill >= 3 && <span className="chip">{label(MULTI[Math.min(l.bestMultikill, 5)])}</span>}
          {props.onFavorite && (
            <button
              type="button"
              className={"fav" + (m.favorite ? " is-on" : "")}
              title={m.favorite ? t("取消收藏", "Remove from favorites") : t("收藏（不会被自动清理）", "Favorite (never auto-deleted)")}
              onClick={(e) => {
                e.stopPropagation();
                props.onFavorite?.(!m.favorite);
              }}
            >
              <Star size={15} />
            </button>
          )}
        </div>
        <div className="mcard-bottom">
          <span className="chip k-kill" title={t("击杀 / 阵亡 / 助攻", "Kills / Deaths / Assists")}>
            <Skull strokeWidth={2.4} />{" "}
            <b>
              {kills}/{deaths}/{assists}
            </b>
          </span>
          <span className="chip">
            <Film strokeWidth={2.4} /> {m.highlights.length}
          </span>
          <span className="chip mcard-dur">{clock(m.durationS)}</span>
        </div>
      </div>
      <div className="mcard-body">
        <div className="mcard-title">
          {l?.champion ? <ChampIcon k={l.championKey} name={l.champion} /> : null}
          <b>{l?.champion || label(m.mapLabel)}</b>
          {m.gameMode && <span className="tag">{label(m.gameMode)}</span>}
        </div>
        <div className="mcard-meta">
          <span>{when(m.createdAtMs)}</span>
          {l && l.cs > 0 && <span title={mins > 1 ? t(`每分钟 ${(l.cs / mins).toFixed(1)}`, `${(l.cs / mins).toFixed(1)} per minute`) : undefined}>· {t(`${l.cs} 补刀`, `${l.cs} CS`)}</span>}
          {l?.damage ? <span>· {t(`${l.damage.toLocaleString()} 伤害`, `${l.damage.toLocaleString()} damage`)}</span> : null}
          {!m.video && <span>· {t("仅高光片段", "Highlights only")}</span>}
        </div>
        <Tape duration={m.durationS} events={m.events} highlights={m.highlights} />
      </div>
    </div>
  );
}

export function MatchCard(props: { m: MatchRecord; onOpen: () => void; onFavorite?: (v: boolean) => void }) {
  if (isLol(props.m)) return <LolCard {...props} />;
  const m = props.m;
  const st = m.stats;
  const won = st?.place === 1;
  const kills = st?.kills ?? m.events.filter((e) => e.kind === "kill").length;
  const knocks = st?.knocks ?? m.events.filter((e) => e.kind === "knock").length;
  return (
    <div className="mcard" role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(e) => e.key === "Enter" && props.onOpen()}>
      <div className="mcard-thumb">
        {m.thumbnail ? <img src={fileUrl(joinPath(m.thumbDir, m.thumbnail))} alt="" loading="lazy" /> : null}
        <div className="mcard-top">
          {st && st.place > 0 && <span className={"place" + (won ? " is-win" : "")}>#{st.place}</span>}
          {won && <span className="chip">{t("吃鸡", "Chicken Dinner")}</span>}
          {props.onFavorite && (
            <button
              type="button"
              className={"fav" + (m.favorite ? " is-on" : "")}
              title={m.favorite ? t("取消收藏", "Remove from favorites") : t("收藏（不会被自动清理）", "Favorite (never auto-deleted)")}
              onClick={(e) => {
                e.stopPropagation();
                props.onFavorite?.(!m.favorite);
              }}
            >
              <Star size={15} />
            </button>
          )}
        </div>
        <div className="mcard-bottom">
          <span className="chip k-kill">
            <Skull strokeWidth={2.4} /> <b>{kills}</b>
          </span>
          <span className="chip k-knock">
            <Crosshair strokeWidth={2.4} /> <b>{knocks}</b>
          </span>
          <span className="chip">
            <Film strokeWidth={2.4} /> {m.highlights.length}
          </span>
          <span className="chip mcard-dur">{clock(m.durationS)}</span>
        </div>
      </div>
      <div className="mcard-body">
        <div className="mcard-title">
          <b>{label(m.mapLabel)}</b>
          {m.gameMode && <span className="tag">{label(m.gameMode)}</span>}
          {m.pendingApi && (
            <span
              className="tag tag-pending"
              title={t("高光已经可以看了；PUBG 官方数据到了会自动补上地图、排名和击杀详情", "Highlights are ready to watch. Map, place and kill details are filled in when PUBG's official data arrives")}
            >
              {t("等官方数据", "Waiting for official data")}
            </span>
          )}
        </div>
        <div className="mcard-meta">
          <span>{when(m.createdAtMs)}</span>
          {st && st.damage > 0 && <span>· {t(`${Math.round(st.damage)} 伤害`, `${Math.round(st.damage)} damage`)}</span>}
          {!m.video && <span>· {t("仅高光片段", "Highlights only")}</span>}
        </div>
        <Tape duration={m.durationS} events={m.events} highlights={m.highlights} />
      </div>
    </div>
  );
}

type Filter = "all" | "win" | "fav" | "kills";
const filters = (): { value: Filter; label: string }[] => [
  { value: "all", label: t("全部", "All") },
  { value: "win", label: t("获胜", "Wins") },
  { value: "fav", label: t("收藏", "Favorites") },
  { value: "kills", label: t("击杀最多", "Most kills") },
];

const killsOf = (m: MatchRecord) => (isLol(m) ? m.lol?.kills : m.stats?.kills) ?? m.events.filter((e) => e.kind === "kill").length;

export default function Library(props: { game: GameId; setGame: (g: GameId) => void; libVersion: number; openMatch: (id: string) => void }) {
  const [list, setList] = useState<MatchRecord[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // picking several recordings to delete at once
  const [picking, setPicking] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [lastPick, setLastPick] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = () => api.listMatches().then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [props.libVersion]);

  const shown = useMemo(() => {
    if (!list) return null;
    const pool = list.filter((m) => (props.game === "lol") === isLol(m));
    switch (filter) {
      case "fav":
        return pool.filter((m) => m.favorite);
      case "win":
        return pool.filter((m) => (isLol(m) ? m.lol?.win === true : m.stats?.place === 1));
      case "kills":
        return [...pool].sort((a, b) => killsOf(b) - killsOf(a));
      default:
        return pool;
    }
  }, [list, filter, props.game]);

  // a different game or filter starts a new selection
  useEffect(() => {
    setSel(new Set());
    setLastPick(null);
    setConfirm(false);
  }, [props.game, filter]);

  const stopPicking = () => {
    setPicking(false);
    setSel(new Set());
    setLastPick(null);
    setConfirm(false);
  };

  // shift-click picks everything between the last pick and this one
  const pick = (i: number, range: boolean) => {
    if (!shown) return;
    const n = new Set(sel);
    const id = shown[i].id;
    if (range && lastPick != null) {
      const [a, b] = lastPick < i ? [lastPick, i] : [i, lastPick];
      for (let k = a; k <= b; k++) n.add(shown[k].id);
    } else if (n.has(id)) {
      n.delete(id);
    } else {
      n.add(id);
    }
    setSel(n);
    setLastPick(i);
    setConfirm(false);
  };

  const allPicked = !!shown && shown.length > 0 && shown.every((m) => sel.has(m.id));
  const favPicked = (list ?? []).filter((m) => sel.has(m.id) && m.favorite).length;

  const removePicked = async () => {
    setDeleting(true);
    try {
      await api.deleteMatches([...sel]);
    } finally {
      setDeleting(false);
      stopPicking();
      load();
    }
  };

  const fav = async (m: MatchRecord, v: boolean) => {
    await api.setFavorite(m.id, v);
    setList((l) => l?.map((x) => (x.id === m.id ? { ...x, favorite: v } : x)) ?? null);
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>
          {t("录像库", "Library")} {shown && <span className="count">{shown.length}</span>}
        </h1>
        <GameSwitch value={props.game} onChange={props.setGame} />
        <div className="pills">
          {filters().map((f) => (
            <button key={f.value} type="button" className={"pill" + (filter === f.value ? " is-on" : "")} onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        {!picking && (
          <>
            <Button small kind="ghost" onClick={() => setPicking(true)} disabled={!shown || shown.length === 0}>
              <CheckSquare size={14} /> {t("选择", "Select")}
            </Button>
            <Button small kind="ghost" onClick={() => api.syncNow(false).then(() => setTimeout(load, 3000))}>
              <RefreshCw size={14} /> {t("立即同步", "Sync now")}
            </Button>
          </>
        )}
      </header>
      {picking && (
        <div className="pickbar">
          <b>{t(`已选 ${sel.size} 局`, `${sel.size} selected`)}</b>
          <button type="button" className="linkbtn" onClick={() => setSel(allPicked ? new Set() : new Set((shown ?? []).map((m) => m.id)))}>
            {allPicked ? t("取消全选", "Select none") : t("全选", "Select all")}
          </button>
          <span className="muted small">{t("按住 Shift 点击可以连选", "Shift-click to select a range")}</span>
          <span className="grow" />
          {confirm ? (
            <Button kind="danger" small onClick={removePicked} disabled={deleting}>
              {deleting ? <Spinner /> : <Trash2 size={14} />}{" "}
              {t(
                `确认删除 ${sel.size} 局${favPicked ? `（含 ${favPicked} 个收藏）` : ""}`,
                `Delete ${sel.size} ${plural(sel.size, "game", "games")}${favPicked ? ` (incl. ${favPicked} ${plural(favPicked, "favorite", "favorites")})` : ""}`,
              )}
            </Button>
          ) : (
            <Button kind="ghost" small onClick={() => setConfirm(true)} disabled={sel.size === 0}>
              <Trash2 size={14} /> {t("删除", "Delete")}
            </Button>
          )}
          <Button kind="ghost" small onClick={stopPicking} disabled={deleting}>
            {t("完成", "Done")}
          </Button>
        </div>
      )}
      {!shown ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <p className="empty">
          {filter === "all"
            ? props.game === "lol"
              ? t("还没有英雄联盟录像。进入一局英雄联盟就会自动开始录，结束后很快出现在这里。", "No League of Legends recordings yet. Recording starts automatically when a game begins; it shows up here soon after it ends.")
              : t("还没有 PUBG 录像。打开 PUBG 打一局，结束后很快就会出现在这里。", "No PUBG recordings yet. Play a match and it shows up here soon after it ends.")
            : t("这个分类下没有录像。", "No recordings in this category.")}
        </p>
      ) : (
        <div className={"cards" + (picking ? " is-picking" : "")}>
          {shown.map((m, i) => (
            <div
              key={m.id}
              className={"pickable" + (sel.has(m.id) ? " is-picked" : "")}
              onClickCapture={(e) => {
                if (!picking) return;
                // while picking, a click selects instead of opening
                e.stopPropagation();
                e.preventDefault();
                pick(i, e.shiftKey);
              }}
            >
              <MatchCard m={m} onOpen={() => props.openMatch(m.id)} onFavorite={picking ? undefined : (v) => fav(m, v)} />
              {picking && <span className="pick-check">{sel.has(m.id) && <Check size={15} strokeWidth={3} />}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
