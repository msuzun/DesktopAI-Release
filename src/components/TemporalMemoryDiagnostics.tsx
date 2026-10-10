import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TemporalDiagnostics {
  state: string;
  historySeconds: number;
  temporalGeneration: number;
  temporalSequence: number;
  capacity: number;
  occupiedSlots: number;
  samples: number;
  coverageSeconds: number;
  historyReady: boolean;
  oldestAgeMs: number | null;
  newestAgeMs: number | null;
  latest: { temporalGeneration: number; temporalSequence: number } | null;
  analysisWidth: number;
  analysisHeight: number;
  bytesPerPixel: number;
  bytesPerSample: number;
  pixelMemoryBytes: number;
  metadataMemoryBytes: number;
  approximateMemoryBytes: number;
  memoryLimitBytes: number;
  allocationCount: number;
  insertedSamples: number;
  overwriteCount: number;
  temporalRate: number;
  averageInsertionMs: number;
  maximumInsertionMs: number;
  error: string | null;
}
interface Preview {
  preview: { imageBase64: string; width: number; height: number };
  id: { temporalGeneration: number; temporalSequence: number };
  sourceFrameId: number;
  ageMs: number;
  classification: string | null;
}
const bytes = (n: number) =>
  `${n.toLocaleString()} B (${(n / 1048576).toFixed(2)} MiB)`;
const age = (n: number | null) => (n === null ? "None" : `${n.toFixed(1)} ms`);

export function TemporalMemoryDiagnostics({
  snapshot: s,
  active,
}: {
  snapshot: TemporalDiagnostics;
  active: boolean;
}) {
  const [ageMs, setAgeMs] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    ++request.current;
    setPreview(null);
    setError(null);
    setBusy(false);
    return () => {
      ++request.current;
    };
  }, [active, s.temporalGeneration]);
  // One explicit diagnostic snapshot is displayed for at most five seconds.
  // This also leaves enough time to inspect a sample near the retention boundary.
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), s.historySeconds * 1000);
    return () => clearTimeout(timer);
  }, [preview, s.historySeconds]);
  async function inspect() {
    const ticket = ++request.current;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const value = await invoke<Preview>("temporal_sample_preview", {
        ageMs,
        temporalGeneration: s.temporalGeneration,
      });
      if (ticket === request.current) setPreview(value);
    } catch {
      if (ticket === request.current)
        setError("Sample expired or history is unavailable. Try again.");
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  return (
    <details className="voice-debug">
      <summary>Temporal Memory Diagnostics</summary>
      <p>
        Local raw luma history. Queries use source timestamps within the last{" "}
        {s.historySeconds.toFixed(1)} seconds. High-quality keyframe history is
        not implemented.
      </p>
      <dl>
        {Object.entries({
          "Temporal memory": s.state,
          "Configured history": `${s.historySeconds.toFixed(1)} s`,
          "Current coverage": `${s.coverageSeconds.toFixed(3)} s`,
          "Samples in time window": `${s.samples} / ${s.capacity}`,
          "Occupied physical slots": `${s.occupiedSlots} / ${s.capacity}`,
          "Ring utilization": `${s.capacity ? ((s.occupiedSlots / s.capacity) * 100).toFixed(1) : "0.0"}%`,
          "Temporal rate": `${s.temporalRate.toFixed(2)} samples/s`,
          "Analysis resolution": `${s.analysisWidth} × ${s.analysisHeight}`,
          "Pixel format": `Luma8, ${s.bytesPerPixel} byte/pixel`,
          "Bytes / sample": s.bytesPerSample.toLocaleString(),
          "Preallocated pixel memory": bytes(s.pixelMemoryBytes),
          "Metadata allocation": bytes(s.metadataMemoryBytes),
          "Approx. ring memory": bytes(s.approximateMemoryBytes),
          "Memory budget": bytes(s.memoryLimitBytes),
          "Storage allocations": s.allocationCount,
          "Oldest sample age": age(s.oldestAgeMs),
          "Newest sample age": age(s.newestAgeMs),
          "History ready": s.historyReady ? "Yes" : "No",
          "Latest temporal sample": s.latest
            ? `#${s.latest.temporalSequence}`
            : "None",
          "Temporal sequence": s.temporalSequence,
          "Temporal generation": s.temporalGeneration,
          "Inserted samples": s.insertedSamples,
          "Overwrite count": s.overwriteCount,
          "Average / maximum insertion": `${s.averageInsertionMs.toFixed(4)} / ${s.maximumInsertionMs.toFixed(4)} ms`,
        }).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {s.error && <p role="alert">{s.error}</p>}
      <label>
        Temporal sample age{" "}
        <select
          value={ageMs}
          onChange={(e) => setAgeMs(Number(e.target.value))}
        >
          <option value={0}>Latest</option>
          <option value={1000}>~1 second ago</option>
          <option value={3000}>~3 seconds ago</option>
          <option value={5000}>~5 seconds ago</option>
        </select>
      </label>
      <button
        disabled={!active || busy || !s.latest}
        onClick={() => void inspect()}
      >
        Inspect Temporal Sample
      </button>
      {active && error && <p role="status">{error}</p>}
      {active &&
        preview &&
        preview.id.temporalGeneration === s.temporalGeneration && (
          <figure>
            <img
              alt="Temporal Analysis Preview"
              src={`data:image/png;base64,${preview.preview.imageBase64}`}
              width={preview.preview.width}
              height={preview.preview.height}
            />
            <figcaption>
              Temporal Analysis Preview — {preview.preview.width} ×{" "}
              {preview.preview.height}, sample #{preview.id.temporalSequence},
              source #{preview.sourceFrameId}, {preview.ageMs.toFixed(0)} ms old
              at query, {preview.classification ?? "Baseline"}. Low-resolution
              luma.
            </figcaption>
          </figure>
        )}
    </details>
  );
}
