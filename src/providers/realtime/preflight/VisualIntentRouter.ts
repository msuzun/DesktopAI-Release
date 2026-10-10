import {
  safePreflightFailure,
  type PreflightInput,
  type VisualIntentPreflight,
  type PreflightFailure,
} from "./VisualIntentPreflight.js";
import {
  type DecisionResult,
  DecisionEngineRegistry,
} from "./VisualDecisionEngine.js";
import {
  defaultPolicy,
  enginePlan,
  type EngineSelectionPolicy,
} from "./EngineSelectionPolicy.js";

const eligible = new Set<PreflightFailure>([
  "not_configured",
  "credential_store",
  "authentication",
  "rate_limit",
  "transport",
  "timeout",
  "service_unavailable",
  "invalid_result",
  "busy",
  "model_missing",
  "runtime_missing",
  "load_failed",
  "unsupported_device",
  "out_of_memory",
  "inference_failed",
  "worker_exited",
  "routing_unavailable",
]);
export interface RouterPolicy extends EngineSelectionPolicy {
  developerMode: boolean;
  remoteShadowOptIn: boolean;
}
export class VisualIntentRouter implements VisualIntentPreflight {
  private policy: RouterPolicy = {
    ...defaultPolicy,
    developerMode: false,
    remoteShadowOptIn: false,
  };
  private active: AbortController | null = null;
  private generation = 0;
  private trace: NonNullable<DecisionResult["metadata"]["attempts"]> = [];
  constructor(
    readonly registry: DecisionEngineRegistry,
    private permitted: () => boolean,
    readonly totalBudgetMs = 2000,
    readonly attemptBudgetMs = 1500,
  ) {}
  getPolicy() {
    return { ...this.policy };
  }
  getLastAttempts() {
    return this.trace.map((a) => ({ ...a }));
  }
  configure(policy: RouterPolicy) {
    this.cancel();
    this.policy = { ...policy };
  }
  cancel() {
    ++this.generation;
    this.active?.abort();
    this.active = null;
  }
  async dispose() {
    this.cancel();
    await this.registry.dispose();
  }
  async route(
    input: PreflightInput,
    signal: AbortSignal,
  ): Promise<DecisionResult> {
    if (signal.aborted) throw "cancelled";
    if (
      !this.permitted() ||
      !input.visual_availability.screen_awareness_enabled
    )
      throw "privacy";
    if (
      !input.turn_id ||
      input.turn_id.length > 96 ||
      !input.user_utterance.trim() ||
      new TextEncoder().encode(input.user_utterance).length > 8192 ||
      !Object.values(input.visual_availability).every(
        (v) => typeof v === "boolean",
      ) ||
      (input.previous_turn_context &&
        new TextEncoder().encode(input.previous_turn_context).length > 1024)
    )
      throw "invalid_input";
    this.cancel();
    const generation = this.generation,
      controller = new AbortController();
    this.active = controller;
    this.trace = [];
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const started = performance.now(),
      attempts: NonNullable<DecisionResult["metadata"]["attempts"]> = [];
    // Construct one immutable semantic request. Every attempt receives the same data.
    const a = input.visual_availability;
    const request = Object.freeze({
      turn_id: input.turn_id,
      user_utterance: input.user_utterance,
      ...(input.previous_turn_context
        ? { previous_turn_context: input.previous_turn_context }
        : {}),
      visual_availability: Object.freeze({
        screen_awareness_enabled: a.screen_awareness_enabled,
        current_available: a.current_available,
        recent_available: a.recent_available,
        previous_reference_available: a.previous_reference_available,
      }),
    });
    const valid = () => {
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        signal.aborted
      )
        throw "cancelled";
      if (!this.permitted()) throw "privacy";
    };
    try {
      const plan = enginePlan(this.policy, this.registry);
      for (const id of plan) {
        valid();
        const engine = this.registry.get(id)!;
        // A local preference can never silently become cloud benchmarking.
        if (
          engine.capabilities.executionLocation === "Remote" &&
          (!this.policy.developerMode || !this.policy.remoteShadowOptIn)
        )
          throw "privacy";
        const remaining = this.totalBudgetMs - (performance.now() - started);
        if (remaining <= 0) throw "timeout";
        const at = performance.now(),
          attempt = new AbortController();
        const relay = () => attempt.abort();
        controller.signal.addEventListener("abort", relay, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort!: () => void;
        try {
          const health = engine.health();
          if (health.state !== "Ready")
            throw health.reason ?? "routing_unavailable";
          const cancellation = new Promise<never>((_, reject) => {
            onAbort = () => reject("cancelled");
          });
          attempt.signal.addEventListener("abort", onAbort, { once: true });
          const result = await Promise.race([
            engine.decide(request, attempt.signal),
            cancellation,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  reject("timeout");
                  attempt.abort();
                },
                Math.min(remaining, this.attemptBudgetMs),
              );
            }),
          ]);
          valid();
          if (
            result.turnId !== input.turn_id ||
            result.metadata.engine !== id ||
            result.metadata.executionLocation !==
              engine.capabilities.executionLocation ||
            ![
              "none",
              "current",
              "current_exact",
              "recent",
              "recent_exact",
              "follow_up_exact",
              "compare_recent_current",
            ].includes(result.route) ||
            !Number.isFinite(result.timings.totalMs) ||
            result.timings.totalMs < 0 ||
            typeof result.availabilityCompatible !== "boolean" ||
            (result.confidence !== undefined &&
              (!Number.isFinite(result.confidence) ||
                result.confidence < 0 ||
                result.confidence > 1))
          )
            throw "invalid_result";
          attempts.push({ engine: id, durationMs: performance.now() - at });
          return {
            ...result,
            timings: {
              ...result.timings,
              totalMs: performance.now() - started,
            },
            metadata: {
              ...result.metadata,
              fallbackUsed: attempts.length > 1,
              attempts,
            },
          };
        } catch (error) {
          valid();
          const failure = safePreflightFailure(error);
          attempts.push({
            engine: id,
            durationMs: performance.now() - at,
            failure,
          });
          if (!eligible.has(failure)) throw failure;
          if (id === plan.at(-1)) throw failure;
        } finally {
          clearTimeout(timer);
          if (onAbort) attempt.signal.removeEventListener("abort", onAbort);
          controller.signal.removeEventListener("abort", relay);
        }
      }
      throw "routing_unavailable";
    } finally {
      if (generation === this.generation) this.trace = attempts;
      signal.removeEventListener("abort", cancel);
      if (this.active === controller) this.active = null;
    }
  }
}
