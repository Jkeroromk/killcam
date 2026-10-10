import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpCircle, RefreshCw, X } from "lucide-react";
import { api, errText, on, type Status, type UpdateInfo } from "../lib/api";
import { bytes, shortVersion } from "../lib/format";
import { Button, Spinner } from "./ui";

const DISMISSED = "kc.updateLater";

function dismissedFor(version: string) {
  try {
    return localStorage.getItem(DISMISSED) === version;
  } catch {
    return false;
  }
}

function dismiss(version: string) {
  try {
    localStorage.setItem(DISMISSED, version);
  } catch {
    /* not kept: it just asks again next launch */
  }
}

/** Side rail: the current version with a check button, or a clear "new version"
 *  button once a newer release is known. The update itself happens in a dialog,
 *  which also opens by itself once per version (never during a game). */
export function UpdateCard(props: { status: Status | null }) {
  const u = props.status?.update ?? null;
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [check, setCheck] = useState<"idle" | "checking" | "latest" | "error">("idle");
  const busyGame = !!props.status?.gameRunning || !!props.status?.recording;

  // a new version: show it once, but not while playing
  useEffect(() => {
    if (u && !busyGame && !dismissedFor(u.version)) setOpen(true);
  }, [u?.version, busyGame]);

  // "已是最新" fades back to the plain button after a few seconds
  useEffect(() => {
    if (check !== "latest" && check !== "error") return;
    const t = window.setTimeout(() => setCheck("idle"), 4000);
    return () => window.clearTimeout(t);
  }, [check]);

  const run = async () => {
    setCheck("checking");
    setErr(null);
    try {
      const found = await api.checkUpdate();
      setCheck(found ? "idle" : "latest");
      if (found) setOpen(true);
    } catch (e) {
      setErr(errText(e));
      setCheck("error");
    }
  };

  return (
    <>
      {u ? (
        <button type="button" className="update-ready" onClick={() => setOpen(true)}>
          <ArrowUpCircle size={16} />
          <span className="update-ready-text">
            <b>有新版本</b>
            <span>v{shortVersion(u.version)} · 点这里更新</span>
          </span>
        </button>
      ) : (
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
          <span className="update-ver">v{shortVersion(props.status?.version)}</span>
        </button>
      )}
      {u && open && (
        <UpdateDialog
          update={u}
          current={props.status?.version ?? u.current}
          recording={!!props.status?.recording}
          onClose={() => {
            dismiss(u.version);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function UpdateDialog(props: { update: UpdateInfo; current: string; recording: boolean; onClose: () => void }) {
  const { update: u } = props;
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState<[number, number | null] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => on<[number, number | null]>("update-progress", setGot), []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !busy && props.onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, props.onClose]);

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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && props.onClose()}>
      <div className="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header>
          <h2 id="update-title">KillCam 有新版本了</h2>
          <span className="grow" />
          {!busy && (
            <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭">
              <X size={16} />
            </button>
          )}
        </header>

        <div className="update-versions">
          <span className="update-chip">v{shortVersion(props.current)}</span>
          <ArrowRight size={16} />
          <span className="update-chip is-new">v{shortVersion(u.version)}</span>
        </div>

        {u.notes?.trim() ? (
          <section className="update-notes-box">
            <h3>更新了什么</h3>
            <Notes text={u.notes} />
          </section>
        ) : null}

        {busy ? (
          <div className="update-progress update-progress-lg">
            <div className="update-bar">
              <i style={{ width: `${pct ?? 4}%` }} />
            </div>
            <div className="update-progress-text">
              <span>{got ? "正在下载新版本" : "准备下载…"}</span>
              <span className="mono">{got ? (pct != null ? `${pct}%` : bytes(got[0])) : ""}</span>
            </div>
            <p className="muted small">下载完 KillCam 会自己关掉、装好新版本再打开，录像和设置都会保留。</p>
          </div>
        ) : (
          <p className="muted small">
            {props.recording ? "正在录制，这局录完再更新。" : "更新时 KillCam 会自己关掉、装好再打开，录像和设置都会保留。"}
          </p>
        )}

        {err && <p className="warn-text small">{err}</p>}

        {!busy && (
          <footer>
            <Button kind="ghost" onClick={props.onClose}>
              稍后
            </Button>
            <Button kind="primary" onClick={go} disabled={props.recording}>
              {props.recording ? "录完再更新" : "更新并重启"}
            </Button>
          </footer>
        )}
      </div>
    </div>
  );
}

/** Release notes as written on GitHub: "- " lines become a list, "#" lines headings. */
function Notes(props: { text: string }) {
  const out: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) {
      out.push(
        <ul key={out.length}>
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>,
      );
      items = [];
    }
  };
  for (const raw of props.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      items.push(bullet[1].replace(/\*\*/g, ""));
      continue;
    }
    flush();
    const head = line.match(/^#+\s+(.*)$/);
    out.push(head ? <h4 key={out.length}>{head[1]}</h4> : <p key={out.length}>{line.replace(/\*\*/g, "")}</p>);
  }
  flush();
  return <div className="update-notes-list">{out}</div>;
}
