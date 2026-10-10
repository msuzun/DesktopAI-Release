import type { CapturedFrame } from "../api";

const decisions = {
  baseline: "Baseline frame established.",
  resolution_changed: "Resolution changed. New baseline established.",
  no_meaningful_change: "NO MEANINGFUL CHANGE",
  meaningful_change: "MEANINGFUL CHANGE",
};

export function ChangeDetectionPanel({
  frame,
}: {
  frame: CapturedFrame | null;
}) {
  const analysis = frame?.analysis;
  return (
    <section className="debug" aria-labelledby="change-heading">
      <h2 id="change-heading">Visual Change Detection</h2>
      <dl>
        <div>
          <dt>Previous frame</dt>
          <dd>
            {analysis?.previousFrameAvailable ? "Available" : "Not Available"}
          </dd>
        </div>
        <div>
          <dt>Current frame</dt>
          <dd>{frame ? "Available" : "Not Available"}</dd>
        </div>
        <div>
          <dt>Change score</dt>
          <dd>{analysis?.changeScore?.toFixed(4) ?? "—"}</dd>
        </div>
        <div>
          <dt>Threshold used</dt>
          <dd>{analysis?.threshold.toFixed(4) ?? "—"}</dd>
        </div>
        <div>
          <dt>Analysis resolution</dt>
          <dd>
            {analysis
              ? `${analysis.analysisWidth} × ${analysis.analysisHeight} px`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Analysis duration</dt>
          <dd>{frame ? `${frame.analysisDurationMs.toFixed(2)} ms` : "—"}</dd>
        </div>
      </dl>
      <p
        role="status"
        className={
          analysis?.decision === "meaningful_change"
            ? "change-decision changed"
            : "change-decision"
        }
      >
        {analysis
          ? decisions[analysis.decision]
          : "Capture a frame to establish a baseline."}
      </p>
      <p className="analysis-note">
        Results describe the latest successful capture. The preview and this
        panel can affect the score when visible on the captured display.
      </p>
    </section>
  );
}
