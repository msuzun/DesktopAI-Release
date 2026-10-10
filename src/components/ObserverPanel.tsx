import type { ObserverSnapshot } from "../hooks/useObserver";
import type { CapturedFrame } from "../api";
import { useEffect, useState } from "react";
export function ObserverPanel({
  snapshot,
  active,
  frame,
  error,
}: {
  snapshot: ObserverSnapshot | null;
  active: boolean;
  frame: CapturedFrame | null;
  error: string | null;
}) {
  const [frames, setFrames] = useState<
    Partial<Record<"context" | "detail", string>>
  >({});
  useEffect(() => {
    if (!active) setFrames({});
    else if (frame)
      setFrames((old) => ({
        ...old,
        [frame.kind]: `${frame.width} × ${frame.height} · ${frame.encoding.toUpperCase()} · ${frame.encodedSizeBytes.toLocaleString()} bytes · source ${JSON.stringify(frame.sourceRegion)}`,
      }));
  }, [active, frame]);
  const s = snapshot;
  const entries: Record<string, string | number> = {
    Observer: active ? (s?.error ? "Error" : "Local only") : "Stopped",
    Interval: s ? `${s.intervalMs} ms` : "—",
    Observations: s?.observationCount ?? 0,
    "Meaningful changes": s?.meaningfulCount ?? 0,
    "Last observation processing": s ? `${s.processingMs.toFixed(1)} ms` : "—",
    "Observed candidate → detection":
      s?.lastDetectionLatencyMs != null
        ? `${s.lastDetectionLatencyMs.toFixed(1)} ms`
        : "—",
    "Last change": s?.lastChangeType ?? "—",
    "Global score": s?.globalScore.toFixed(4) ?? "—",
    "Changed area": s ? `${(s.changedAreaRatio * 100).toFixed(2)}%` : "—",
    "Region score": s?.regionScore.toFixed(4) ?? "—",
    "Temporal confidence": s?.temporalConfidence.toFixed(2) ?? "—",
    "Last event tiles": s?.changedTiles.length ?? 0,
    "Last event region": s?.boundingRegion
      ? JSON.stringify(s.boundingRegion)
      : "—",
    Stability: s
      ? `${s.stable ? "Stable" : "Settling"} · quiet ${s.stabilizationDurationMs} / ${s.stabilizationMs} ms`
      : "—",
    "Detected / stable at": s
      ? `${s.detectedAt ? new Date(s.detectedAt).toLocaleTimeString() : "—"} / ${s.stableAt ? new Date(s.stableAt).toLocaleTimeString() : "—"}`
      : "—",
    "Latest context": frames.context ?? "Not captured",
    "Latest detail": frames.detail ?? "Not captured",
  };
  return (
    <section className="debug">
      <h2>Adaptive visual perception</h2>
      <p>
        Active visual sessions observe locally. Only permitted AI requests can
        upload images. Debug summaries refresh once per second.
      </p>
      {(error || s?.error) && <p role="alert">{error || s?.error}</p>}
      <details open>
        <summary>Observer and frame debug</summary>
        <dl>
          {Object.entries(entries).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </details>
      <p className="analysis-note">
        Detection timing starts with the first observed candidate, not the
        physical application switch. Add up to an observer interval and
        scheduling delays when assessing real transitions. Context capture waits
        for a quiet window when requested.
      </p>
    </section>
  );
}
