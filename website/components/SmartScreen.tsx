import type { Dict } from "@/lib/i18n";

// A simplified drawing of the SmartScreen prompt, so people recognise it and
// know which two things to click. Not a screenshot.
export function SmartScreen({ s, file }: { s: Dict["install"]["smart"]; file?: string }) {
  return (
    <div className="ss" role="img" aria-label={`${s.heading}: ${s.more}, ${s.run}`}>
      <div className="ss-win">
        <p className="ss-h">{s.heading}</p>
        <p className="ss-t">{s.text}</p>
        <p>
          <span className="ss-link ss-target">
            <span className="ss-step">1</span>
            {s.more}
          </span>
        </p>
        <div className="ss-btns">
          <span className="ss-btn">{s.dontRun}</span>
        </div>
      </div>
      <div className="ss-win">
        <p className="ss-h">{s.heading}</p>
        <dl className="ss-meta">
          <div>
            <dt>{s.app}</dt>
            <dd>{file ?? "KillCam_x.x.x_x64-setup.exe"}</dd>
          </div>
          <div>
            <dt>{s.publisher}</dt>
            <dd>{s.unknown}</dd>
          </div>
        </dl>
        <div className="ss-btns">
          <span className="ss-btn ss-target">
            <span className="ss-step">2</span>
            {s.run}
          </span>
          <span className="ss-btn">{s.dontRun}</span>
        </div>
      </div>
    </div>
  );
}
