import { useState } from "react";
import type { ObserverSnapshot } from "../hooks/useObserver";
import type { CapturedFrame } from "../api";

export function ScreenshotPreview({
  frame,
  capturing,
  observation,
}: {
  frame: CapturedFrame | null;
  capturing: boolean;
  observation: ObserverSnapshot | null;
}) {
  const [overlay, setOverlay] = useState(false);
  return (
    <section
      className="preview"
      aria-label="Screenshot preview"
      aria-busy={capturing}
    >
      {frame ? (
        <div>
          {frame.kind === "context" && (
            <label>
              <input
                type="checkbox"
                checked={overlay}
                onChange={(e) => setOverlay(e.target.checked)}
              />{" "}
              Show last observed change regions (may postdate this capture)
            </label>
          )}
          <div
            style={{
              position: "relative",
              lineHeight: 0,
              width: `min(100%, ${(65 * frame.width) / frame.height}vh)`,
              margin: "auto",
            }}
          >
            <img
              src={`data:image/${frame.encoding};base64,${frame.imageBase64}`}
              alt="Latest captured primary desktop display"
            />
            {overlay &&
              frame.kind === "context" &&
              observation?.changedTiles.map((tile) => (
                <span
                  key={tile}
                  style={{
                    position: "absolute",
                    pointerEvents: "none",
                    border: "1px solid #ffbf47",
                    boxSizing: "border-box",
                    left: `${(tile % 8) * 12.5}%`,
                    top: `${Math.floor(tile / 8) * 12.5}%`,
                    width: "12.5%",
                    height: "12.5%",
                  }}
                />
              ))}
          </div>
        </div>
      ) : (
        <div className="placeholder">
          <div className="screen-icon" aria-hidden="true">
            ▣
          </div>
          <h2>
            {capturing
              ? "Capturing your display…"
              : "Your visual context starts here"}
          </h2>
          <p>
            Start a session, then capture your primary display.
            <br />
            Manual captures stay local. AI visual requests require separate
            permission.
          </p>
        </div>
      )}
    </section>
  );
}
