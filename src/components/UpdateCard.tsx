import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import { api, errText, on, type Status } from "../lib/api";
import { bytes } from "../lib/format";

/** Shown in the side rail when a newer release is out. */
export function UpdateCard(props: { status: Status | null }) {
  const u = props.status?.update;
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState<[number, number | null] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => on<[number, number | null]>("update-progress", setGot), []);

  if (!u) return null;
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
    <div className="update-card" title={u.notes ?? undefined}>
      <div className="update-head">
        <ArrowUpCircle size={15} />
        <b>新版本 {u.version}</b>
      </div>
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
