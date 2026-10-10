import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TemporalMemoryDiagnostics } from "./TemporalMemoryDiagnostics";
import { RecentGpuCacheDiagnostics } from "./RecentGpuCacheDiagnostics";
import { VisualEventDiagnostics } from "./VisualEventDiagnostics";
import {
  AnalysisDiagnostics,
  type AnalysisSnapshot,
} from "./AnalysisDiagnostics";
type Backend = "Legacy" | "WindowsGraphicsCapture";
interface Status {
  analysis: AnalysisSnapshot | null;
  backend: Backend;
  gpuFrames: boolean;
  wgcAvailable: boolean;
  perception: {
    state: string;
    targetFps: number;
    captureGeneration: number | null;
    ticks: number;
    framesConsumed: number;
    ticksWithoutNewFrame: number;
    sourceFramesSkipped: number;
    perceptionFramesReplaced: number;
    missedDeadlines: number;
    overrunCount: number;
    actualFps: number;
    tickFps: number;
    averageTickIntervalMs: number;
    averageSchedulerJitterMs: number;
    maximumSchedulerJitterMs: number;
    averageTickProcessingMs: number;
    maximumTickProcessingMs: number;
    lastConsumedSourceFrameId: number | null;
    lastPerceptionSequence: number | null;
    lastPerceptionAgeMs: number | null;
    maximumPerceptionAgeMs: number;
    latestFrameAgeMs: number | null;
    error: string | null;
  };
  statistics: {
    state: string;
    framesReceived: number;
    framesReplaced: number;
    framesSkipped: number;
    lastFrameId: number;
    width: number;
    height: number;
    pixelFormat: string;
    poolBuffers: number;
    poolRecreations: number;
    captureErrors: number;
    readbacks: number;
    observedFps: number;
    lastFrameAgeMs: number | null;
    lastIntervalMs: number | null;
    startupMs: number;
    acquisitionMs: number;
    copySubmitMs: number;
    error: { code: string; message: string; hresult: number | null } | null;
  };
}
interface Preview {
  imageBase64: string;
  width: number;
  height: number;
}
export function CaptureDiagnostics({
  active,
  locked,
}: {
  active: boolean;
  locked: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await invoke<Status>("capture_backend_status");
        if (!disposed) setStatus(value);
      } catch {
        if (!disposed) setError("Capture diagnostics unavailable.");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ++generation.current;
    };
  }, []);
  useEffect(() => {
    ++generation.current;
    setPreview(null);
  }, [active]);
  async function select(backend: Backend) {
    setBusy(true);
    setError(null);
    try {
      await invoke("capture_backend_select", { backend });
      setPreview(null);
      setStatus(await invoke<Status>("capture_backend_status"));
    } catch {
      setError("Stop the companion before changing capture backend.");
    } finally {
      setBusy(false);
    }
  }
  async function readback() {
    const id = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const frame = await invoke<Preview>("capture_wgc_test_frame");
      if (id === generation.current) setPreview(frame);
    } catch {
      if (id === generation.current)
        setError(
          "Could not read the latest GPU frame. Check capture state and try again.",
        );
    } finally {
      setBusy(false);
    }
  }
  async function configureRate(targetFps: number) {
    setBusy(true);
    setError(null);
    try {
      await invoke("perception_configure", { targetFps });
      setStatus(await invoke<Status>("capture_backend_status"));
    } catch {
      setError("Stop the companion before changing perception rate.");
    } finally {
      setBusy(false);
    }
  }
  const s = status?.statistics;
  const p = status?.perception;
  const milliseconds = (value: number | null) =>
    value === null ? "None" : `${value.toFixed(2)} ms`;
  return (
    <details className="voice-debug">
      <summary>Capture Diagnostics</summary>
      <label>
        Capture Backend
        <select
          disabled={locked || busy || !status}
          value={status?.backend ?? "Legacy"}
          onChange={(e) => void select(e.target.value as Backend)}
        >
          <option>Legacy</option>
          {status?.wgcAvailable && <option>WindowsGraphicsCapture</option>}
        </select>
      </label>
      <p>
        WGC supplies Current and short-lived visual history while Screen
        Awareness is active. Legacy offers Current compatibility without
        history. Selection lasts for this app run. Windows 10 1903 or newer is
        required.
      </p>
      {p && (
        <>
          <h4>Local Perception</h4>
          <label>
            Perception Rate
            <select
              disabled={locked || active || busy || !status?.gpuFrames}
              value={p.targetFps}
              onChange={(e) => void configureRate(Number(e.target.value))}
            >
              <option value={10}>10 FPS</option>
              <option value={30}>30 FPS</option>
              <option value={60}>60 FPS (experimental)</option>
            </select>
          </label>
          <p>
            Stop the companion to change rate. This app-run setting controls
            local GPU sampling; capture and AI submission run independently.
            Counters reset on each start. Unread output is replaced when
            analysis falls behind. Diagnostics refresh once per second.
          </p>
          <dl>
            {Object.entries({
              "Perception state": p.state,
              "Perception target": `${p.targetFps} FPS`,
              "Perception actual (unique frames)": `${p.actualFps.toFixed(1)} FPS`,
              "Scheduler tick rate": `${p.tickFps.toFixed(1)} Hz`,
              "Capture generation": p.captureGeneration ?? "None",
              "Perception ticks": p.ticks,
              "Frames perceived": p.framesConsumed,
              "Source frames skipped between selections": p.sourceFramesSkipped,
              "Ticks without new frame": p.ticksWithoutNewFrame,
              "Unread perception frames replaced": p.perceptionFramesReplaced,
              "Missed deadlines": p.missedDeadlines,
              "Processing overruns": p.overrunCount,
              "Average tick interval": milliseconds(p.averageTickIntervalMs),
              "Average scheduler jitter": milliseconds(
                p.averageSchedulerJitterMs,
              ),
              "Maximum scheduler jitter": milliseconds(
                p.maximumSchedulerJitterMs,
              ),
              "Average tick processing": milliseconds(
                p.averageTickProcessingMs,
              ),
              "Maximum tick processing": milliseconds(
                p.maximumTickProcessingMs,
              ),
              "Last consumed source ID": p.lastConsumedSourceFrameId ?? "None",
              "Last perception sequence": p.lastPerceptionSequence ?? "None",
              "Frame age at consumption": milliseconds(p.lastPerceptionAgeMs),
              "Maximum age at consumption": milliseconds(
                p.maximumPerceptionAgeMs,
              ),
              "Latest selected frame age now": milliseconds(p.latestFrameAgeMs),
            }).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {p.error && <p role="alert">Local perception failed: {p.error}</p>}
        </>
      )}
      {status?.backend === "WindowsGraphicsCapture" && s && (
        <>
          <dl>
            {Object.entries({
              "Capture state": s.state,
              "Frames received": s.framesReceived,
              "Observed FPS (sampled)": s.observedFps.toFixed(1),
              Resolution: `${s.width} × ${s.height}`,
              "Pixel format": s.pixelFormat,
              "Last frame ID": s.lastFrameId,
              "Last frame age":
                s.lastFrameAgeMs === null
                  ? "None"
                  : `${s.lastFrameAgeMs.toFixed(1)} ms`,
              "Frame pool buffers": s.poolBuffers,
              "Frames replaced": s.framesReplaced,
              "Frames skipped": s.framesSkipped,
              "Pool recreations": s.poolRecreations,
              Readbacks: s.readbacks,
              Startup: `${s.startupMs.toFixed(1)} ms`,
              "Acquisition CPU time": `${s.acquisitionMs.toFixed(2)} ms`,
              "GPU copy submission CPU time": `${s.copySubmitMs.toFixed(2)} ms`,
              "Capture errors": s.captureErrors,
            }).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {s.error && (
            <p role="alert">
              {s.error.code}: {s.error.message} {s.error.hresult}
            </p>
          )}
          <button
            disabled={!active || busy || s.state !== "Running"}
            onClick={() => void readback()}
          >
            Capture WGC Test Frame
          </button>
          <p>
            Manual GPU-to-CPU readback only. No upload or file is created. FPS
            counts real arrivals; no 30 FPS guarantee. Copy timings measure CPU
            submission, not GPU execution.
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {status?.analysis && <AnalysisDiagnostics snapshot={status.analysis} />}
      {status?.analysis && (
        <TemporalMemoryDiagnostics
          snapshot={status.analysis.temporal}
          active={active}
        />
      )}
      {status?.analysis && (
        <RecentGpuCacheDiagnostics
          snapshot={status.analysis.recentGpu}
          active={active}
          gpuFrames={status.gpuFrames}
        />
      )}
      {status?.analysis && (
        <VisualEventDiagnostics
          snapshot={status.analysis.events}
          active={active}
          tierABytes={status.analysis.temporal.approximateMemoryBytes}
          tierBBytes={status.analysis.recentGpu.estimatedRetainedPayload}
        />
      )}
      {preview && (
        <div className="preview">
          <img
            src={`data:image/png;base64,${preview.imageBase64}`}
            alt={`Manual WGC frame, ${preview.width} by ${preview.height}`}
          />
        </div>
      )}
    </details>
  );
}
