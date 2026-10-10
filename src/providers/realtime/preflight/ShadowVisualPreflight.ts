import type {
  VisualAvailability,
  VisualIntentPreflight,
  VisualPreflightDecision,
  VisualRoute,
  PreflightMode,
  PreflightFailure,
} from "./VisualIntentPreflight.js";
import { safePreflightFailure } from "./VisualIntentPreflight.js";

export interface ShadowSnapshot {
  mode: PreflightMode;
  configured: boolean;
  requests: number;
  successes: number;
  errors: Partial<Record<PreflightFailure, number>>;
  skipped: number;
  cancelled: number;
  activeRequests: number;
  fallbackUsed: number;
  routes: Partial<Record<VisualRoute, number>>;
  p50Ms: number | null;
  p95Ms: number | null;
  latencySamples: number;
  inputTokens: number;
  requestBytes: number;
  last: {
    turnId: string;
    status: string;
    decision?: VisualPreflightDecision;
    legacyRoutes: VisualRoute[];
    automaticCurrent: boolean;
  } | null;
}
type Turn = {
  id: string;
  key: string;
  abort: AbortController;
  ended: boolean;
  text?: string;
  subject?: string;
  availability?: VisualAvailability;
  requested: boolean;
  legacyRoutes: VisualRoute[];
  automaticCurrent: boolean;
};
// Observational only: this component has no orchestrator, image or provider ports.
export class ShadowVisualPreflight {
  private snapshot: ShadowSnapshot = {
    mode: "Shadow",
    configured: false,
    requests: 0,
    successes: 0,
    errors: {},
    skipped: 0,
    cancelled: 0,
    activeRequests: 0,
    fallbackUsed: 0,
    routes: {},
    p50Ms: null,
    p95Ms: null,
    latencySamples: 0,
    inputTokens: 0,
    requestBytes: 0,
    last: null,
  };
  private turn: Turn | null = null;
  private sequence = 0;
  private previousSubject?: string;
  private contextExpiry?: ReturnType<typeof setTimeout>;
  private pendingAvailability = false;
  private latencies: number[] = [];
  private listeners = new Set<() => void>();
  constructor(
    private client: VisualIntentPreflight,
    private permitted: () => boolean,
    private timeoutMs = 2000,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(patch: Partial<ShadowSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  configure(mode: PreflightMode, configured = this.snapshot.configured) {
    if (mode === "Authoritative")
      throw new Error(
        "Authoritative routing requires measured shadow promotion; it is unavailable in this build.",
      );
    this.cancel();
    this.publish({ mode, configured });
  }
  cancel(clearContext = true) {
    if (clearContext) {
      this.previousSubject = undefined;
      clearTimeout(this.contextExpiry);
    }
    const turn = this.turn;
    this.turn = null;
    if (turn) {
      turn.text = undefined;
      turn.subject = undefined;
      turn.abort.abort();
    }
    if (this.snapshot.activeRequests)
      this.publish({
        activeRequests: 0,
        cancelled: this.snapshot.cancelled + 1,
        last: this.snapshot.last
          ? { ...this.snapshot.last, status: "cancelled" }
          : null,
      });
  }
  begin(key: string) {
    if (key === this.turn?.key) return;
    this.cancel(false);
    this.turn = {
      key,
      id: `routing_turn_${++this.sequence}`,
      abort: new AbortController(),
      ended: false,
      requested: false,
      legacyRoutes: [],
      automaticCurrent: false,
    };
  }
  async complete(key: string, availability: () => Promise<VisualAvailability>) {
    const turn = this.turn;
    if (!turn || turn.key !== key || turn.ended) return;
    turn.ended = true;
    if (
      this.snapshot.mode === "Disabled" ||
      !this.snapshot.configured ||
      !this.permitted()
    ) {
      turn.requested = true;
      turn.text = undefined;
      this.publish({
        skipped: this.snapshot.skipped + 1,
        fallbackUsed:
          this.snapshot.fallbackUsed +
          Number(this.snapshot.mode !== "Disabled"),
        last: {
          turnId: turn.id,
          status: !this.permitted()
            ? "privacy_skipped"
            : !this.snapshot.configured
              ? "not_configured"
              : "disabled",
          legacyRoutes: turn.legacyRoutes,
          automaticCurrent: turn.automaticCurrent,
        },
      });
      return;
    }
    if (this.pendingAvailability) {
      turn.requested = true;
      turn.text = undefined;
      this.publish({
        skipped: this.snapshot.skipped + 1,
        last: {
          turnId: turn.id,
          status: "availability_busy",
          legacyRoutes: turn.legacyRoutes,
          automaticCurrent: turn.automaticCurrent,
        },
      });
      return;
    }
    this.pendingAvailability = true;
    try {
      const value = await availability();
      if (this.turn !== turn || turn.abort.signal.aborted || !this.permitted())
        return;
      turn.availability = value;
      if (!turn.text)
        this.publish({
          last: {
            turnId: turn.id,
            status: "waiting_for_final_transcript",
            legacyRoutes: [...turn.legacyRoutes],
            automaticCurrent: turn.automaticCurrent,
          },
        });
      this.tryRoute(turn);
    } catch {
      if (this.turn === turn) {
        turn.requested = true;
        turn.text = undefined;
        this.publish({
          skipped: this.snapshot.skipped + 1,
          last: {
            turnId: turn.id,
            status: "availability_unavailable",
            legacyRoutes: turn.legacyRoutes,
            automaticCurrent: turn.automaticCurrent,
          },
        });
      }
    } finally {
      this.pendingAvailability = false;
    }
  }
  finalized(key: string, text: string) {
    const turn = this.turn;
    if (
      !turn ||
      turn.key !== key ||
      turn.requested ||
      !this.permitted() ||
      !this.snapshot.configured ||
      this.snapshot.mode !== "Shadow"
    )
      return;
    if (!text.trim() || new TextEncoder().encode(text).length > 8192) {
      turn.requested = true;
      turn.text = undefined;
      this.publish({
        errors: {
          ...this.snapshot.errors,
          invalid_input: (this.snapshot.errors.invalid_input ?? 0) + 1,
        },
      });
      return;
    }
    turn.text = text;
    // One bounded prior user question, retained only if the response establishes
    // visual context. Never an assistant answer, screen text or transcript log.
    turn.subject =
      new TextEncoder().encode(text).length <= 1024 ? text : undefined;
    this.tryRoute(turn);
  }
  responseCompleted() {
    const turn = this.turn;
    clearTimeout(this.contextExpiry);
    this.previousSubject =
      turn &&
      (turn.automaticCurrent || turn.legacyRoutes.some((r) => r !== "none"))
        ? turn.subject
        : undefined;
    if (turn) turn.subject = undefined;
    if (this.previousSubject)
      this.contextExpiry = setTimeout(() => {
        this.previousSubject = undefined;
      }, 15000);
  }
  noteLegacy(route: VisualRoute | "automatic_current") {
    const turn = this.turn;
    if (!turn) return;
    if (route === "automatic_current") turn.automaticCurrent = true;
    else if (turn.legacyRoutes.length < 7) turn.legacyRoutes.push(route);
    if (this.snapshot.last?.turnId === turn.id)
      this.publish({
        last: {
          ...this.snapshot.last,
          legacyRoutes: [...turn.legacyRoutes],
          automaticCurrent: turn.automaticCurrent,
        },
      });
  }
  private tryRoute(turn: Turn) {
    if (turn.requested || !turn.ended || !turn.text || !turn.availability)
      return;
    turn.requested = true;
    const text = turn.text;
    turn.text = undefined;
    if (!this.permitted() || !turn.availability.screen_awareness_enabled)
      return;
    this.publish({
      requests: this.snapshot.requests + 1,
      activeRequests: 1,
      last: {
        turnId: turn.id,
        status: "pending",
        legacyRoutes: [...turn.legacyRoutes],
        automaticCurrent: turn.automaticCurrent,
      },
    });
    void this.run(turn, text, turn.availability);
  }
  private async run(
    turn: Turn,
    text: string,
    availability: VisualAvailability,
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject("cancelled");
    });
    turn.abort.signal.addEventListener("abort", abort, { once: true });
    // Outer bound also covers native IPC failure. It never touches the voice barrier.
    try {
      const result = await Promise.race([
        cancelled,
        this.client.route(
          {
            turn_id: turn.id,
            user_utterance: text,
            visual_availability: availability,
            ...(availability.previous_reference_available &&
            this.previousSubject
              ? { previous_turn_context: this.previousSubject }
              : {}),
          },
          turn.abort.signal,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject("timeout");
            turn.abort.abort();
          }, this.timeoutMs);
        }),
      ]);
      if (this.turn !== turn || turn.abort.signal.aborted || !this.permitted())
        return;
      this.latencies = [...this.latencies.slice(-127), result.timings.totalMs];
      const sorted = [...this.latencies].sort((a, b) => a - b);
      this.publish({
        activeRequests: 0,
        successes: this.snapshot.successes + 1,
        routes: {
          ...this.snapshot.routes,
          [result.route]: (this.snapshot.routes[result.route] ?? 0) + 1,
        },
        p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        latencySamples: sorted.length,
        inputTokens:
          this.snapshot.inputTokens + (result.usage?.input_tokens ?? 0),
        requestBytes: this.snapshot.requestBytes + (result.requestBytes ?? 0),
        last: {
          turnId: turn.id,
          status: result.availabilityCompatible
            ? "observed"
            : "data_unavailable",
          decision: result,
          legacyRoutes: [...turn.legacyRoutes],
          automaticCurrent: turn.automaticCurrent,
        },
      });
    } catch (error) {
      if (this.turn !== turn) return;
      const failure = safePreflightFailure(error);
      this.publish({
        activeRequests: 0,
        errors: {
          ...this.snapshot.errors,
          [failure]: (this.snapshot.errors[failure] ?? 0) + 1,
        },
        fallbackUsed: this.snapshot.fallbackUsed + 1,
        last: {
          turnId: turn.id,
          status: failure,
          legacyRoutes: [...turn.legacyRoutes],
          automaticCurrent: turn.automaticCurrent,
        },
      });
    } finally {
      clearTimeout(timer);
      turn.abort.signal.removeEventListener("abort", abort);
    }
  }
}
