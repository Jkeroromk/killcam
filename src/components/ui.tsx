import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, Crosshair, Crown, HeartCrack, ShieldAlert, Skull } from "lucide-react";
import type { EventKind } from "../lib/api";
import { KIND_LABEL } from "../lib/format";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger" | "plain";
  disabled?: boolean;
  small?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const cls = ["btn", `btn-${props.kind ?? "plain"}`, props.small ? "btn-sm" : ""].join(" ");
  return (
    <button type={props.type ?? "button"} className={cls} onClick={props.onClick} disabled={props.disabled} title={props.title}>
      {props.children}
    </button>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={"toggle" + (props.disabled ? " is-disabled" : "")}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden />
      {props.label && <span className="toggle-label">{props.label}</span>}
    </label>
  );
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: ReactNode; hint?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  wide?: boolean;
}) {
  return (
    <div className={"seg" + (props.wide ? " seg-wide" : "")} role="radiogroup">
      {props.options.map((o) => (
        <button
          type="button"
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === props.value}
          className={"seg-item" + (o.value === props.value ? " is-on" : "")}
          disabled={o.disabled}
          onClick={() => props.onChange(o.value)}
        >
          <span className="seg-label">{o.label}</span>
          {o.hint && <span className="seg-hint">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function Range(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="range">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="range-value">{props.format ? props.format(props.value) : props.value}</span>
    </div>
  );
}

export function Field(props: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{props.label}</span>
        {props.hint && <span className="field-hint">{props.hint}</span>}
      </div>
      <div className="field-body">{props.children}</div>
    </div>
  );
}

export function Meter(props: { value: number; label: string; error?: string | null }) {
  // value is linear peak 0..1, show in dB-ish scale
  const db = props.value > 0 ? 20 * Math.log10(props.value) : -60;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const hot = db > -3;
  return (
    <div className="meter">
      <span className="meter-label">{props.label}</span>
      <div className="meter-track">
        <div className={"meter-fill" + (hot ? " is-hot" : "")} style={{ width: `${pct}%` }} />
        {[-48, -36, -24, -12, -6].map((d) => (
          <i key={d} style={{ left: `${((d + 60) / 60) * 100}%` }} />
        ))}
      </div>
      {props.error && <span className="meter-error">{props.error}</span>}
    </div>
  );
}

function prettyKey(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num" + code.slice(6);
  return code;
}

export function HotkeyInput(props: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setListening(false);
        return;
      }
      if (e.code === "Backspace" || e.code === "Delete") {
        props.onChange("");
        setListening(false);
        return;
      }
      if (["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) {
        return;
      }
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      props.onChange([...mods, prettyKey(e.code)].join("+"));
      setListening(false);
      ref.current?.blur();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening]);
  return (
    <button
      type="button"
      ref={ref}
      className={"hotkey" + (listening ? " is-listening" : "")}
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
    >
      {listening ? "按下新的组合键…" : props.value ? props.value.split("+").map((k) => <kbd key={k}>{k}</kbd>) : "未设置"}
    </button>
  );
}

const KIND_ICON: Record<EventKind, typeof Skull> = {
  kill: Skull,
  knock: Crosshair,
  win: Crown,
  death: HeartCrack,
  knocked: ShieldAlert,
  manual: Bookmark,
};

export function KindIcon({ kind, small }: { kind: EventKind; small?: boolean }) {
  const I = KIND_ICON[kind] ?? Bookmark;
  return (
    <span className={`kicon k-${kind}` + (small ? " sm" : "")} title={KIND_LABEL[kind]}>
      <I strokeWidth={2.4} />
    </span>
  );
}

/** The match tape: every event of a match on one strip. */
export function Tape(props: {
  duration: number;
  events: { id?: string; t: number; kind: EventKind }[];
  highlights?: { id: string; start: number; end: number }[];
  playhead?: number;
  activeHighlight?: string | null;
  onSeek?: (t: number) => void;
}) {
  const d = Math.max(props.duration, 1);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / d) * 100))}%`;
  const ref = useRef<HTMLDivElement>(null);
  const seek = (clientX: number) => {
    if (!props.onSeek || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    props.onSeek(Math.max(0, Math.min(d, ((clientX - r.left) / r.width) * d)));
  };
  return (
    <div
      ref={ref}
      className={"tape" + (props.onSeek ? " is-seekable" : "")}
      onMouseDown={(e) => seek(e.clientX)}
      onMouseMove={(e) => e.buttons === 1 && seek(e.clientX)}
    >
      <div className="tape-rail" />
      {props.highlights?.map((h) => (
        <div
          key={h.id}
          className={"tape-hl" + (props.activeHighlight === h.id ? " is-active" : "")}
          style={{ left: pct(h.start), width: `calc(${pct(h.end)} - ${pct(h.start)})` }}
        />
      ))}
      {props.events.map((e, i) => (
        <span key={e.id ?? i} className={`tape-tick k-${e.kind}`} style={{ left: pct(e.t) }} />
      ))}
      {props.playhead != null && <div className="tape-head" style={{ left: pct(props.playhead) }} />}
    </div>
  );
}

export function KindDot({ kind }: { kind: EventKind }) {
  return <span className={`kdot k-${kind}`} aria-hidden />;
}

export function Spinner() {
  return <span className="spinner" aria-label="加载中" />;
}
