import { useEffect, useMemo, useState } from "react";
import { Crosshair, RefreshCw, Skull, Star, Film } from "lucide-react";
import { api, fileUrl, joinPath, type GameId, type MatchRecord } from "../lib/api";
import { GameSwitch } from "../components/GameSwitch";
import { clock, isLol, when } from "../lib/format";
import { Button, Spinner, Tape } from "../components/ui";

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
          {l?.win != null && <span className={"place" + (l.win ? " is-win" : "")}>{l.win ? "胜利" : "失败"}</span>}
          {l && l.bestMultikill >= 3 && <span className="chip">{MULTI[Math.min(l.bestMultikill, 5)]}</span>}
          {props.onFavorite && (
            <button
              type="button"
              className={"fav" + (m.favorite ? " is-on" : "")}
              title={m.favorite ? "取消收藏" : "收藏（不会被自动清理）"}
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
          <span className="chip k-kill" title="击杀 / 阵亡 / 助攻">
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
          <b>{l?.champion || m.mapLabel}</b>
          {m.gameMode && <span className="tag">{m.gameMode}</span>}
        </div>
        <div className="mcard-meta">
          <span>{when(m.createdAtMs)}</span>
          {l && l.cs > 0 && <span title={mins > 1 ? `每分钟 ${(l.cs / mins).toFixed(1)}` : undefined}>· {l.cs} 补刀</span>}
          {l?.damage ? <span>· {l.damage.toLocaleString()} 伤害</span> : null}
          {!m.video && <span>· 仅高光片段</span>}
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
          {won && <span className="chip">吃鸡</span>}
          {props.onFavorite && (
            <button
              type="button"
              className={"fav" + (m.favorite ? " is-on" : "")}
              title={m.favorite ? "取消收藏" : "收藏（不会被自动清理）"}
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
          <b>{m.mapLabel}</b>
          {m.gameMode && <span className="tag">{m.gameMode}</span>}
          {m.pendingApi && (
            <span className="tag tag-pending" title="高光已经可以看了；PUBG 官方数据到了会自动补上地图、排名和击杀详情">
              等官方数据
            </span>
          )}
        </div>
        <div className="mcard-meta">
          <span>{when(m.createdAtMs)}</span>
          {st && st.damage > 0 && <span>· {Math.round(st.damage)} 伤害</span>}
          {!m.video && <span>· 仅高光片段</span>}
        </div>
        <Tape duration={m.durationS} events={m.events} highlights={m.highlights} />
      </div>
    </div>
  );
}

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "win", label: "获胜" },
  { value: "fav", label: "收藏" },
  { value: "kills", label: "击杀最多" },
] as const;

const killsOf = (m: MatchRecord) => (isLol(m) ? m.lol?.kills : m.stats?.kills) ?? m.events.filter((e) => e.kind === "kill").length;

export default function Library(props: { game: GameId; setGame: (g: GameId) => void; libVersion: number; openMatch: (id: string) => void }) {
  const [list, setList] = useState<MatchRecord[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");

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

  const fav = async (m: MatchRecord, v: boolean) => {
    await api.setFavorite(m.id, v);
    setList((l) => l?.map((x) => (x.id === m.id ? { ...x, favorite: v } : x)) ?? null);
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>
          录像库 {shown && <span className="count">{shown.length}</span>}
        </h1>
        <GameSwitch value={props.game} onChange={props.setGame} />
        <div className="pills">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" className={"pill" + (filter === f.value ? " is-on" : "")} onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <Button small kind="ghost" onClick={() => api.syncNow(false).then(() => setTimeout(load, 3000))}>
          <RefreshCw size={14} /> 立即同步
        </Button>
      </header>
      {!shown ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <p className="empty">{filter === "all" ? props.game === "lol" ? "还没有英雄联盟录像。进入一局英雄联盟就会自动开始录，结束后很快出现在这里。" : "还没有 PUBG 录像。打开 PUBG 打一局，结束后很快就会出现在这里。" : "这个分类下没有录像。"}</p>
      ) : (
        <div className="cards">
          {shown.map((m) => (
            <MatchCard key={m.id} m={m} onOpen={() => props.openMatch(m.id)} onFavorite={(v) => fav(m, v)} />
          ))}
        </div>
      )}
    </div>
  );
}
