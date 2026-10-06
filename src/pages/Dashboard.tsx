import { useEffect, useState } from "react";
import { Bookmark, Circle, Square, X, RefreshCw, Video, Gamepad2, Clock } from "lucide-react";
import { api, errText, type MatchRecord, type Settings, type Status, type StorageInfo } from "../lib/api";
import { bytes, clock, gameName } from "../lib/format";
import { Button, Spinner } from "../components/ui";
import { MatchCard } from "./Library";

export default function Dashboard(props: {
  status: Status | null;
  settings: Settings;
  libVersion: number;
  openMatch: (id: string) => void;
  openLibrary: () => void;
}) {
  const s = props.status;
  const [recent, setRecent] = useState<MatchRecord[] | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listMatches().then((m) => setRecent(m.slice(0, 6))).catch(() => setRecent([]));
    api.storageInfo().then(setStorage).catch(() => {});
  }, [props.libVersion]);

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (s?.recording) await api.stopRecording();
      else await api.startRecording();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const st = s?.stats;
  const fpsOk = !st || !s?.recording || st.reports < 4 || st.fps >= props.settings.video.fps * 0.95;
  const speedOk = !st || !s?.recording || st.reports < 4 || st.speed >= 0.95;

  return (
    <div className="page">
      <section className={"status" + (s?.recording ? " is-rec" : "")}>
        <div className="status-main">
          <div className="status-icon">{s?.recording ? <Video size={22} /> : s?.gameRunning ? <Gamepad2 size={22} /> : <Clock size={22} />}</div>
          <div>
            <div className="status-title">
              {s?.recording ? (
                <>
                  <span className="rec-dot big" />
                  {s.autoSession ? `正在录制 ${gameName(s.game)}` : "正在录制"}
                  <span className="status-clock">{clock(s.elapsedS)}</span>
                </>
              ) : s?.gameRunning ? (
                `${gameName(s.game)} 正在运行`
              ) : (
                "等待游戏启动"
              )}
            </div>
            <div className="status-sub">
              {s?.recording
                ? s.game === "lol"
                  ? `读取游戏数据中 · ${s.liveKills ?? 0}/${s.liveDeaths ?? 0}/${s.liveAssists ?? 0}`
                  : s.detector === "active"
                  ? `读屏识别中 · 已识别 ${s.detections} 个事件`
                  : "全程显卡录制，不占游戏帧数"
                : props.settings.autoRecord
                  ? "打开 PUBG 或英雄联盟会自动开始录制，关掉游戏自动结束"
                  : "自动录制已关闭，需要手动开始"}
            </div>
          </div>
        </div>
        <div className="status-actions">
          <Button kind="ghost" onClick={() => api.addMarker()} disabled={!s?.recording}>
            <Bookmark size={16} /> 标记
            {props.settings.hotkeys.highlight && <kbd>{props.settings.hotkeys.highlight}</kbd>}
          </Button>
          <Button kind={s?.recording ? "danger" : "primary"} onClick={toggle} disabled={busy}>
            {busy ? <Spinner /> : s?.recording ? <Square size={15} /> : <Circle size={15} />}
            {s?.recording ? "停止录制" : "开始录制"}
          </Button>
        </div>
        {s?.recording && st && (
          <div className="status-stats">
            <Stat label="录制帧率" value={st.fps.toFixed(0)} bad={!fpsOk} />
            <Stat label="编码速度" value={`${st.speed.toFixed(2)}×`} bad={!speedOk} />
            <Stat label="分辨率" value={s.width ? `${s.width}×${s.height}` : "–"} />
            <Stat label="已写入" value={bytes(st.sizeBytes)} />
            <Stat label="手动标记" value={String(s.markers)} />
            {s.detector === "active" && <Stat label="读屏识别" value={String(s.detections)} />}
          </div>
        )}
      </section>

      {(err || s?.lastError || (s?.warnings.length ?? 0) > 0 || (s?.notices.length ?? 0) > 0) && (
        <section className="notices">
          {err && <p className="warn-text">{err}</p>}
          {s?.lastError && <pre className="log">{s.lastError}</pre>}
          {s?.warnings.map((w) => (
            <p className="warn-text" key={w}>
              {w}
            </p>
          ))}
          {s?.notices.map((w) => (
            <p className="muted" key={w}>
              {w}
            </p>
          ))}
          <Button small kind="ghost" onClick={() => api.clearNotices()}>
            <X size={14} /> 清除
          </Button>
        </section>
      )}

      {s?.waitingMinutes != null && !s.processing && (
        <section className="processing is-wait">
          <span>
            高光已经按读屏先剪好了，可以直接看。PUBG 官方数据到了会自动补上地图、排名和击杀详情（最多还要 {s.waitingMinutes} 分钟）。
          </span>
          <span className="grow" />
          <Button small kind="ghost" onClick={() => api.syncNow(true)}>
            不用官方数据了
          </Button>
        </section>
      )}

      {s?.processing && (
        <section className="processing">
          <Spinner /> {s.processing}
        </section>
      )}

      <section className="block">
        <header className="block-head">
          <h2>最近的对局</h2>
          <span className="grow" />
          <Button small kind="ghost" onClick={() => api.syncNow(false)} title="立即从 PUBG 拉取最新对局">
            <RefreshCw size={14} /> 立即同步
          </Button>
          <Button small kind="ghost" onClick={props.openLibrary}>
            全部录像
          </Button>
        </header>
        {!recent ? (
          <Spinner />
        ) : recent.length === 0 ? (
          <p className="empty">
            还没有录像。打开 PUBG 或英雄联盟打一局，结束后这里就会出现带高光标记的录像。
          </p>
        ) : (
          <div className="cards">
            {recent.map((m) => (
              <MatchCard key={m.id} m={m} onOpen={() => props.openMatch(m.id)} />
            ))}
          </div>
        )}
      </section>

      {storage && (
        <section className="storage">
          <div className="storage-bar">
            <div style={{ width: `${Math.min(100, (storage.usedBytes / (storage.limitGb * 1024 ** 3)) * 100)}%` }} />
          </div>
          <span>
            已用 {bytes(storage.usedBytes)} / 上限 {storage.limitGb} GB · 硬盘剩余 {bytes(storage.freeBytes)}
          </span>
          <button type="button" className="link" onClick={() => api.reveal(storage.libraryDir)}>
            {storage.libraryDir}
          </button>
        </section>
      )}
    </div>
  );
}

function Stat(props: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={"stat" + (props.bad ? " is-bad" : "")}>
      <span className="stat-value">{props.value}</span>
      <span className="stat-label">{props.label}</span>
    </div>
  );
}

