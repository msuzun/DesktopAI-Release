import { TurnDebug } from "./TurnDebug";
import { useSyncExternalStore } from "react";
import type { useVisualTools } from "../hooks/useVisualTools";
import { visualIntentDeliveryCounters } from "../providers/realtime/visual/DeliveryCounters";
export function VisualDiagnostics({
  visual,
}: {
  visual: ReturnType<typeof useVisualTools>;
}) {
  const debug = useSyncExternalStore(
    visual.dispatcher.subscribe,
    visual.dispatcher.getSnapshot,
  );
  const ms = (value: number | undefined) =>
    value === undefined ? "Unavailable" : `${Math.round(value)} ms`;
  return (
    <section aria-label="Visual diagnostics">
      <TurnDebug turn={visual.turn} control={visual.responseControl} />
      <p>{visual.turn.error ?? visual.error}</p>
      <p>{visual.responseControlHint}</p>
      <details>
        <summary>Visual Orchestration Diagnostics</summary>
        {debug?.inspection ? (
          <>
            <p>
              {debug.inspection.intent} · {debug.inspection.status} · turn{" "}
              {debug.inspection.turnId}
            </p>
            <p>{debug.inspection.operations.join(" → ")}</p>
            <p>
              {debug.inspection.snapshots
                .map(
                  (s) =>
                    `${s.temporalRole}: ${s.snapshotId} @ ${s.offsetMs.toFixed(0)} ms (${s.quality}${s.reused ? ", reused" : ""})`,
                )
                .join("; ")}
            </p>
            <p>
              {debug.inspection.timings.totalMs?.toFixed(1)} ms ·{" "}
              {debug.metadata?.encodedSizeBytes ?? 0} encoded bytes ·{" "}
              {debug.acknowledgment}
            </p>
            <p>
              Prepared / reused images: {debug.inspection.work.imagesPrepared} /{" "}
              {debug.inspection.work.imagesReused}
            </p>
            <p>
              Reference time:{" "}
              {new Date(
                debug.inspection.referenceTimeUnixMs,
              ).toLocaleTimeString()}
              ; follow-up:{" "}
              {debug.inspection.followUpReference?.snapshotId ??
                debug.inspection.followUpSnapshotId ??
                "None"}
              ; origin turn:{" "}
              {debug.inspection.followUpReference?.originTurnId ?? "This turn"}
            </p>
            <pre>{JSON.stringify(debug.inspection.timings, null, 2)}</pre>
            <pre>{JSON.stringify(debug.counts, null, 2)}</pre>
            <pre>{JSON.stringify(visualIntentDeliveryCounters(), null, 2)}</pre>
          </>
        ) : (
          <p>No visual inspection requested.</p>
        )}
      </details>
      <details>
        <summary>Visual AI Debug</summary>
        {debug ? (
          <dl>
            <div>
              <dt>Tool / kind</dt>
              <dd>
                {debug.tool} / {debug.kind}
              </dd>
            </div>
            <div>
              <dt>Requested by</dt>
              <dd>{debug.provider}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{debug.reason}</dd>
            </div>
            <div>
              <dt>Requested at</dt>
              <dd>{new Date(debug.requestedAt).toLocaleTimeString()}</dd>
            </div>
            <div>
              <dt>Capture / sent timestamps</dt>
              <dd>
                {debug.capturedAt
                  ? new Date(debug.capturedAt).toLocaleTimeString()
                  : "?"}{" "}
                /{" "}
                {debug.sentAt
                  ? new Date(debug.sentAt).toLocaleTimeString()
                  : "?"}
              </dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>{debug.result ?? "Pending"}</dd>
            </div>
            <div>
              <dt>Capture duration</dt>
              <dd>{ms(debug.metadata?.captureDurationMs)}</dd>
            </div>
            <div>
              <dt>Encoding / preparation</dt>
              <dd>{ms(debug.metadata?.encodingDurationMs)}</dd>
            </div>
            <div>
              <dt>Image size</dt>
              <dd>
                {debug.metadata
                  ? `${(debug.metadata.encodedSizeBytes / 1024).toFixed(1)} KB`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Change score</dt>
              <dd>
                {debug.metadata?.changeScore?.toFixed(4) ??
                  "Baseline / unavailable"}
              </dd>
            </div>
            <div>
              <dt>Sent to provider</dt>
              <dd>{debug.sent ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Provider acknowledgment</dt>
              <dd>{debug.acknowledgment}</dd>
            </div>
          </dl>
        ) : (
          <p>
            No on-demand tool request recorded. Automatic turn captures appear
            in Fresh Visual Turn Debug above.
          </p>
        )}
      </details>
    </section>
  );
}
