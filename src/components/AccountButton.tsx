import { useEffect, useState } from "react";
import { UserRound, X } from "lucide-react";
import { api, errText, type Settings } from "../lib/api";
import { Button, Spinner } from "./ui";
import { PubgSection } from "./sections";

/** Side rail: who you are in PUBG. Opens a small dialog to fill in the
 *  player name and API key. */
export function AccountButton(props: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [open, setOpen] = useState(false);
  const p = props.settings.pubg;
  const linked = !!(p.playerName && p.apiKey);

  return (
    <>
      <button type="button" className={"account-btn" + (linked ? "" : " is-empty")} onClick={() => setOpen(true)}>
        <span className="account-avatar">{linked ? p.playerName.slice(0, 1).toUpperCase() : <UserRound size={15} />}</span>
        <span className="account-text">
          <b>{linked ? p.playerName : "绑定 PUBG 账号"}</b>
          <span>{linked ? (p.shard === "kakao" ? "Kakao" : "Steam") + (p.accountId ? " · 已验证" : "") : "用来读取官方对局数据"}</span>
        </span>
      </button>
      {open && <AccountDialog settings={props.settings} onSaved={props.onSaved} onClose={() => setOpen(false)} />}
    </>
  );
}

function AccountDialog(props: { settings: Settings; onSaved: (s: Settings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = JSON.stringify(draft.pubg) !== JSON.stringify(props.settings.pubg);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    // only the account changes here; everything else stays as saved
    const next = { ...props.settings, pubg: draft.pubg };
    try {
      await api.saveSettings(next);
      props.onSaved(next);
      props.onClose();
    } catch (e) {
      setErr(errText(e));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <header>
          <h2 id="account-title">PUBG 账号</h2>
          <span className="grow" />
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <p className="muted small">
          不填也能用：读屏会识别击杀、击倒和吃鸡。填了以后，普通和排位对局会有地图、排名、伤害、武器等官方数据，「数据」页也靠它。Key 只存在你自己电脑上。
        </p>
        <PubgSection settings={draft} set={(fn) => setDraft((s) => fn(s))} />
        {err && <p className="warn-text small">{err}</p>}
        <footer>
          <Button kind="ghost" onClick={props.onClose}>
            取消
          </Button>
          <Button kind="primary" onClick={save} disabled={saving || !dirty}>
            {saving ? <Spinner /> : "保存"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
