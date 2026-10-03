import { useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { api, errText, on, type Status } from "../lib/api";
import { bytes } from "../lib/format";
import { Spinner } from "./ui";

/** Side rail: the current version with a check button, or the update card
 *  once a newer release is known. */
export function UpdateCard(props: { status: Status | null }) {
  const u = props.status?.update;
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState<[number, number | null] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [check, setCheck] = useState<"idle" | "checking" | "latest" | "error">("idle");

  useEffect(() => on<[number, number | null]>("update-progress", setGot), []);

  // "已是最新" fades back to the plain button after a few seconds
  useEffect(() => {
    if (check !== "latest" && check !== "error") return;
    const t = window.setTimeout(() => setCheck("idle"), 4000);
    return () => window.clearTimeout(t);
  }, [check]);

  if (!u) {
    const run = async () => {
      setCheck("checking");
      setErr(null);
      try {
        const found = await api.checkUpdate();
        setCheck(found ? "idle" : "latest");
      } catch (e) {
        setErr(errText(e));
        setCheck("error");
      }
    };
    return (
      <button type="button" className="update-check" onClick={run} disabled={check === "checking"} title={err ?? "检查有没有新版本"}>
        {check === "checking" ? <Spinner /> : <RefreshCw size={13} />}
        <span>
          {check === "checking"
            ? "正在检查…"
            : check === "latest"
              ? "已经是最新版本"
              : check === "error"
                ? "检查失败，点一下重试"
                : "检查更新"}
        </span>
        <span className="update-ver">v{props.status?.version ?? "–"}</span>
      </button>
    );
  }

  const recording = !!props.status?.recording;
  const pct = got && got[1] ? Math.min(100, Math.round((got[0] / got[1]) * 100)) : null;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      // on success the installer closes KillCam and starts the new version
      await api.installUpdate();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="update-card">
      <div className="update-head">
        <ArrowUpCircle size={15} />
        <b>新版本 {u.version}</b>
        <span className="update-ver">当前 v{props.status?.version ?? "–"}</span>
      </div>
      {u.notes?.trim() && (
        <details className="update-details">
          <summary>更新了什么</summary>
          <div className="update-notes-rail">{u.notes.trim()}</div>
        </details>
      )}
      {busy ? (
        <div className="update-progress">
          <div className="update-bar">
            <i style={{ width: `${pct ?? 5}%` }} />
          </div>
          <span className="muted small">{got ? (pct != null ? `${pct}%` : bytes(got[0])) : "准备下载…"}</span>
        </div>
      ) : (
        <button type="button" className="update-btn" onClick={go} disabled={recording}>
          {recording ? "录完再更新" : "更新并重启"}
        </button>
      )}
      {err && <span className="warn-text small">{err}</span>}
    </div>
  );
}
