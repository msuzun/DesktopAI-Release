import type {
  VisualInspectionIntent,
  VisualInspectionRequest,
} from "../visual/VisualInspection.js";

export type VisualRoute = "none" | VisualInspectionIntent;
export type PreflightMode = "Disabled" | "Shadow" | "Authoritative";
export type VisualSelectionTiming = "speech_end" | "before_response";
export interface VisualAvailability {
  screen_awareness_enabled: boolean;
  current_available: boolean;
  recent_available: boolean;
  previous_reference_available: boolean;
}
export interface PreflightInput {
  turn_id?: string;
  user_utterance: string;
  previous_turn_context?: string;
  visual_availability: VisualAvailability;
}
export const failureCodes = [
  "not_configured",
  "credential_store",
  "authentication",
  "rate_limit",
  "transport",
  "timeout",
  "service_unavailable",
  "invalid_input",
  "invalid_result",
  "cancelled",
  "privacy",
  "busy",
  "model_missing",
  "runtime_missing",
  "load_failed",
  "unsupported_device",
  "out_of_memory",
  "inference_failed",
  "worker_exited",
  "routing_unavailable",
  "unvalidated",
] as const;
export type PreflightFailure = (typeof failureCodes)[number];
export function safePreflightFailure(error: unknown): PreflightFailure {
  return failureCodes.includes(error as PreflightFailure)
    ? (error as PreflightFailure)
    : "transport";
}
export interface VisualPreflightDecision {
  route: VisualRoute;
  confidence?: number;
  probabilities?: Record<VisualRoute, number>;
  availabilityCompatible: boolean;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  requestBytes?: number;
  turnId?: string;
  metadata?: VisualDecisionMetadata;
  timings: {
    serializationMs?: number;
    networkMs?: number;
    parsingMs?: number;
    inferenceMs?: number;
    totalMs: number;
  };
}
export interface VisualDecisionMetadata {
  engine: string;
  executionLocation: "Local" | "Remote";
  runtimeVersion?: string;
  modelVersion?: string;
  device?: string;
  coldStart?: boolean;
  loadMs?: number;
  memoryBytes?: number;
  cpuMs?: number;
  confidenceMeaning?: string;
  classification?: { strategy: string; dimensions?: Record<string, string> };
  fallbackUsed?: boolean;
  attempts?: {
    engine: string;
    durationMs: number;
    failure?: PreflightFailure;
  }[];
}
export interface VisualIntentPreflight {
  /** Semantic sources keep the speech endpoint; explicit Current can select later. */
  readonly selectionTiming?: VisualSelectionTiming;
  route(
    input: PreflightInput,
    signal: AbortSignal,
  ): Promise<VisualPreflightDecision>;
}
// Used by offline orchestration contract tests; Shadow never executes it.
export function inspectionForRoute(
  route: VisualRoute,
): VisualInspectionRequest | null {
  return route === "none" ? null : { mode: route };
}
