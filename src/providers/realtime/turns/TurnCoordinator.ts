import type { VisualContext, VisualDelivery } from "../visual/types.js";
import { releaseContext } from "../visual/TemporalContext.js";
import {
  safePreflightFailure,
  type VisualSelectionTiming,
} from "../preflight/VisualIntentPreflight.js";
export type TurnEvent = {
  type:
    | "speech_started"
    | "speech_boundary"
    | "speech_resumed"
    | "turn_completed"
    | "transcript_final"
    | "response_started"
    | "first_audio"
    | "response_done"
    | "response_failed";
  key?: string;
  message?: string;
  completedMonotonicAt?: number;
  transcript?: string;
};
export type Freshness =
  "FRESH" | "STALE" | "HISTORICAL" | "UNAVAILABLE" | "FAILED" | "NOT_REQUIRED";
export interface SubmissionRecord {
  turnId: string | null;
  capturedAt: number | null;
  submittedAt: number | null;
  provider: string;
  source: "TURN_SYNCHRONIZED" | "ON_DEMAND_AI_REQUEST";
  kind: string;
  freshness: Freshness;
  imageCount?: number;
  acknowledged?: boolean;
}
export interface TurnSnapshot {
  enabled: boolean;
  state:
    | "IDLE"
    | "USER_SPEAKING"
    | "WAITING_FOR_VISUAL"
    | "VISUAL_READY"
    | "VISUAL_FAILED"
    | "RESPONSE_FAILED"
    | "WAITING_FOR_AI_RESPONSE"
    | "AI_RESPONDING";
  turnId: string | null;
  capturedAt: number | null;
  completedAt: number | null;
  captureStartedAt: number | null;
  captureCompletedAt: number | null;
  submissionStartedAt: number | null;
  submittedAt: number | null;
  responseRequestedAt: number | null;
  firstAudioAt: number | null;
  freshness: Freshness;
  captureDurationMs: number | null;
  encodingDurationMs: number | null;
  stabilizationWaitMs: number | null;
  error: string | null;
  visualFailure?: {
    stage: "ROUTING" | "CAPTURE" | "FRESHNESS" | "DELIVERY";
    code: string;
  };
  ledger: SubmissionRecord[];
}
export interface TurnPort {
  selectionTiming?(): VisualSelectionTiming;
  /** Application-owned semantic preparation; null means a validated nonvisual turn. */
  prepare?(
    turnId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{
    frame: VisualContext | null;
    validate(): Promise<void>;
    submitted(): void;
    release(): void;
  }>;
  beginTurn?(
    turnId: string,
    completedMonotonicAt?: number,
    conversationId?: string,
  ): void;
  reserveTurn?(): void;
  active(): boolean;
  permitted(): boolean;
  provider: string;
  maxImageBytes(): number;
  capture(
    turnId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<VisualContext>;
  submit(frame: VisualContext, signal: AbortSignal): Promise<VisualDelivery>;
  respond(turnId: string, freshness: Freshness): void;
}
const initial = (): TurnSnapshot => ({
  enabled: false,
  state: "IDLE",
  turnId: null,
  capturedAt: null,
  completedAt: null,
  captureStartedAt: null,
  captureCompletedAt: null,
  submittedAt: null,
  submissionStartedAt: null,
  responseRequestedAt: null,
  firstAudioAt: null,
  freshness: "NOT_REQUIRED",
  captureDurationMs: null,
  encodingDurationMs: null,
  stabilizationWaitMs: null,
  error: null,
  visualFailure: undefined,
  ledger: [],
});
const noAudioNotice =
  "No AI audio received within 15 seconds of the response request. Try Restore automatic voice, then ask again.";
export class TurnCoordinator {
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private port: TurnPort | null = null;
  private prefix = crypto.randomUUID().slice(0, 8);
  private sequence = 0;
  private key: string | null = null;
  private completed = new Set<string>();
  private job: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private boundaryAt: number | null = null;
  private finalText: string | null = null;
  constructor(
    private now = () => Date.now(),
    private timeoutMs = 2500,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(patch: Partial<TurnSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  attach(port: TurnPort) {
    this.detach();
    this.port = port;
  }
  resetTurn() {
    this.cancel();
    this.key = null;
    this.finalText = null;
    this.completed.clear();
    const ledger = this.snapshot.ledger;
    this.snapshot = { ...initial(), ledger };
    this.publish({});
  }
  detach() {
    this.cancel();
    this.port = null;
    this.completed.clear();
    this.key = null;
    this.finalText = null;
    this.snapshot = initial();
    this.publish({});
  }
  private cancel() {
    if (this.responseTimer) clearTimeout(this.responseTimer);
    this.responseTimer = null;
    this.job?.abort();
    this.job = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  setEnabled(enabled: boolean) {
    this.publish({ enabled });
    if (
      !enabled &&
      (this.snapshot.state === "WAITING_FOR_VISUAL" ||
        this.snapshot.state === "VISUAL_READY" ||
        this.snapshot.state === "VISUAL_FAILED")
    ) {
      const id = this.snapshot.turnId;
      this.cancel();
      if (id)
        this.release(
          id,
          "FAILED",
          "Fresh visual mode or permission was revoked.",
        );
    }
  }
  record(record: SubmissionRecord) {
    this.publish({ ledger: [...this.snapshot.ledger.slice(-19), record] });
  }
  private renewVisualTurn(reserve = false) {
    const id = `turn_${this.prefix}_${++this.sequence}`;
    this.port!.beginTurn?.(id, performance.now(), this.key ?? id);
    if (reserve) this.port!.reserveTurn?.();
    this.publish({
      turnId: id,
      capturedAt: null,
      captureCompletedAt: null,
      submissionStartedAt: null,
      submittedAt: null,
      captureDurationMs: null,
      encodingDurationMs: null,
      stabilizationWaitMs: null,
    });
    return id;
  }
  retryVisual() {
    if (
      this.snapshot.state !== "VISUAL_FAILED" ||
      !this.snapshot.enabled ||
      !this.port?.active() ||
      !this.port.permitted() ||
      !this.snapshot.turnId
    )
      return;
    // The user explicitly asked to try the screen now. An expired reservation,
    // failed selection or cancelled native epoch cannot serve another attempt.
    // Keep the spoken question's identity, but select a new visual moment.
    const id =
      this.port.selectionTiming?.() === "before_response"
        ? this.snapshot.turnId
        : this.renewVisualTurn();
    void this.synchronize(id);
  }
  event(event: TurnEvent) {
    if (!this.port?.active()) return;
    if (event.type === "response_failed") {
      this.cancel();
      this.publish({
        state: "RESPONSE_FAILED",
        error:
          event.message ??
          "Voice response failed. Restart the fresh voice connection.",
      });
      return;
    }
    if (event.type === "speech_started") {
      if (event.key === this.key && this.snapshot.turnId !== null) return;
      if (this.key && this.snapshot.state === "USER_SPEAKING") {
        if (this.completed.size >= 64)
          this.completed.delete(this.completed.values().next().value!);
        this.completed.add(this.key);
      }
      this.cancel();
      this.boundaryAt = null;
      this.finalText = null;
      this.key = event.key ?? null;
      this.publish({
        ...initial(),
        enabled: this.snapshot.enabled,
        ledger: this.snapshot.ledger.map((r) => ({
          ...r,
          freshness: r.freshness === "FRESH" ? "STALE" : r.freshness,
        })),
        turnId: `turn_${this.prefix}_${++this.sequence}`,
        state: "USER_SPEAKING",
        freshness: "STALE",
      });
      this.port.beginTurn?.(
        this.snapshot.turnId!,
        undefined,
        this.key ?? this.snapshot.turnId!,
      );
      return;
    }
    if (event.type === "transcript_final") {
      if (
        event.key !== this.key ||
        this.finalText !== null ||
        !event.transcript?.trim() ||
        new TextEncoder().encode(event.transcript).length > 8192
      )
        return;
      this.finalText = event.transcript;
      if (
        this.port.prepare &&
        this.snapshot.state === "WAITING_FOR_VISUAL" &&
        this.snapshot.completedAt !== null &&
        !this.job
      ) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        void this.synchronize(this.snapshot.turnId!);
      }
      return;
    }
    if (event.type === "speech_boundary" || event.type === "speech_resumed") {
      if (
        event.key !== this.key ||
        this.snapshot.state !== "USER_SPEAKING" ||
        !this.snapshot.enabled ||
        !this.port.permitted() ||
        !this.port.reserveTurn
      )
        return;
      this.boundaryAt =
        event.type === "speech_boundary"
          ? (event.completedMonotonicAt ?? performance.now())
          : null;
      // Current-screen sharing selects after transcription. Reserving now would
      // spend the image's delivery lifetime waiting for speech recognition.
      if (this.port.selectionTiming?.() === "before_response") return;
      // A resumed utterance invalidates the provisional endpoint without an
      // image readback or provider submission. Only one native snapshot exists.
      const id = `turn_${this.prefix}_${++this.sequence}`;
      this.publish({ turnId: id });
      this.port.beginTurn?.(id, this.boundaryAt ?? undefined, this.key ?? id);
      if (this.boundaryAt !== null) this.port.reserveTurn();
      return;
    }
    if (event.type === "turn_completed") {
      const key = event.key ?? this.key;
      if (!key || this.completed.has(key)) return;
      if (this.completed.size >= 64)
        this.completed.delete(this.completed.values().next().value!);
      this.completed.add(key);
      if (this.key && this.key !== key) return;
      if (!this.snapshot.turnId) {
        this.event({ type: "speech_started", key });
      }
      const id = this.snapshot.turnId!;
      const monotonicNow = performance.now();
      const completed =
        this.boundaryAt ?? event.completedMonotonicAt ?? monotonicNow;
      this.publish({
        completedAt: this.now() - Math.max(0, monotonicNow - completed),
      });
      this.port.beginTurn?.(id, completed, this.key ?? id);
      if (!this.snapshot.enabled) {
        this.release(id, "NOT_REQUIRED");
        return;
      }
      if (!this.port.permitted()) {
        this.release(
          id,
          "FAILED",
          "Visual permission is unavailable. Response remains blocked.",
        );
        return;
      }
      if (this.port.prepare && this.finalText === null) {
        this.publish({ state: "WAITING_FOR_VISUAL" });
        this.timer = setTimeout(() => {
          this.timer = null;
          this.release(
            id,
            "FAILED",
            "No finalized transcript was available for local visual routing.",
          );
        }, this.timeoutMs);
      } else void this.synchronize(id);
      return;
    }
    if (
      event.type === "response_started" &&
      this.snapshot.state === "WAITING_FOR_AI_RESPONSE"
    )
      this.publish({ state: "AI_RESPONDING" });
    if (
      event.type === "first_audio" &&
      this.snapshot.state !== "RESPONSE_FAILED" &&
      this.snapshot.responseRequestedAt !== null &&
      this.snapshot.firstAudioAt === null
    ) {
      if (this.responseTimer) clearTimeout(this.responseTimer);
      this.responseTimer = null;
      this.publish({
        firstAudioAt: this.now(),
        state: "AI_RESPONDING",
        error:
          this.snapshot.error === noAudioNotice ? null : this.snapshot.error,
      });
    }
    if (
      event.type === "response_done" &&
      this.snapshot.state === "AI_RESPONDING"
    )
      this.publish({ state: "IDLE" });
  }
  private valid(id: string, job: AbortController) {
    return (
      this.job === job &&
      !job.signal.aborted &&
      this.snapshot.turnId === id &&
      !!this.port?.active() &&
      this.snapshot.enabled &&
      this.port.permitted()
    );
  }
  private async synchronize(id: string) {
    const port = this.port!;
    if (
      !port?.active() ||
      !this.snapshot.enabled ||
      this.snapshot.turnId !== id
    )
      return;
    if (!port.permitted()) {
      this.publish({
        visualFailure: { stage: "CAPTURE", code: "permission_denied" },
      });
      this.release(id, "FAILED", "Visual permission is unavailable.");
      return;
    }
    // Only explicit Current sharing may select a new visual moment. Semantic
    // current/history/compare routes retain their original endpoint identity.
    if (port.selectionTiming?.() === "before_response")
      id = this.renewVisualTurn(true);
    let stage: "CAPTURE" | "FRESHNESS" | "DELIVERY" = "CAPTURE";
    const job = new AbortController();
    let frame: VisualContext | undefined;
    let prepared:
      Awaited<ReturnType<NonNullable<TurnPort["prepare"]>>> | undefined;
    this.job = job;
    this.publish({
      state: "WAITING_FOR_VISUAL",
      captureStartedAt: this.now(),
      freshness: "STALE",
      error: null,
      visualFailure: undefined,
    });
    this.timer = setTimeout(() => {
      if (this.job !== job) return;
      this.publish({ visualFailure: { stage, code: "timeout" } });
      this.cancel();
      this.release(
        id,
        "FAILED",
        `Fresh visual synchronization timed out (${this.timeoutMs} ms budget).`,
      );
    }, this.timeoutMs);
    try {
      if (port.prepare) {
        if (!this.finalText) throw new Error("missing finalized transcript");
        prepared = await port.prepare(id, this.finalText, job.signal);
        if (!this.valid(id, job)) return;
        await prepared.validate();
        if (!this.valid(id, job)) return;
        if (!prepared.frame) {
          this.cancel();
          this.release(id, "NOT_REQUIRED");
          return;
        }
        frame = prepared.frame;
      } else frame = await port.capture(id, port.maxImageBytes(), job.signal);
      if (!this.valid(id, job)) return;
      stage = "FRESHNESS";
      if (
        !prepared &&
        (frame.context
          ? frame.context.kind !== "current" ||
            !frame.frames?.length ||
            !["Fresh", "Stale"].includes(frame.context.freshness) ||
            frame.frames[0].ageMs > (frame.currentMaxAgeMs ?? 500)
          : frame.timestampUnixMs < this.snapshot.completedAt!)
      )
        throw new Error("stale capture");
      const freshness = frame.context
        ? (
            {
              Fresh: "FRESH",
              Stale: "STALE",
              Historical: "HISTORICAL",
              Unavailable: "UNAVAILABLE",
            } as const
          )[frame.context.freshness]
        : "FRESH";
      const capturedAt =
        frame.context && !frame.frames?.length ? null : frame.timestampUnixMs;
      frame.visual = {
        turnId: id,
        freshness,
        source: "TURN_SYNCHRONIZED",
      };
      this.publish({
        state: "VISUAL_READY",
        capturedAt,
        captureCompletedAt: this.now(),
        captureDurationMs: frame.metadata.captureDurationMs,
        encodingDurationMs: frame.metadata.encodingDurationMs,
        stabilizationWaitMs: frame.metadata.stabilizationWaitMs ?? null,
      });
      stage = "DELIVERY";
      this.publish({ submissionStartedAt: this.now() });
      await prepared?.validate();
      if (!this.valid(id, job)) return;
      const receipt = await port.submit(frame, job.signal);
      if (!this.valid(id, job)) return;
      if (!receipt.sent || receipt.acknowledged === false)
        throw new Error("delivery failed");
      prepared?.submitted();
      const submittedAt = this.now();
      this.publish({ submittedAt });
      this.record({
        turnId: id,
        capturedAt,
        submittedAt,
        provider: port.provider,
        source: "TURN_SYNCHRONIZED",
        kind: frame.kind ?? "context",
        freshness,
        imageCount: frame.frames?.length ?? (frame.base64 ? 1 : 0),
        acknowledged: receipt.acknowledged === true,
      });
      this.cancel();
      this.release(id, freshness);
    } catch (cause) {
      if (this.job !== job || job.signal.aborted) return;
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : undefined;
      const routingFailure =
        stage === "CAPTURE" &&
        !!port.prepare &&
        typeof cause === "object" &&
        cause !== null &&
        "stage" in cause &&
        cause.stage === "ROUTING";
      const allowedCodes = [
        "capture_busy",
        "permission_denied",
        "visual_session_inactive",
        "session_idle",
        "capture_cancelled",
        "session_unavailable",
        "capture_failed",
        "image_too_large",
        "invalid_threshold",
        "invalid_region",
        "capture_worker_failed",
        "current_unavailable",
        "snapshot_expired",
        "generation_changed",
        "visual_busy",
        "visual_limit_reached",
        "readback_failed",
        "encoding_failed",
      ];
      this.publish({
        visualFailure: {
          stage: routingFailure ? "ROUTING" : stage,
          code: routingFailure
            ? safePreflightFailure(code)
            : typeof code === "string" && allowedCodes.includes(code)
              ? code
              : "failed",
        },
      });
      this.cancel();
      this.release(
        id,
        "FAILED",
        "Visual context preparation or delivery failed. Turn Screen Awareness off to continue by voice, or retry visual context.",
      );
    } finally {
      if (prepared) prepared.release();
      else if (frame?.context) releaseContext(frame);
    }
  }
  private release(
    id: string,
    freshness: Freshness,
    error: string | null = null,
  ) {
    if (
      this.snapshot.turnId !== id ||
      !this.port?.active() ||
      this.snapshot.responseRequestedAt !== null
    )
      return;
    if (freshness === "FAILED")
      this.record({
        turnId: id,
        capturedAt: this.snapshot.capturedAt,
        submittedAt: null,
        provider: this.port.provider,
        source: "TURN_SYNCHRONIZED",
        kind: "context",
        freshness,
      });
    // Semantic preparation may deliberately deliver historical or unavailable
    // evidence. It still needs a validated envelope and successful receipt.
    // Capture-only mode retains its existing fresh-image requirement.
    if (
      this.snapshot.enabled &&
      !(
        this.port.prepare &&
        ["NOT_REQUIRED", "HISTORICAL", "UNAVAILABLE"].includes(freshness)
      ) &&
      freshness !== "FRESH" &&
      freshness !== "STALE"
    ) {
      this.publish({
        state: "VISUAL_FAILED",
        freshness: "FAILED",
        error: error ?? "Response blocked until a fresh image is delivered.",
      });
      return;
    }
    this.publish({
      freshness,
      error,
      state: "WAITING_FOR_AI_RESPONSE",
      responseRequestedAt: this.now(),
    });
    try {
      this.responseTimer = setTimeout(() => {
        this.responseTimer = null;
        if (
          this.snapshot.turnId === id &&
          this.port?.active() &&
          this.snapshot.firstAudioAt === null
        )
          this.publish({ error: noAudioNotice });
      }, 15000);
      this.port.respond(id, freshness);
    } catch {
      if (this.responseTimer) clearTimeout(this.responseTimer);
      this.responseTimer = null;
      this.publish({
        state: "IDLE",
        error:
          "Provider response request failed. Stop and restart the AI session.",
      });
    }
  }
}
