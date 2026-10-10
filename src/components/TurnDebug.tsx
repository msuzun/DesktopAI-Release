import { useEffect, useState } from "react";
import type { TurnSnapshot } from "../providers/realtime/turns/TurnCoordinator";
export function TurnDebug({
  turn,
  control,
}: {
  turn: TurnSnapshot;
  control: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const stamp = (v: number | null) =>
    v === null ? "—" : new Date(v).toISOString();
  const ms = (a: number | null, b: number | null) =>
    a === null || b === null ? "Unavailable" : `${Math.max(0, b - a)} ms`;
  const latest = turn.ledger.filter((r) => r.submittedAt !== null).at(-1);
  const rows: Record<string, string> = {
    "Current screen context": turn.enabled ? "Every turn" : "On demand",
    "Provider Response Control":
      turn.freshness === "FAILED" && turn.responseRequestedAt !== null
        ? "FALLBACK"
        : control,
    "Current turn": turn.turnId ?? "—",
    "Turn state": turn.state,
    "Visual failure": turn.visualFailure
      ? `${turn.visualFailure.stage} / ${turn.visualFailure.code}`
      : "None",
    Freshness: turn.freshness,
    "User turn completed": stamp(turn.completedAt),
    "Preparation requested": stamp(turn.captureStartedAt),
    "Selected source observed": stamp(turn.capturedAt),
    "Preparation completed": stamp(turn.captureCompletedAt),
    "Provider submission started": stamp(turn.submissionStartedAt),
    "Visual submitted": stamp(turn.submittedAt),
    "Response requested": stamp(turn.responseRequestedAt),
    "Readback duration":
      turn.captureDurationMs === null
        ? "—"
        : `${turn.captureDurationMs.toFixed(1)} ms`,
    Encoding:
      turn.encodingDurationMs === null
        ? "—"
        : `${turn.encodingDurationMs.toFixed(1)} ms`,
    "Stabilization / slot wait":
      turn.stabilizationWaitMs === null
        ? "—"
        : `${turn.stabilizationWaitMs.toFixed(1)} ms`,
    "Turn end → capture request": ms(turn.completedAt, turn.captureStartedAt),
    "Capture complete → submitted": ms(
      turn.captureCompletedAt,
      turn.submittedAt,
    ),
    "Submitted → response request": ms(
      turn.submittedAt,
      turn.responseRequestedAt,
    ),
    "Response barrier duration": ms(turn.completedAt, turn.responseRequestedAt),
    "Provider submission duration": ms(
      turn.submissionStartedAt,
      turn.submittedAt,
    ),
    "Turn to visual submission": ms(turn.completedAt, turn.submittedAt),
    "Turn end → first AI audio": ms(turn.completedAt, turn.firstAudioAt),
    "Latest AI visual captured": stamp(latest?.capturedAt ?? null),
    "Latest AI visual age":
      latest?.capturedAt != null
        ? `${Math.max(0, now - latest.capturedAt)} ms`
        : "—",
    "Latest AI visual source / turn": latest
      ? `${latest.source} / ${latest.turnId ?? "on demand"} / ${latest.freshness}`
      : "None submitted",
  };
  return (
    <details>
      <summary>Visual Turn Sync</summary>
      <p>
        The local preview is separate from images submitted to the AI. Freshness
        belongs to a specific voice turn.
      </p>
      {turn.error && <p role="status">{turn.error}</p>}
      <dl>
        {Object.entries(rows).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>
          Visual submission ledger ({turn.ledger.length}/20, metadata only)
        </summary>
        <ul>
          {turn.ledger.map((r, i) => (
            <li key={i}>
              {r.turnId ?? "On demand"} · {r.source} · {r.kind} · {r.freshness}{" "}
              · captured {stamp(r.capturedAt)} · submitted{" "}
              {stamp(r.submittedAt)} · {r.provider}
            </li>
          ))}
        </ul>
      </details>
    </details>
  );
}
