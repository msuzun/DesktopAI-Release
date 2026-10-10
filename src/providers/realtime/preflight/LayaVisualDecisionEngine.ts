import type { NativeInvoke } from "../visual/TemporalContext.js";
import type {
  DecisionRequest,
  DecisionResult,
  EngineHealth,
  VisualDecisionEngine,
} from "./VisualDecisionEngine.js";
import { NativeDecisionTransport } from "./NativeDecisionTransport.js";
import {
  safePreflightFailure,
  type VisualPreflightDecision,
  type VisualRoute,
} from "./VisualIntentPreflight.js";
import spec from "./route-spec.json" with { type: "json" };
import compositionalSpec from "./compositional-route-spec.json" with { type: "json" };

export interface LayaConfig {
  pythonPath: string;
  modelPath: string;
  checkpoint: "multilingual" | "english" | "typed-decisions";
  device: "cpu" | "cuda";
  strategy?: "direct" | "compositional";
}
export interface LayaDetails {
  runtimeVersion: string;
  modelVersion: string;
  checkpoint: string;
  device: string;
  loadMs: number;
  memory: { privateBytes: number; rssBytes: number };
  inferences: number;
  networkBlocks: number;
  pid: number;
}
export interface LayaStatus extends EngineHealth {
  details?: LayaDetails;
  activeRequests: number;
  queuedRequests: number;
}
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
function compatible(
  route: VisualRoute,
  a: DecisionRequest["visual_availability"],
) {
  if (route === "none") return true;
  if (route === "follow_up_exact") return a.previous_reference_available;
  if (route === "compare_recent_current")
    return a.current_available && a.recent_available;
  return route.startsWith("recent") ? a.recent_available : a.current_available;
}
export function parseLayaDecision(value: unknown): VisualPreflightDecision {
  const d = value as Record<string, any> | null;
  const known = Object.keys(spec.criteria);
  const compositional = d?.status?.strategy === "compositional";
  if (
    !d ||
    !known.includes(d.route) ||
    !finite(d.confidence) ||
    d.confidence > 1 ||
    !d.probabilities ||
    Object.keys(d.probabilities).length !== 7 ||
    !finite(d.totalMs) ||
    !finite(d.inferenceMs) ||
    !finite(d.cpuMs) ||
    typeof d.coldStart !== "boolean" ||
    !d.status ||
    d.status.runtimeVersion !== "0.3.6" ||
    typeof d.status.modelVersion !== "string" ||
    !/^[0-9a-f]{40}$/.test(d.status.modelVersion) ||
    !["cpu", "cuda", "cuda:0"].includes(d.status.device) ||
    !["multilingual", "english", "typed-decisions"].includes(
      d.status.checkpoint,
    ) ||
    !finite(d.status.loadMs) ||
    !finite(d.status.memory?.privateBytes) ||
    d.status.networkBlocks !== 0 ||
    !d.usage ||
    ![d.usage.input_tokens, d.usage.output_tokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw "invalid_result";
  let sum = 0;
  const probabilities = {} as Record<VisualRoute, number>;
  for (const key of known) {
    const p = d.probabilities[key];
    if (
      !finite(p) ||
      p > 1 ||
      (!compositional && p > d.probabilities[d.route] + 0.000001)
    )
      throw "invalid_result";
    probabilities[key.toLowerCase() as VisualRoute] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > 0.00036) throw "invalid_result";
  if (compositional) {
    const choices = d.dimensions;
    if (
      !choices ||
      Object.keys(choices).length !== 4 ||
      Object.entries(compositionalSpec.questions).some(
        ([key, question]) =>
          !Object.keys(question.criteria).includes(choices[key]),
      )
    )
      throw "invalid_result";
    const mapped =
      choices.visual_need === "NONVISUAL"
        ? "NONE"
        : choices.relation === "COMPARE"
          ? "COMPARE_RECENT_CURRENT"
          : choices.temporal_source === "PREVIOUS_REFERENCE"
            ? "FOLLOW_UP_EXACT"
            : choices.temporal_source +
              (choices.precision === "EXACT" ? "_EXACT" : "");
    if (
      mapped !== d.route ||
      d.status.compositionMethod !== "dimension-choice-v1"
    )
      throw "invalid_result";
  }
  return {
    route: d.route.toLowerCase() as VisualRoute,
    confidence: d.confidence,
    probabilities,
    availabilityCompatible: false,
    model: `laya-${d.status.checkpoint}`,
    usage: {
      input_tokens: d.usage.input_tokens,
      output_tokens: d.usage.output_tokens,
    },
    timings: { totalMs: d.totalMs, inferenceMs: d.inferenceMs },
    metadata: {
      engine: "laya",
      executionLocation: "Local",
      runtimeVersion: d.status.runtimeVersion,
      modelVersion: d.status.modelVersion,
      device: d.status.device,
      coldStart: d.coldStart,
      loadMs: d.status.loadMs,
      memoryBytes: d.status.memory.privateBytes,
      cpuMs: d.cpuMs,
      classification: {
        strategy: compositional
          ? "compositional-dimension-choice-v1"
          : "direct",
        ...(compositional ? { dimensions: { ...d.dimensions } } : {}),
      },
      confidenceMeaning: compositional
        ? "Uncalibrated entropy of composed marginal weights; route follows learned dimension choices"
        : "LAYA normalized entropy confidence; uncalibrated for visual routing",
    },
  };
}
export class LayaVisualDecisionEngine implements VisualDecisionEngine {
  readonly id = "laya";
  readonly label = "LAYA — Local (BETA / EXPERIMENTAL)";
  readonly capabilities = {
    executionLocation: "Local",
    requiresNetwork: false,
    requiresApiKey: false,
    supportsConfidence: true,
    cancellation: "Discard",
    warmReuse: true,
  } as const;
  private state: LayaStatus = {
    state: "Unavailable",
    reason: "model_missing",
    activeRequests: 0,
    queuedRequests: 0,
  };
  private client: NativeDecisionTransport;
  private generation = 0;
  constructor(private invoke: NativeInvoke) {
    this.client = new NativeDecisionTransport(
      invoke,
      "laya",
      parseLayaDecision,
    );
  }
  health() {
    return { state: this.state.state, reason: this.state.reason };
  }
  status() {
    return this.state;
  }
  async refresh() {
    const generation = this.generation;
    const value = await this.invoke<LayaStatus>("laya_status");
    if (generation === this.generation) this.state = value;
    return this.state;
  }
  async initialize(config: LayaConfig) {
    const generation = ++this.generation;
    this.state = { state: "Loading", activeRequests: 0, queuedRequests: 0 };
    try {
      const value = await this.invoke<LayaStatus>("laya_start", { config });
      if (generation !== this.generation) throw "cancelled";
      this.state = value;
    } catch (error) {
      if (generation === this.generation)
        this.state = {
          state: "Failed",
          reason: safePreflightFailure(error),
          activeRequests: 0,
          queuedRequests: 0,
        };
      throw error;
    }
  }
  async decide(
    input: DecisionRequest,
    signal: AbortSignal,
  ): Promise<DecisionResult> {
    if (this.state.state !== "Ready") throw this.state.reason ?? "load_failed";
    const generation = this.generation;
    try {
      const d = await this.client.route(input, signal);
      if (generation !== this.generation || signal.aborted) throw "cancelled";
      return {
        ...d,
        turnId: input.turn_id,
        availabilityCompatible: compatible(d.route, input.visual_availability),
        metadata: d.metadata!,
      };
    } catch (error) {
      const reason = safePreflightFailure(error);
      if (
        generation === this.generation &&
        [
          "load_failed",
          "out_of_memory",
          "inference_failed",
          "worker_exited",
          "timeout",
          "invalid_result",
        ].includes(reason)
      )
        this.state = {
          state: "Failed",
          reason,
          activeRequests: 0,
          queuedRequests: 0,
        };
      throw reason;
    }
  }
  async dispose() {
    ++this.generation;
    this.state = {
      state: "Unavailable",
      reason: "model_missing",
      activeRequests: 0,
      queuedRequests: 0,
    };
    await this.invoke("laya_unload");
  }
}
