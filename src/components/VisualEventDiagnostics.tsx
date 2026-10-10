import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
interface Id {
  generation: number;
  sequence: number;
}
interface Event {
  id: Id;
  kind: string;
  status: string;
  startAgeMs: number;
  peakAgeMs: number;
  endAgeMs: number | null;
  durationMs: number;
  peakSequence: number;
  peakScore: number;
  peakArea: number;
  detectionConfidence: number;
  keyframe: Id | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
}
interface Keyframe {
  id: Id;
  event: Id;
  kind: string;
  status: string;
  ageMs: number;
  sourceFrameId: number;
  width: number;
  height: number;
  correlation: string;
  correlationDeltaMs: number;
  detectionConfidence: number;
  selectionConfidence: number;
}
export interface EventDiagnostics {
  updatesDropped: number;
  lastSourceFrameId: number | null;
  state: string;
  generation: number;
  active: Event | null;
  sceneSequence: number;
  stableDurationMs: number;
  lastStableAgeMs: number | null;
  statistics: {
    samples: number;
    created: number;
    discarded: number;
    stableEvents: number;
    transitions: number;
    transientCandidates: number;
    transientConfirmed: number;
    transientDiscarded: number;
    persistentEvents: number;
    suppressed: number;
    completed: number;
    baselineExpired: number;
  };
  events: Event[];
  timelineCapacity: number;
  keyframes: Keyframe[];
  eventsPerMinute: number;
  promotionsPerMinute: number;
  averageDetectorCpuMs: number;
  maximumDetectorCpuMs: number;
  stabilityMs: number;
  transientMinMs: number;
  transientMaxMs: number;
  cooldownMs: number;
  correlationLimitMs: number;
  retentionSeconds: number;
  error: string | null;
  tierC: {
    state: string;
    generation: number;
    capacity: number;
    memoryLimitedCapacity: number;
    provisional: number;
    confirmed: number;
    pinnedSlots: number;
    physicalTextures: number;
    bytesPerFrame: number;
    allocatedPayload: number;
    occupiedPayload: number;
    config: {
      desiredCapacity: number;
      memoryBudgetBytes: number;
      provisionalLimit: number;
    };
    statistics: {
      attempted: number;
      succeeded: number;
      replaced: number;
      discarded: number;
      capacityDrops: number;
      noMatch: number;
      failures: number;
      copies: number;
      texturesCreated: number;
      poolSets: number;
      averageSubmissionMs: number;
      maximumSubmissionMs: number;
      manualReadbacks: number;
      lastFailure: string | null;
    };
  };
}
interface Preview {
  id: Id;
  event: Id;
  width: number;
  height: number;
  sourceFrameId: number;
  ageMs: number;
  imageBase64: string;
}
interface DisplayPreview extends Preview {
  expiresAt: number;
}
const mib = (n: number) =>
  n.toLocaleString() + " B (" + (n / 1048576).toFixed(2) + " MiB)";
