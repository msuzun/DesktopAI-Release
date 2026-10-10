import type { RoutingReadinessCode } from "../providers/realtime/preflight/RoutingReadiness.js";
import type { TurnSnapshot } from "../providers/realtime/turns/TurnCoordinator.js";

/** Present setup failures separately from capture, freshness and delivery. */
export function visualFailureNotice(
  failure: TurnSnapshot["visualFailure"],
  readiness: { code: RoutingReadinessCode },
): { key: string; canRetry: boolean; showSettings: boolean } {
  if (failure?.stage === "ROUTING") {
    if (!["currentScreen", "ready", "experimental"].includes(readiness.code))
      return {
        key: `routingReadiness.${readiness.code}`,
        canRetry: false,
        showSettings: true,
      };
    return {
      key:
        failure.code === "timeout"
          ? "home.routingTimeout"
          : failure.code === "busy"
            ? "home.routingBusy"
            : "home.routingError",
      canRetry: true,
      showSettings: true,
    };
  }
  const captureKeys: Record<string, string> = {
    current_unavailable: "home.screenUnavailable",
    image_too_large: "home.screenTooLarge",
    readback_failed: "home.screenReadbackFailed",
    encoding_failed: "home.screenEncodingFailed",
    snapshot_expired: "home.screenExpired",
    permission_denied: "home.screenPermission",
    capture_busy: "home.screenBusy",
    timeout: "home.screenTimeout",
  };
  return {
    key:
      failure?.stage === "DELIVERY"
        ? "home.screenSendingError"
        : (captureKeys[failure?.code ?? ""] ?? "home.visualError"),
    canRetry: true,
    showSettings: false,
  };
}

/** Delivery claims belong only to the completed input turn shown in Home. */
export function visualDeliveryNotice(
  turn: TurnSnapshot,
): { key: string; count: number } | null {
  if (
    !turn.enabled ||
    !turn.turnId ||
    turn.responseRequestedAt === null ||
    turn.freshness === "FAILED" ||
    !["WAITING_FOR_AI_RESPONSE", "AI_RESPONDING", "IDLE"].includes(turn.state)
  )
    return null;

  const record = [...turn.ledger]
    .reverse()
    .find((entry) => entry.turnId === turn.turnId);
  if (!record)
    return turn.freshness === "NOT_REQUIRED"
      ? { key: "home.screenNotUsed", count: 0 }
      : null;

  const count = record.imageCount;
  if (
    record.submittedAt === null ||
    record.freshness === "FAILED" ||
    count === undefined ||
    !Number.isSafeInteger(count) ||
    count < 0
  )
    return null;
  if (count === 0) return { key: "home.screenNoImage", count: 0 };
  return {
    key:
      record.acknowledged === true ? "home.screenReceived" : "home.screenSent",
    count,
  };
}
