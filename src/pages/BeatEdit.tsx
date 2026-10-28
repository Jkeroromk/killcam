// 卡点成片 on the edit page: the song, the timeline the clips were arranged
// into, and a preview that plays the shots with the music.

import { useEffect, useRef, useState } from "react";
import { Music, Play, Square, Wand2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errText, fileUrl, type EditClipReq, type MusicMix } from "../lib/api";
import { clock } from "../lib/format";
import { label, t, title } from "../lib/i18n";
import type { Plan, Shot, TransStyle } from "../lib/beatcut";
import type { EditDoc } from "../lib/edit";
import { Button, Range, Segmented, Spinner, Toggle } from "../components/ui";

/** The export request for a plan. */
export function beatRequests(p: Plan): EditClipReq[] {
  return p.shots.map((s) => ({ matchId: s.item.matchId, start: s.start, end: s.end, captions: [], slow: [], transIn: s.transIn, transOut: s.transOut }));
}

export function beatMusic(p: Plan, doc: EditDoc): MusicMix | null {
  if (!doc.song) return null;
  return { path: doc.song.path, start: p.musicStart, volume: doc.musicVol, game: doc.gameVol, pulls: p.pulls };
}

const inPull = (p: Plan, t: number) => p.pulls.some(([a, b]) => t >= a - 0.4 && t < b);

