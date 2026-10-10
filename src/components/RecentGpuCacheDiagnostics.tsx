import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
export interface RecentGpuDiagnostics {
  state: string;
  config: {
    desiredCapacity: number;
    minimumCapacity: number;
    memoryBudgetBytes: number;
  };
  cacheGeneration: number;
  cacheSequence: number;
  width: number;
  height: number;
  pixelFormat: string;
  entries: number;
  capacity: number;
  pinnedSlots: number;
  estimatedBytesPerTexture: number;
  estimatedRetainedPayload: number;
  capacityPayload: number;
  usablePayloadBudget: number;
  oldestAgeMs: number | null;
  newestAgeMs: number | null;
  coverageMs: number;
  insertionAttempts: number;
  successfulInsertions: number;
  droppedInsertions: number;
  slotReuseCount: number;
  cacheWrapCount: number;
  cacheResets: number;
  slotSetsCreated: number;
  ownedTextureCreations: number;
  gpuCopiesIssued: number;
  manualReadbacks: number;
  consumerCopies: number;
  insertionRate: number;
  averageInsertionCpuMs: number;
  maximumInsertionCpuMs: number;
  error: string | null;
}
interface Id {
  cacheGeneration: number;
  cacheSequence: number;
}
interface Preview {
  imageBase64: string;
  width: number;
  height: number;
  id: Id;
  sourceFrameId: number;
  ageMs: number;
}
interface Match {
  kind: string;
  deltaMs: number;
  id: Id;
  sourceFrameId: number;
}
const bytes = (n: number) =>
  `${n.toLocaleString()} B (${(n / 1048576).toFixed(2)} MiB)`;
const age = (n: number | null) => (n === null ? "None" : `${n.toFixed(2)} ms`);
export function RecentGpuCacheDiagnostics({
  snapshot: s,
  active,
  gpuFrames,
}: {
  snapshot: RecentGpuDiagnostics;
  active: boolean;
  gpuFrames: boolean;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selection, setSelection] = useState("latest");
  const [sampleAge, setSampleAge] = useState(0);
  const [match, setMatch] = useState<Match | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    ++request.current;
    setPreview(null);
    setMatch(undefined);
    setError(null);
    setBusy(false);
    return () => {
      ++request.current;
    };
  }, [active, s.cacheGeneration]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), 5000);
    return () => clearTimeout(timer);
  }, [preview]);
  async function inspect() {
    const ticket = ++request.current;
    setBusy(true);
    setPreview(null);
    setError(null);
    try {
      const p = await invoke<Preview>("recent_gpu_preview", {
        selection,
        cacheGeneration: s.cacheGeneration,
      });
      if (ticket === request.current) setPreview(p);
    } catch {
      if (ticket === request.current)
        setError(
          "Frame expired, cache unavailable, or another preview is busy. Try again.",
        );
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  async function correlate() {
    const ticket = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const m = await invoke<Match | null>("recent_gpu_correlate", {
        ageMs: sampleAge,
        maximumDistanceMs: 50,
      });
      if (ticket === request.current) setMatch(m);
    } catch {
      if (ticket === request.current) setError("Correlation unavailable.");
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  return (
    <details className="voice-debug">
      <summary>Recent Full-Resolution GPU Cache</summary>
      <p>
        Tier B retains a few immutable WGC textures. Tier A keeps the
        five-second luma history separately. Payload estimates are not exact
        VRAM measurements. Admission adds no GPU copy; previews explicitly read
        one cached full-resolution frame.
      </p>
      <dl>
        {Object.entries({
          "Tier-B state": gpuFrames
            ? s.state
            : "Unavailable for Legacy Backend",
          "Source resolution / format": `${s.width} × ${s.height} / ${s.pixelFormat}`,
          "Desired / actual capacity": `${s.config.desiredCapacity} / ${s.capacity}`,
          "Tier-B entries": `${s.entries} / ${s.capacity}`,
          "Pinned replacement slots": s.pinnedSlots,
          "Estimated bytes / texture": bytes(s.estimatedBytesPerTexture),
          "Estimated Tier-B texture payload": bytes(s.estimatedRetainedPayload),
          "Capacity payload estimate": bytes(s.capacityPayload),
          "Configured Tier-B budget": bytes(s.config.memoryBudgetBytes),
          "Usable payload budget (10% reserved)": bytes(s.usablePayloadBudget),
          "Oldest cached frame age": age(s.oldestAgeMs),
          "Newest cached frame age": age(s.newestAgeMs),
          "Tier-B temporal coverage": age(s.coverageMs),
          "Cache generation": s.cacheGeneration,
          "Cache sequence": s.cacheSequence,
          "Insertion attempts / successes": `${s.insertionAttempts} / ${s.successfulInsertions}`,
          "Dropped Tier-B insertions": s.droppedInsertions,
          "Slot reuse / cache wraps": `${s.slotReuseCount} / ${s.cacheWrapCount}`,
          "Cache resets / slot sets": `${s.cacheResets} / ${s.slotSetsCreated}`,
          "Tier-B texture allocations / admission GPU copies": `${s.ownedTextureCreations} / ${s.gpuCopiesIssued}`,
          "Manual Tier-B readbacks": s.manualReadbacks,
          "Preview / consumer GPU copies": s.consumerCopies,
          "Tier-B insertion rate": `${s.insertionRate.toFixed(2)} frames/s`,
          "Average / maximum insertion CPU": `${s.averageInsertionCpuMs.toFixed(4)} / ${s.maximumInsertionCpuMs.toFixed(4)} ms`,
        }).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {s.error && <p role="alert">{s.error}</p>}
      <label>
        Full-resolution cached frame{" "}
        <select
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
        >
          <option value="latest">Latest</option>
          <option value="oldest">Oldest available</option>
        </select>
      </label>
      <button
        disabled={!active || busy || !s.entries}
        onClick={() => void inspect()}
      >
        Inspect Full-Resolution Cache Frame
      </button>
      <label>
        Tier-A sample age{" "}
        <select
          value={sampleAge}
          onChange={(e) => setSampleAge(Number(e.target.value))}
        >
          <option value={0}>Latest</option>
          <option value={100}>~100 ms ago</option>
          <option value={1000}>~1 second ago</option>
          <option value={3000}>~3 seconds ago</option>
        </select>
      </label>
      <button
        disabled={!active || busy || !s.entries}
        onClick={() => void correlate()}
      >
        Correlate Tier-A Sample
      </button>
      <p>
        Correlation tolerance: 50 ms. Old Tier-A samples normally have no Tier-B
        match.
      </p>
      {active && match !== undefined && (
        <p role="status">
          {match
            ? `${match.kind}: source #${match.sourceFrameId}, cache #${match.id.cacheSequence}, delta ${match.deltaMs.toFixed(3)} ms`
            : "No acceptable recent GPU frame."}
        </p>
      )}
      {active && error && <p role="alert">{error}</p>}
      {active &&
        preview &&
        preview.id.cacheGeneration === s.cacheGeneration && (
          <figure className="preview">
            <img
              alt="Full-resolution cached GPU frame"
              src={`data:image/png;base64,${preview.imageBase64}`}
            />
            <figcaption>
              Original {preview.width} × {preview.height} cached GPU texture;
              source #{preview.sourceFrameId}, cache #{preview.id.cacheSequence}
              , {preview.ageMs.toFixed(1)} ms old at inspection. Display scaled
              to fit.
            </figcaption>
          </figure>
        )}
    </details>
  );
}
