import type { CapturedFrame } from "../api";

export function DebugPanel({ frame }: { frame: CapturedFrame | null }) {
  return (
    <section className="debug">
      <h2>Capture details</h2>
      <dl>
        <div>
          <dt>Timestamp</dt>
          <dd>{frame ? new Date(frame.timestampUnixMs).toISOString() : "—"}</dd>
        </div>
        <div>
          <dt>Original resolution</dt>
          <dd>
            {frame
              ? `${frame.originalWidth} × ${frame.originalHeight} px`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Encoded image resolution</dt>
          <dd>{frame ? `${frame.width} × ${frame.height} px` : "—"}</dd>
        </div>
        <div>
          <dt>Encoded size</dt>
          <dd>
            {frame ? `${frame.encodedSizeBytes.toLocaleString()} bytes` : "—"}
          </dd>
        </div>
        <div>
          <dt>Capture duration</dt>
          <dd>{frame ? `${frame.captureDurationMs.toFixed(1)} ms` : "—"}</dd>
        </div>
        <div>
          <dt>Encoding duration</dt>
          <dd>{frame ? `${frame.encodingDurationMs.toFixed(1)} ms` : "—"}</dd>
        </div>
        <div>
          <dt>Total processing</dt>
          <dd>{frame ? `${frame.totalDurationMs.toFixed(1)} ms` : "—"}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>{frame ? frame.encoding.toUpperCase() : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
