import type { useRealtimeVoice } from "../../hooks/useRealtimeVoice";
import { LiveDiagnosticsPanel } from "./LiveDiagnosticsPanel";
const milliseconds = (value: number | null) =>
  value === null ? "Unavailable" : `${Math.round(value)} ms`;
export function VoiceDiagnostics({
  controls,
}: {
  controls: ReturnType<typeof useRealtimeVoice>;
}) {
  const { voice, runtimeSupport } = controls;
  return (
    <section aria-label="Voice diagnostics">
      <p>
        {voice.provider} / {voice.connection} / {voice.conversation} /
        Microphone: {voice.microphone}
      </p>
      {voice.error && <p>{voice.error}</p>}
      {voice.notice && <p>{voice.notice}</p>}
      {voice.pipeline && (
        <details className="voice-debug">
          <summary>Composed voice pipeline</summary>
          <p>
            Transport: HTTP · Native Live session: No · State:{" "}
            {voice.pipeline.state}
          </p>
          <dl>
            {Object.entries(voice.pipeline.timings).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{milliseconds(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="analysis-note">
            Current turn measurements. First audio marks playback scheduling,
            not measured speaker output. No audio, image, credential or prompt
            payloads.
          </p>
        </details>
      )}
      <details className="voice-debug">
        <summary>Transcript debug</summary>
        <p className="analysis-note">
          Temporary generated transcripts, not a recording. They may arrive out
          of order or include unheard words before an interruption is processed.
          Cleared on stop.
        </p>
        <div className="voice-scroll">
          {voice.transcripts.length ? (
            voice.transcripts.map((entry) => (
              <p key={entry.id}>
                <strong>{entry.role}</strong>
                <br />
                {entry.text}
              </p>
            ))
          ) : (
            <p>No transcript yet.</p>
          )}
        </div>
      </details>
      <details className="voice-debug">
        <summary>Realtime Debug</summary>
        <p className="analysis-note">
          WebView support — Secure context:{" "}
          {runtimeSupport.secureContext ? "Yes" : "No"}; WebRTC:{" "}
          {runtimeSupport.webRtc ? "Available" : "Unavailable"}; Microphone API:{" "}
          {runtimeSupport.microphone ? "Available" : "Unavailable"}. Device
          permission is checked when starting.
        </p>
        <dl>
          <div>
            <dt>Connection (includes permission)</dt>
            <dd>{milliseconds(voice.metrics.connectionMs)}</dd>
          </div>
          <div>
            <dt>Turn end → audio output start</dt>
            <dd>{milliseconds(voice.metrics.turnToAudioMs)}</dd>
          </div>
          <div>
            <dt>Audio output duration</dt>
            <dd>{milliseconds(voice.metrics.audioDurationMs)}</dd>
          </div>
        </dl>
        <p className="analysis-note">
          Event-arrival measurements, not exact speaker latency. Latest 80
          events; no audio payloads or credentials.
        </p>
        <ol className="voice-scroll">
          {voice.events.map((event, index) => (
            <li key={`${event.at}:${index}`}>
              {new Date(event.at).toLocaleTimeString()} · {event.message}
            </li>
          ))}
        </ol>
      </details>
      {voice.diagnostics && <LiveDiagnosticsPanel report={voice.diagnostics} />}
      {controls.session.lastResponseFailure && (
        <details>
          <summary>Last timed-out response</summary>
          <LiveDiagnosticsPanel report={controls.session.lastResponseFailure} />
        </details>
      )}
    </section>
  );
}
