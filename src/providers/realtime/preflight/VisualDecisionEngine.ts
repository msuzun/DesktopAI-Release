import type {
  PreflightFailure,
  PreflightInput,
  VisualPreflightDecision,
} from "./VisualIntentPreflight.js";

// Application contracts. SDK responses and runtime objects stay in adapters.
export type EngineId = string;
export interface EngineCapabilities {
  executionLocation: "Local" | "Remote";
  requiresNetwork: boolean;
  requiresApiKey: boolean;
  supportsConfidence: boolean;
  cancellation: "Abort" | "Discard";
  warmReuse: boolean;
}
export interface EngineHealth {
  state: "Ready" | "Loading" | "Unavailable" | "NotConfigured" | "Failed";
  reason?: PreflightFailure;
}
export interface DecisionRequest extends PreflightInput {
  turn_id: string;
}
export interface DecisionResult extends VisualPreflightDecision {
  turnId: string;
  metadata: NonNullable<VisualPreflightDecision["metadata"]>;
}
export interface VisualDecisionEngine {
  readonly id: EngineId;
  readonly label: string;
  readonly capabilities: EngineCapabilities;
  health(): EngineHealth;
  decide(input: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
  dispose(): Promise<void>;
}
export class DecisionEngineRegistry {
  private engines = new Map<EngineId, VisualDecisionEngine>();
  constructor(engines: VisualDecisionEngine[]) {
    for (const engine of engines) {
      if (!engine.id || this.engines.has(engine.id))
        throw new Error("Duplicate decision engine");
      this.engines.set(engine.id, engine);
    }
  }
  get(id: EngineId) {
    return this.engines.get(id);
  }
  list() {
    return [...this.engines.values()];
  }
  async dispose() {
    await Promise.allSettled(this.list().map((e) => e.dispose()));
  }
}