/** Player + timeline: plays the shots one after another with the song. */
export function BeatPlayer(props: { plan: Plan | null; doc: EditDoc; missing: Set<string>; analyzing: boolean }) {
  const { plan: p, doc } = props;
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [out, setOut] = useState(0);
  const pending = useRef<{ local: number; play: boolean } | null>(null);
  const shot: Shot | null = p?.shots[Math.min(cur, (p?.shots.length ?? 1) - 1)] ?? null;

  // a new plan: back to the start
  useEffect(() => {
    setCur(0);
    setPlaying(false);
    setOut(0);
    audio.current?.pause();
    video.current?.pause();
  }, [p]);

  const levels = (o: number) => {
    const pulled = p ? inPull(p, o) : false;
    if (video.current) video.current.volume = pulled ? 1 : Math.max(0, Math.min(1, doc.gameVol));
    if (audio.current) audio.current.volume = pulled ? doc.musicVol * 0.08 : Math.max(0, Math.min(1, doc.musicVol));
  };

  const go = (i: number, play: boolean) => {
    if (!p) return;
    const s = p.shots[i];
    if (!s) return;
    setCur(i);
    setOut(s.outStart);
    const local = Math.max(0, s.start - s.item.fileStart);
    const v = video.current;
    if (v && v.readyState >= 1 && v.dataset.file === s.item.file) {
      v.currentTime = local;
      if (play) v.play().catch(() => {});
      else v.pause();
    } else {
      pending.current = { local, play };
    }
    const a = audio.current;
    if (a) {
      // the song follows the shots: re-synced at every cut
      a.currentTime = p.musicStart + s.outStart;
      if (play) a.play().catch(() => {});
      else a.pause();
    }
    levels(s.outStart);
  };

  const stop = () => {
    setPlaying(false);
    video.current?.pause();
    audio.current?.pause();
  };

  if (props.analyzing) {
    return (
      <div className="player">
        <div className="player-frame">
          <div className="player-empty">
            <span className="loading-row">
              <Spinner /> {t("正在分析这首歌的节拍…", "Finding the song's beats…")}
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (!doc.song || !p) {
    return (
      <div className="player">
        <div className="player-frame">
          <div className="player-empty bc-empty">
            <Music size={26} />
            <p>{doc.song ? t("素材里没有能用的片段。", "None of the clips can be used.") : t("先在右边选一首歌。", "Pick a song on the right first.")}</p>
            <p className="muted small">
              {t(
                "选好歌后会自动排好：开头几个最狠的瞬间跟着鼓点快切，最好的一波放在歌曲高潮，击杀落在重拍上；整段对枪不剪断，换局才用转场。",
                "Once there's a song, it's arranged for you: the best moments open with quick cuts on the drums, the best fight starts as the song kicks in with the kill on the beat, whole fights stay uncut, and transitions only come when the match changes.",
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const L = p.length;
  const pct = (x: number) => `${(Math.max(0, Math.min(L, x)) / L) * 100}%`;
  const missingShot = shot ? props.missing.has(shot.item.matchId) : false;

  return (
    <div className="player">
      <div className="player-frame ed-frame">
        {shot && !missingShot ? (
          <video
            key={shot.item.file}
            ref={video}
            data-file={shot.item.file}
            src={fileUrl(shot.item.file)}
            onLoadedMetadata={(e) => {
              const q = pending.current;
              if (q) {
                e.currentTarget.currentTime = q.local;
                if (q.play) e.currentTarget.play().catch(() => {});
                pending.current = null;
              }
              levels(out);
            }}
            onClick={() => (playing ? stop() : (setPlaying(true), go(cur, true)))}
            onTimeUpdate={(e) => {
              if (!shot) return;
              const g = shot.item.fileStart + e.currentTarget.currentTime;
              const o = shot.outStart + (g - shot.start);
              setOut(o);
              levels(o);
              if (g >= shot.end - 0.02) {
                if (playing && cur + 1 < p.shots.length) go(cur + 1, true);
                else stop();
              }
            }}
          />
        ) : (
          <div className="player-empty">{t("这段所在的录像已经被删掉了", "This clip's recording has been deleted")}</div>
        )}
        {doc.opts.aspect === "9:16" && <div className="ed-crop" aria-hidden />}
      </div>
      <audio ref={audio} src={fileUrl(doc.song.path)} preload="auto" />

      <div className="export bc-panel">
        <div className="export-row">
          {playing ? (
            <Button small kind="primary" onClick={stop}>
              <Square size={13} /> {t("停止", "Stop")}
            </Button>
          ) : (
            <Button
              small
              kind="primary"
              onClick={() => {
                setPlaying(true);
                go(0, true);
              }}
            >
              <Play size={14} /> {t("从头预览", "Preview from the start")}
            </Button>
          )}
          <span className="mono muted small">
            {clock(out)} / {clock(L)}
          </span>
          <span className="grow" />
          <span className="bc-legend">
            <i className="is-hook" /> {t("开场快切", "Quick-cut opening")}
            <i className="is-main" /> {t("完整对枪", "Whole fights")}
            <i className="is-pull" /> {t("音乐抽离", "Music steps back")}
          </span>
        </div>
        <div
          className="bc-track"
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * L;
            const i = p.shots.findIndex((s) => x >= s.outStart && x < s.outStart + (s.end - s.start));
            if (i >= 0) {
              const s = p.shots[i];
              setCur(i);
              const local = Math.max(0, s.start + (x - s.outStart) - s.item.fileStart);
              const v = video.current;
              if (v && v.dataset.file === s.item.file && v.readyState >= 1) v.currentTime = local;
              else pending.current = { local, play: playing };
              if (audio.current) audio.current.currentTime = p.musicStart + x;
              setOut(x);
            }
          }}
        >
          <div className="bc-beats">
            {p.downbeats.map((b, i) => (
              <span key={i} style={{ left: pct(b) }} />
            ))}
          </div>
          {p.pulls.map(([a, b], i) => (
            <div key={i} className="bc-pull" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />
          ))}
          {p.shots.map((s, i) => (
            <div
              key={s.key}
              className={"bc-shot is-" + s.role + (i === cur ? " is-on" : "") + (props.missing.has(s.item.matchId) ? " is-missing" : "")}
              style={{ left: pct(s.outStart), width: `calc(${pct(s.outStart + (s.end - s.start))} - ${pct(s.outStart)})` }}
              title={`${title(s.item.title)} · ${label(s.item.mapLabel)} · ${clock(s.outStart)}`}
            >
              {s.item.thumb && s.role === "main" && <img src={fileUrl(s.item.thumb)} alt="" draggable={false} />}
              {s.transIn && <em className={"bc-tr is-" + s.transIn} />}
            </div>
          ))}
          <div className="bc-drop" style={{ left: pct(p.drop) }} title={t("歌曲高潮", "The song kicks in")} />
          <div className="ed-trim-head" style={{ left: pct(out) }} />
        </div>
        <div className="export-row muted small bc-stats">
          <span>
            {t(`${p.shots.length} 个镜头`, `${p.shots.length} shots`)} · {t(`成片 ${clock(L)}`, `${clock(L)} long`)}
          </span>
          <span>
            {t(`从歌曲 ${clock(p.musicStart)} 开始`, `song from ${clock(p.musicStart)}`)} · {t(`高潮在 ${clock(p.drop)}`, `kicks in at ${clock(p.drop)}`)}
          </span>
          {shot && (
            <span className="grow ellipsis" style={{ textAlign: "right" }}>
              {title(shot.item.title)} · {label(shot.item.mapLabel)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The song and how to cut. */
export function BeatSide(props: {
  doc: EditDoc;
  update: (d: EditDoc) => void;
  analyzing: boolean;
  setAnalyzing: (b: boolean) => void;
  onError: (e: string | null) => void;
}) {
  const { doc, update } = props;
  const pick = async () => {
    const f = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: t("音乐", "Music"), extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma"] }],
    });
    if (!f || Array.isArray(f)) return;
    props.onError(null);
    props.setAnalyzing(true);
    try {
      const info = await api.analyzeMusic(f);
      const name = f.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
      update({ ...doc, song: { path: f, name, info } });
    } catch (e) {
      props.onError(errText(e));
    } finally {
      props.setAnalyzing(false);
    }
  };
  const b = doc.beat;
  const setBeat = (x: Partial<typeof b>) => update({ ...doc, beat: { ...b, ...x } });
  return (
    <>
      <section className="ed-box">
        <h3>{t("音乐", "Music")}</h3>
        {doc.song ? (
          <div className="bc-song">
            <Music size={16} />
            <span className="ellipsis" title={doc.song.path}>
              {doc.song.name}
            </span>
            <span className="grow" />
            <span className="mono muted small">
              {Math.round(doc.song.info.bpm)} BPM · {clock(doc.song.info.duration)}
            </span>
          </div>
        ) : (
          <p className="muted small">{t("用你自己的歌（mp3、m4a、wav 等）。软件不自带音乐，发布到平台时注意版权。", "Use your own song (mp3, m4a, wav…). No music comes with the app; mind the rights when you post.")}</p>
        )}
        <Button small kind={doc.song ? "ghost" : "primary"} onClick={pick} disabled={props.analyzing}>
          <Music size={14} /> {doc.song ? t("换一首", "Change song") : t("选择音乐", "Pick a song")}
        </Button>
        {doc.song && (
          <>
            <div className="bc-vol">
              <span className="small">{t("音乐", "Music")}</span>
              <Range value={Math.round(doc.musicVol * 100)} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => update({ ...doc, musicVol: v / 100 })} />
            </div>
            <div className="bc-vol">
              <span className="small">{t("游戏声音", "Game sound")}</span>
              <Range value={Math.round(doc.gameVol * 100)} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => update({ ...doc, gameVol: v / 100 })} />
            </div>
          </>
        )}
      </section>
      <section className="ed-box">
        <h3>
          <Wand2 size={14} /> {t("成片", "Cut")}
        </h3>
        <span className="ed-fx-label">{t("长度", "Length")}</span>
        <Segmented
          value={b.length}
          onChange={(v) => setBeat({ length: v })}
          options={[
            { value: 30, label: t("30 秒", "30 s") },
            { value: 60, label: t("1 分钟", "1 min") },
            { value: 0, label: t("整首", "Whole song") },
          ]}
        />
        <span className="ed-fx-label">{t("换局转场", "Between matches")}</span>
        <Segmented
          value={b.trans}
          onChange={(v: TransStyle) => setBeat({ trans: v })}
          options={[
            { value: "mix", label: t("自动", "Auto") },
            { value: "cut", label: t("硬切", "Cut") },
            { value: "whip", label: t("甩镜", "Whip") },
            { value: "flash", label: t("闪白", "Flash") },
            { value: "black", label: t("黑场", "Black") },
          ]}
        />
        <div className="ed-fx">
          <Toggle checked={b.pull} onChange={(v) => setBeat({ pull: v })} label={t("高潮团战抽离音乐", "Drop the music for the big fight")} />
          <p className="muted small">
            {t("后面最激烈的一波打起来时音乐退下去、只留枪声，最后一个击杀时音乐重新砸进来。", "When the biggest later fight starts the music steps back to the gunfire, and slams back in on its last kill.")}
          </p>
        </div>
      </section>
    </>
  );
}
