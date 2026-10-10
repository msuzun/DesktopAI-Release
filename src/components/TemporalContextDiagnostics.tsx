import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { visualDeliveryCounters } from "../providers/realtime/visual/DeliveryCounters";
interface Metric {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  immediate: number;
  afterWait: number;
  stale: number;
  expired: number;
  roi: number;
  fullFrame: number;
  unavailable: number;
  frames: number;
  events: number;
  encodedBytes: number;
  truncated: number;
  totalAgeMs: number;
  maximumAgeMs: number;
  totalCoverageMs: number;
  total: Record<string, number>;
  maximumMs: number;
}
interface Diagnostics {
  selection: {
    requests: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    alignmentRejected: number;
    lastRejection: {
      turnId: string;
      source: string;
      offsetMs: number;
      limitMs: number;
    } | null;
  };
  turnSync: {
    resolved: number;
    cancelled: number;
    unavailable: number;
    stableImmediate: number;
    waitedForStable: number;
    stabilityTimeouts: number;
    transient: number;
    preTransition: number;
    latest: number;
    legacyCurrentFallbackCount: number;
    zeroWait: number;
    waited: number;
    totalWaitMs: number;
    maximumWaitMs: number;
    totalResolverMs: number;
    maximumResolverMs: number;
    totalOffsetMs: number;
    totalAgeMs: number;
    last: {
      turnId: string;
      reason: string;
      source: string;
      candidates: number;
      scene: number;
      stable: boolean;
      event: string | null;
      turnOffsetMs: number;
      frameAgeMs: number;
      resolverMs: number;
      stabilityWaitMs: number;
      freshnessWaitMs: number;
      turnToSelectedMs: number;
      selectedAtUnixMs: number;
      legacyFallback: boolean;
    } | null;
  };
  current: Metric;
  detail: Metric;
  recent: Metric;
  snapshots: number;
  snapshotCapacity: number;
  snapshotGpuBytes: number;
  followUpCapacity: number;
  followUp: {
    snapshotId: string;
    originTurnId: string;
    remainingTurns: number;
    completed: boolean;
    expiresInMs: number;
  } | null;
  reservedHistoryEvents: number;
  reservedHistoryKeyframes: number;
  lastRecent: Record<string, unknown> | null;
  activeJobs: number;
  queuedJobs: number;
  rejectedBusy: number;
  readbackFailures: number;
  encodingFailures: number;
  lastKind: string | null;
  lastStatus: string | null;
  lastTurnId: string | null;
  lastError: string | null;
  lastTimings: Record<string, number>;
}
export function TemporalContextDiagnostics() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Diagnostics | null>(null);
  const [deliveries, setDeliveries] = useState(visualDeliveryCounters);
  useEffect(() => {
    if (!open) return;
    let active = true,
      pending = false;
    const update = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await invoke<Diagnostics>("visual_context_diagnostics");
        if (active) setStats(value);
      } catch {
        if (active) setStats(null);
      } finally {
        pending = false;
        if (active) setDeliveries(visualDeliveryCounters());
      }
    };
    void update();
    const timer = setInterval(() => void update(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Temporal Visual Context</summary>
      <p>
        Request-driven Current / Detail / Recent. Counts and timings only; no
        image previews or screen content are retained here.
      </p>
      {stats ? (
        <>
          <h4>Visual Turn Sync</h4>
          <p>
            Turn aware: ±200 ms; transition wait ≤200 ms; Tier-C Current age
            ≤300 ms. A provisional speech endpoint reserves one snapshot
            locally; encoding waits for confirmed speech completion. If a quiet
            desktop has no recent frame, one native bitmap is captured. Its CPU
            readback and conversion wait for confirmed speech completion.
          </p>
          <p>
            Early selection requests / accepted / failed / cancelled:{" "}
            {stats.selection.requests} / {stats.selection.succeeded} /{" "}
            {stats.selection.failed} / {stats.selection.cancelled}. Alignment
            rejections: {stats.selection.alignmentRejected}. These attempts are
            separate from the confirmed preparation counts below.
          </p>
          {stats.selection.lastRejection && (
            <p>
              Last turn alignment rejection:{" "}
              {stats.selection.lastRejection.turnId}; source{" "}
              {stats.selection.lastRejection.source}; observed offset{" "}
              {stats.selection.lastRejection.offsetMs.toFixed(2)} ms, allowed ±
              {stats.selection.lastRejection.limitMs} ms.
            </p>
          )}
          <p>
            Selections: {stats.turnSync.resolved}. Stable immediate / settled
            after transition / timeouts: {stats.turnSync.stableImmediate} /{" "}
            {stats.turnSync.waitedForStable} /{" "}
            {stats.turnSync.stabilityTimeouts}. Transient / before switch /
            latest: {stats.turnSync.transient} / {stats.turnSync.preTransition}{" "}
            / {stats.turnSync.latest}. Legacy captures:{" "}
            {stats.turnSync.legacyCurrentFallbackCount}. Unavailable / cancelled
            resolutions: {stats.turnSync.unavailable} /{" "}
            {stats.turnSync.cancelled}.
          </p>
          <p>
            Zero / nonzero stability waits: {stats.turnSync.zeroWait} /{" "}
            {stats.turnSync.waited}. Average / maximum wait:{" "}
            {(
              stats.turnSync.totalWaitMs / (stats.turnSync.waited || 1)
            ).toFixed(2)}{" "}
            / {stats.turnSync.maximumWaitMs.toFixed(2)} ms. Average / maximum
            resolver:{" "}
            {(
              stats.turnSync.totalResolverMs / (stats.turnSync.resolved || 1)
            ).toFixed(2)}{" "}
            / {stats.turnSync.maximumResolverMs.toFixed(2)} ms. Average signed
            turn offset:{" "}
            {(
              stats.turnSync.totalOffsetMs / (stats.turnSync.resolved || 1)
            ).toFixed(2)}{" "}
            ms.
          </p>
          {stats.turnSync.last && (
            <>
              <p>Last successful selection (identified by its own turn ID):</p>
              <dl>
                {Object.entries(stats.turnSync.last).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      {typeof value === "number"
                        ? value.toFixed(2)
                        : String(value ?? "None")}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          <p>
            Snapshots: {stats.snapshots} / {stats.snapshotCapacity}; owned
            source payload: {(stats.snapshotGpuBytes / 1048576).toFixed(2)} MiB.{" "}
            Historical follow-up references: {stats.followUp ? 1 : 0} /{" "}
            {stats.followUpCapacity}.
            {stats.followUp &&
              ` Origin turn: ${stats.followUp.originTurnId}; expires in ${(stats.followUp.expiresInMs / 1000).toFixed(1)} s; remaining follow-up turns: ${stats.followUp.remainingTurns}.`}
            Active / waiting: {stats.activeJobs} / {stats.queuedJobs}. Busy
            rejections: {stats.rejectedBusy}. Turn-reserved events / keyframe
            references: {stats.reservedHistoryEvents} /{" "}
            {stats.reservedHistoryKeyframes}.
          </p>
          {stats.lastRecent && (
            <details>
              <summary>Latest Recent query</summary>
              <dl className="diagnostic-grid">
                {Object.entries(stats.lastRecent).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          <table>
            <thead>
              <tr>
                <th>Context</th>
                <th>Requests / prepared / failed</th>
                <th>Images / events</th>
                <th>Average preparation</th>
                <th>Average encoded payload</th>
              </tr>
            </thead>
            <tbody>
              {(["current", "detail", "recent"] as const).map((kind) => {
                const m = stats[kind];
                return (
                  <tr key={kind}>
                    <th>{kind}</th>
                    <td>
                      {m.requests} / {m.succeeded} / {m.failed}
                    </td>
                    <td>
                      {m.frames} / {m.events}
                    </td>
                    <td>
                      {(m.total.totalMs / (m.succeeded || 1)).toFixed(2)} ms
                    </td>
                    <td>
                      {(m.encodedBytes / (m.succeeded || 1) / 1024).toFixed(1)}{" "}
                      KiB
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            Current immediate / after wait / stale: {stats.current.immediate} /{" "}
            {stats.current.afterWait} / {stats.current.stale}; source age
            average / maximum:{" "}
            {(
              stats.turnSync.totalAgeMs / (stats.turnSync.resolved || 1)
            ).toFixed(2)}{" "}
            / {stats.current.maximumAgeMs.toFixed(2)} ms.
          </p>
          <p>
            Detail ROI / full / expired: {stats.detail.roi} /{" "}
            {stats.detail.fullFrame} / {stats.detail.expired}. Recent average
            coverage:{" "}
            {(
              stats.recent.totalCoverageMs / (stats.recent.succeeded || 1)
            ).toFixed(0)}{" "}
            ms; truncated: {stats.recent.truncated}.
          </p>
          <p>
            Last preparation: {stats.lastKind ?? "None"} /{" "}
            {stats.lastStatus ?? "None"}; turn {stats.lastTurnId ?? "None"};
            error {stats.lastError ?? "None"}. Readback / encoding failures:{" "}
            {stats.readbackFailures} / {stats.encodingFailures}.
          </p>
          <dl>
            {Object.entries(stats.lastTimings).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value.toFixed(2)} ms</dd>
              </div>
            ))}
          </dl>
          <table>
            <thead>
              <tr>
                <th>Provider / context</th>
                <th>Submissions / images</th>
                <th>Encoded bytes</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(deliveries).flatMap(([provider, kinds]) =>
                Object.entries(kinds).map(([kind, m]) => (
                  <tr key={provider + kind}>
                    <th>
                      {provider} / {kind}
                    </th>
                    <td>
                      {m.submissions} / {m.images}
                    </td>
                    <td>{m.encodedBytes}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </>
      ) : (
        <p>No diagnostics available.</p>
      )}
    </details>
  );
}
