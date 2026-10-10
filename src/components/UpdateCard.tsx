import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpCircle, RefreshCw, X } from "lucide-react";
import { api, errText, on, type Status, type UpdateInfo } from "../lib/api";
import { bytes, shortVersion } from "../lib/format";
import { Button, Spinner } from "./ui";
import { t } from "../lib/i18n";

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
            <b>{t("有新版本", "Update available")}</b>
            <span>v{shortVersion(u.version)} · {t("点这里更新", "click to update")}</span>
          </span>
        </button>
      ) : (
        <button type="button" className="update-check" onClick={run} disabled={check === "checking"} title={err ?? t("检查有没有新版本", "Check for a new version")}>
          {check === "checking" ? <Spinner /> : <RefreshCw size={13} />}
          <span>
            {check === "checking"
              ? t("正在检查…", "Checking…")
              : check === "latest"
                ? t("已经是最新版本", "You're up to date")
                : check === "error"
                  ? t("检查失败，点一下重试", "Check failed, click to retry")
                  : t("检查更新", "Check updates")}
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
          <h2 id="update-title">{t("KillCam 有新版本了", "A new version of KillCam is out")}</h2>
          <span className="grow" />
          {!busy && (
            <button type="button" className="icon-btn" onClick={props.onClose} aria-label={t("关闭", "Close")}>
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
            <h3>{t("更新了什么", "What's new")}</h3>
            <Notes text={u.notes} />
          </section>
        ) : null}

        {busy ? (
          <div className="update-progress update-progress-lg">
            <div className="update-bar">
              <i style={{ width: `${pct ?? 4}%` }} />
            </div>
            <div className="update-progress-text">
              <span>{got ? t("正在下载新版本", "Downloading the new version") : t("准备下载…", "Preparing download…")}</span>
              <span className="mono">{got ? (pct != null ? `${pct}%` : bytes(got[0])) : ""}</span>
            </div>
            <p className="muted small">
              {t(
                "下载完 KillCam 会自己关掉、装好新版本再打开，录像和设置都会保留。",
                "Once downloaded, KillCam closes, installs the new version and reopens. Your recordings and settings are kept.",
              )}
            </p>
          </div>
        ) : (
          <p className="muted small">
            {props.recording
              ? t("正在录制，这局录完再更新。", "Recording now. Update after this match.")
              : t(
                  "更新时 KillCam 会自己关掉、装好再打开，录像和设置都会保留。",
                  "KillCam closes, installs the update and reopens. Your recordings and settings are kept.",
                )}
          </p>
        )}

        {err && <p className="warn-text small">{err}</p>}

        {!busy && (
          <footer>
            <Button kind="ghost" onClick={props.onClose}>
              {t("稍后", "Later")}
            </Button>
            <Button kind="primary" onClick={go} disabled={props.recording}>
              {props.recording ? t("录完再更新", "Update after recording") : t("更新并重启", "Update and restart")}
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
