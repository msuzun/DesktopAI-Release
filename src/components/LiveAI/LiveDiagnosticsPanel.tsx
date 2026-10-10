import { useState } from "react";
import type { LiveDiagnosticSnapshot } from "../../providers/realtime/gemini/LiveDiagnostics";

export function LiveDiagnosticsPanel({
  report,
}: {
  report: LiveDiagnosticSnapshot;
}) {
  const [status, setStatus] = useState("");
  const json = JSON.stringify(report, null, 2);
  return (
    <details className="voice-debug">
      <summary>Gemini response diagnostics</summary>
      <p>
        Gate: {report.gate} · Issue: {report.issue ?? "None"} · Audio context:{" "}
        {report.audioContext}
      </p>
      <p>
        Audio chunks received / dropped / scheduled:{" "}
        {report.counters.audioReceived} / {report.counters.audioDropped} /{" "}
        {report.counters.audioScheduled}. Pending tools: {report.pendingTools}.
        Socket queue: {report.socketBufferedBytes} bytes.
      </p>
      <p>
        Metadata only: no transcripts, images, audio, API keys or connection
        URLs. Copy before restarting; restarting clears this report. Scheduled
        audio does not confirm audible speaker output.
      </p>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(json).then(
            () => setStatus("Copied"),
            () =>
              setStatus("Copy unavailable. Select and copy the report below."),
          );
        }}
      >
        Copy diagnostic report
      </button>
      <p role="status">{status}</p>
      <textarea
        aria-label="Diagnostic report"
        readOnly
        value={json}
        rows={12}
        style={{ width: "100%" }}
      />
    </details>
  );
}