const keyId = (id: Id) => id.generation + ":" + id.sequence;
const counts = (...values: (number | string)[]) => values.join(" / ");
export function VisualEventDiagnostics({
  snapshot: s,
  active,
  tierABytes,
  tierBBytes,
}: {
  snapshot: EventDiagnostics;
  active: boolean;
  tierABytes: number;
  tierBBytes: number;
}) {
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<DisplayPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const c = s.tierC;
  const selectedKeyframe = active
    ? s.keyframes.find((k) => keyId(k.id) === selected)
    : undefined;
  useEffect(() => {
    ++epoch.current;
    setPreview(null);
    setSelected("");
    setBusy(false);
    setError(null);
    return () => {
      ++epoch.current;
    };
  }, [active, s.generation]);
  useEffect(() => {
    if (!preview) return;
    const key = s.keyframes.find((k) => keyId(k.id) === keyId(preview.id));
    if (!key) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(
      () => setPreview(null),
      Math.max(0, preview.expiresAt - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [preview, s.keyframes, s.retentionSeconds]);
  async function inspect() {
    const key = s.keyframes.find((k) => keyId(k.id) === selected);
    if (!key) return;
    const ticket = ++epoch.current;
    setBusy(true);
    setPreview(null);
    setError(null);
    try {
      const image = await invoke<Preview>("promoted_keyframe_preview", {
        generation: key.id.generation,
        sequence: key.id.sequence,
      });
      if (ticket === epoch.current)
        setPreview({
          ...image,
          expiresAt:
            performance.now() +
            Math.max(0, s.retentionSeconds * 1000 - image.ageMs),
        });
    } catch {
      if (ticket === epoch.current)
        setError("Keyframe expired, unavailable, or another preview is busy.");
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  }
  return (
    <details className="voice-debug">
      <summary>Visual Events and Promoted Keyframes</summary>
      <p>
        Local visual patterns only. Confidence describes detection, not semantic
        importance. Full-resolution frames are copied on sparse promotions and
        expire after {s.retentionSeconds} seconds. GPU payload values are
        estimates, not physical VRAM measurements.
      </p>
      <dl>
        {Object.entries({
          "Event engine state": s.state,
          "Event updates dropped / latest source": counts(
            s.updatesDropped,
            s.lastSourceFrameId ?? "None",
          ),
          "Event generation / scene": counts(s.generation, s.sceneSequence),
          "Active event":
            active && s.active
              ? s.active.kind +
                " #" +
                s.active.id.sequence +
                ", " +
                s.active.durationMs.toFixed(0) +
                " ms, confidence " +
                s.active.detectionConfidence.toFixed(2)
              : "None",
          "Active peak / bounds":
            active && s.active
              ? counts(
                  s.active.peakSequence,
                  s.active.peakScore.toFixed(4),
                  JSON.stringify(s.active.bounds),
                )
              : "None",
          "Stable duration / window":
            counts(s.stableDurationMs.toFixed(0), s.stabilityMs) + " ms",
          "Last stable scene established":
            s.lastStableAgeMs === null
              ? "None"
              : (s.lastStableAgeMs / 1000).toFixed(2) + " seconds ago",
          "Transient min / max / cooldown":
            counts(s.transientMinMs, s.transientMaxMs, s.cooldownMs) + " ms",
          "Tier-B correlation limit": s.correlationLimitMs + " ms",
          "Timeline entries / capacity": counts(
            s.events.length,
            s.timelineCapacity,
          ),
          "Stable / transition / persistent events": counts(
            s.statistics.stableEvents,
            s.statistics.transitions,
            s.statistics.persistentEvents,
          ),
          "Transient candidates / confirmed / discarded": counts(
            s.statistics.transientCandidates,
            s.statistics.transientConfirmed,
            s.statistics.transientDiscarded,
          ),
          "Completed / suppressed / expired baselines": counts(
            s.statistics.completed,
            s.statistics.suppressed,
            s.statistics.baselineExpired,
          ),
          "Events created / discarded": counts(
            s.statistics.created,
            s.statistics.discarded,
          ),
          "Events / promotions per minute": counts(
            s.eventsPerMinute.toFixed(2),
            s.promotionsPerMinute.toFixed(2),
          ),
          "Event detector CPU average / maximum":
            counts(
              s.averageDetectorCpuMs.toFixed(4),
              s.maximumDetectorCpuMs.toFixed(4),
            ) + " ms",
          "Tier-C state": c.state,
          "Desired / memory-limited / actual keyframes": counts(
            c.config.desiredCapacity,
            c.memoryLimitedCapacity,
            c.capacity,
          ),
          "Confirmed / provisional / provisional limit": counts(
            c.confirmed,
            c.provisional,
            c.config.provisionalLimit,
          ),
          "Tier-C physical textures / pinned slots": counts(
            c.physicalTextures,
            c.pinnedSlots,
          ),
          "Estimated bytes / keyframe": mib(c.bytesPerFrame),
          "Estimated Tier-C allocated / occupied payload": counts(
            mib(c.allocatedPayload),
            mib(c.occupiedPayload),
          ),
          "Tier-C memory budget": mib(c.config.memoryBudgetBytes),
          "Estimated total Tier A + B + C": mib(
            tierABytes + tierBBytes + c.allocatedPayload,
          ),
          "Promotions attempted / succeeded / replaced": counts(
            c.statistics.attempted,
            c.statistics.succeeded,
            c.statistics.replaced,
          ),
          "Discarded / capacity drops / no Tier-B match": counts(
            c.statistics.discarded,
            c.statistics.capacityDrops,
            c.statistics.noMatch,
          ),
          "Promotion failures / last reason": counts(
            c.statistics.failures,
            c.statistics.lastFailure ?? "None",
          ),
          "Promotion GPU copies / textures created / pool sets": counts(
            c.statistics.copies,
            c.statistics.texturesCreated,
            c.statistics.poolSets,
          ),
          "Promotion submission CPU average / maximum":
            counts(
              c.statistics.averageSubmissionMs.toFixed(4),
              c.statistics.maximumSubmissionMs.toFixed(4),
            ) + " ms",
          "Manual keyframe readbacks": c.statistics.manualReadbacks,
        }).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {s.error && <p role="alert">{s.error}</p>}
      <ol aria-label="Recent Visual Event Timeline">
        {active &&
          s.events.map((e) => (
            <li key={keyId(e.id)}>
              −{(e.startAgeMs / 1000).toFixed(2)} s: {e.kind} #{e.id.sequence},{" "}
              {e.durationMs.toFixed(0)} ms, confidence{" "}
              {e.detectionConfidence.toFixed(2)}
              {e.keyframe ? ", K" + e.keyframe.sequence : ", no keyframe"}
            </li>
          ))}
      </ol>
      <label>
        Promoted keyframe{" "}
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose a keyframe</option>
          {active &&
            s.keyframes.map((k) => (
              <option key={keyId(k.id)} value={keyId(k.id)}>
                K{k.id.sequence} — {k.kind} / {k.status}, event #
                {k.event.sequence}, {(k.ageMs / 1000).toFixed(2)} s ago
              </option>
            ))}
        </select>
      </label>
      {selectedKeyframe && (
        <p>
          {selectedKeyframe.width} × {selectedKeyframe.height}; source #
          {selectedKeyframe.sourceFrameId}; {selectedKeyframe.correlation},
          delta {selectedKeyframe.correlationDeltaMs.toFixed(2)} ms; detection /
          selection confidence {selectedKeyframe.detectionConfidence.toFixed(2)}{" "}
          / {selectedKeyframe.selectionConfidence.toFixed(2)}.
        </p>
      )}
      <button
        disabled={
          !active || busy || !s.keyframes.some((k) => keyId(k.id) === selected)
        }
        onClick={() => void inspect()}
      >
        Inspect Promoted Keyframe
      </button>
      {active && error && <p role="alert">{error}</p>}
      {active &&
        preview &&
        preview.id.generation === c.generation &&
        s.keyframes.some((k) => keyId(k.id) === keyId(preview.id)) && (
          <figure className="preview">
            <img
              alt="Promoted full-resolution historical keyframe"
              src={"data:image/png;base64," + preview.imageBase64}
            />
            <figcaption>
              {preview.width} × {preview.height}; event #
              {preview.event.sequence}, source #{preview.sourceFrameId},
              {(preview.ageMs / 1000).toFixed(2)} seconds old at inspection.
              Display scaled to fit.
            </figcaption>
          </figure>
        )}
    </details>
  );
}
