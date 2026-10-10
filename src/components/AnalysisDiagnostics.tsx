import type { TemporalDiagnostics } from "./TemporalMemoryDiagnostics";
import type { RecentGpuDiagnostics } from "./RecentGpuCacheDiagnostics";
import type { EventDiagnostics } from "./VisualEventDiagnostics";
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Geometry {
  sourceWidth: number;
  sourceHeight: number;
  analysisWidth: number;
  analysisHeight: number;
  tileColumns: number;
  tileRows: number;
}
interface Metrics {
  globalChangeScore: number;
  changedAreaRatio: number;
  changedTileCount: number;
  totalTileCount: number;
  classification: string;
  changeBounds: Bounds | null;
}
export interface AnalysisSnapshot {
  events: EventDiagnostics;
  recentGpu: RecentGpuDiagnostics;
  temporal: TemporalDiagnostics;
  statistics: {
    state: string;
    analysisFps: number;
    analyzedFrames: number;
    baselineFrames: number;
    skippedAnalysisInputs: number;
    duplicateInputs: number;
    analysisFailures: number;
    baselineResets: number;
    resourceSetsCreated: number;
    readbackNotReadyCount: number;
    pendingReadbacks: number;
    compactReadbackBytes: number;
    lumaReadbackBytes: number;
    lumaStagingBytes: number;
    lumaScratchBytes: number;
    largeChangeCount: number;
    mediumChangeCount: number;
    smallChangeCount: number;
    noChangeCount: number;
    averageAnalysisTotalMs: number;
    maximumAnalysisTotalMs: number;
    maximumSourceAgeMs: number;
    config: {
      pixelNoiseThreshold: number;
      tileChangeThreshold: number;
      mediumArea: number;
      largeArea: number;
    };
    lastChange: {
      sourceFrameId: number;
      analysisSequence: number;
      classification: string;
      bounds: Bounds | null;
      score: number;
      area: number;
    } | null;
    error: {
      stage: string;
      message: string;
      recoverable: boolean;
      hresult: number | null;
    } | null;
  };
  latest: {
    kind: string;
    captureGeneration: number;
    sourceFrameId: number;
    previousSourceFrameId: number | null;
    perceptionSequence: number;
    analysisSequence: number;
    geometry: Geometry;
    metrics: Metrics | null;
    analysisTotalMs: number;
    dispatchCpuMs: number;
    completionReadbackLatencyMs: number;
    cpuResultProcessingMs: number;
    sourceAgeAtPublicationMs: number;
    perceptionToPublicationMs: number;
  } | null;
}
function bounds(value: Bounds | null) {
  return value
    ? `x ${value.x.toFixed(3)}, y ${value.y.toFixed(3)}, w ${value.width.toFixed(3)}, h ${value.height.toFixed(3)}`
    : "None";
}
const ms = (value: number) => `${value.toFixed(2)} ms`;
export function AnalysisDiagnostics({
  snapshot,
}: {
  snapshot: AnalysisSnapshot;
}) {
  const s = snapshot.statistics;
  const r = snapshot.latest;
  const m = r?.metrics;
  return (
    <details className="voice-debug">
      <summary>GPU Temporal Analysis</summary>
      <p>
        Local GPU downsample, luma and tile comparison. Results are metadata
        only. Counters reset each session. Timing includes CPU scheduling and
        readback; it is not GPU execution time.
      </p>
      <dl>
        {Object.entries({
          "Analysis state": s.state,
          "Analysis FPS": s.analysisFps.toFixed(2),
          "Completed analyses": s.analyzedFrames,
          "Baseline frames": s.baselineFrames,
          "Skipped analysis inputs": s.skippedAnalysisInputs,
          "Duplicate inputs rejected": s.duplicateInputs,
          "Baseline resets": s.baselineResets,
          "GPU resource sets created": s.resourceSetsCreated,
          "Pending GPU readbacks": `${s.pendingReadbacks} / 1`,
          "Readback not ready": s.readbackNotReadyCount,
          "Compact bytes read": s.compactReadbackBytes,
          "Low-resolution luma bytes read": s.lumaReadbackBytes,
          "Luma staging footprint (row pitch included)": s.lumaStagingBytes,
          "Reusable luma CPU scratch bytes": s.lumaScratchBytes,
          "No / small / medium / large changes": `${s.noChangeCount} / ${s.smallChangeCount} / ${s.mediumChangeCount} / ${s.largeChangeCount}`,
          "Average / maximum analysis E2E": `${ms(s.averageAnalysisTotalMs)} / ${ms(s.maximumAnalysisTotalMs)}`,
          "Maximum source age at publication": ms(s.maximumSourceAgeMs),
          "Analysis errors": s.analysisFailures,
          "Pixel noise / tile threshold": `${s.config.pixelNoiseThreshold.toFixed(4)} / ${s.config.tileChangeThreshold.toFixed(4)}`,
        }).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {r && (
        <dl>
          {Object.entries({
            "Result kind": r.kind,
            "Analysis / perception sequence": `${r.analysisSequence} / ${r.perceptionSequence}`,
            "Current / previous source": `${r.sourceFrameId} / ${r.previousSourceFrameId ?? "None"}`,
            "Analysis capture generation": r.captureGeneration,
            "Source → analysis size": `${r.geometry.sourceWidth} × ${r.geometry.sourceHeight} → ${r.geometry.analysisWidth} × ${r.geometry.analysisHeight}`,
            "Tile grid": `${r.geometry.tileColumns} × ${r.geometry.tileRows}`,
            "Global change score":
              m?.globalChangeScore.toFixed(5) ?? "Baseline",
            "Changed area": m
              ? `${(m.changedAreaRatio * 100).toFixed(2)}%`
              : "Baseline",
            "Changed tiles": m
              ? `${m.changedTileCount} / ${m.totalTileCount}`
              : "Baseline",
            Classification: m?.classification ?? "Baseline",
            "Normalized bounds": bounds(m?.changeBounds ?? null),
            "Analysis E2E": ms(r.analysisTotalMs),
            "Dispatch CPU": ms(r.dispatchCpuMs),
            "Dispatch through completion/readback": ms(
              r.completionReadbackLatencyMs,
            ),
            "CPU result processing": ms(r.cpuResultProcessingMs),
            "Perception to publication": ms(r.perceptionToPublicationMs),
            "Source age at publication": ms(r.sourceAgeAtPublicationMs),
          }).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {s.lastChange && (
        <p>
          Last nonzero change (retained diagnostic):{" "}
          {s.lastChange.classification}, source #{s.lastChange.sourceFrameId},
          analysis #{s.lastChange.analysisSequence}; score{" "}
          {s.lastChange.score.toFixed(5)}, area{" "}
          {(s.lastChange.area * 100).toFixed(2)}%; bounds{" "}
          {bounds(s.lastChange.bounds)}.
        </p>
      )}
      {s.error && (
        <p role="alert">
          Last analysis error: {s.error.stage}: {s.error.message}
        </p>
      )}
    </details>
  );
}
