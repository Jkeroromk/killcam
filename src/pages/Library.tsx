import { useEffect, useMemo, useState } from "react";
import { Crosshair, RefreshCw, Skull, Star, Film } from "lucide-react";
import { api, fileUrl, joinPath, type MatchRecord } from "../lib/api";
import { clock, when } from "../lib/format";
import { Button, Spinner, Tape } from "../components/ui";

export function MatchCard(props: { m: MatchRecord; onOpen: () => void; onFavorite?: (v: boolean) => void }) {
  const m = props.m;
  const st = m.stats;
  const won = st?.place === 1;
  const kills = st?.kills ?? m.events.filter((e) => e.kind === "kill").length;
  const knocks = st?.knocks ?? m.events.filter((e) => e.kind === "knock").length;
  return (
    <div className="mcard" role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(e) => e.key === "Enter" && props.onOpen()}>
      <div className="mcard-thumb">
        {m.thumbnail ? <img src={fileUrl(joinPath(m.dir, m.thumbnail))} alt="" loading="lazy" /> : null}
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
  { value: "win", label: "吃鸡" },
  { value: "fav", label: "收藏" },
  { value: "kills", label: "击杀最多" },
] as const;

export default function Library(props: { libVersion: number; openMatch: (id: string) => void }) {
  const [list, setList] = useState<MatchRecord[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");

  const load = () => api.listMatches().then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [props.libVersion]);

  const shown = useMemo(() => {
    if (!list) return null;
    switch (filter) {
      case "fav":
        return list.filter((m) => m.favorite);
      case "win":
        return list.filter((m) => m.stats?.place === 1);
      case "kills":
        return [...list].sort((a, b) => (b.stats?.kills ?? 0) - (a.stats?.kills ?? 0));
      default:
        return list;
    }
  }, [list, filter]);

  const fav = async (m: MatchRecord, v: boolean) => {
    await api.setFavorite(m.id, v);
    setList((l) => l?.map((x) => (x.id === m.id ? { ...x, favorite: v } : x)) ?? null);
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>
          录像库 {list && <span className="count">{list.length}</span>}
        </h1>
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
        <p className="empty">{filter === "all" ? "还没有录像。打开 PUBG 打一局，结束后几分钟就会出现在这里。" : "这个分类下没有录像。"}</p>
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
