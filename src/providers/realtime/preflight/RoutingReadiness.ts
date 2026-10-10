import {
  defaultPolicy,
  enginePlan,
  validatedPriority,
  type EngineSelectionPolicy,
} from "./EngineSelectionPolicy.js";
import type {
  DecisionEngineRegistry,
  EngineId,
} from "./VisualDecisionEngine.js";
import type { RouterPolicy } from "./VisualIntentRouter.js";

export const routingPolicyStorageKey = "companion.routing.policy.v1";

// Only preferences survive restart. Remote consent and developer mode are
// session permissions and must never be restored from this record.
export function parseRoutingPolicy(
  serialized: string | null,
  registry: DecisionEngineRegistry,
): EngineSelectionPolicy {
  try {
    if (!serialized || serialized.length > 4096) return { ...defaultPolicy };
    const value = JSON.parse(serialized);
    if (!value || value.version !== 1) return { ...defaultPolicy };
    const preferred =
      value.preferred === "Auto" ||
      (typeof value.preferred === "string" &&
        value.preferred !== "jev" &&
        registry.get(value.preferred)?.capabilities.executionLocation ===
          "Local")
        ? value.preferred
        : defaultPolicy.preferred;
    const fallback =
      typeof value.fallback === "string" &&
      value.fallback !== "jev" &&
      registry.get(value.fallback)?.capabilities.executionLocation === "Local"
        ? value.fallback
        : undefined;
    return {
      preferred,
      ...(fallback ? { fallback } : {}),
      localOnly: true,
    };
  } catch {
    return { ...defaultPolicy };
  }
}

export function serializeRoutingPolicy(policy: EngineSelectionPolicy): string {
  return JSON.stringify({
    version: 1,
    preferred: policy.preferred,
    fallback: policy.fallback,
    localOnly: policy.localOnly,
  });
}

export type RoutingReadinessCode =
  | "currentScreen"
  | "noValidatedEngine"
  | "legacy"
  | "localOnly"
  | "remoteConsent"
  | "loading"
  | "unavailable"
  | "experimental"
  | "ready";

export function routingReadiness(
  policy: RouterPolicy,
  registry: DecisionEngineRegistry,
  validated: readonly EngineId[] = validatedPriority,
): { code: RoutingReadinessCode; engine?: string } {
  if (policy.preferred === "Legacy") return { code: "legacy" };
  if (policy.preferred === "jev") return { code: "unavailable" };
  if (policy.preferred === "Auto" && validated.length === 0)
    return { code: "noValidatedEngine" };
  const preferred = registry.get(policy.preferred);
  if (
    policy.localOnly &&
    preferred?.capabilities.executionLocation === "Remote"
  )
    return { code: "localOnly", engine: preferred.label };
  const plan = enginePlan(policy, registry, validated);
  for (const id of plan) {
    const engine = registry.get(id)!;
    if (
      engine.capabilities.executionLocation === "Remote" &&
      (!policy.developerMode || !policy.remoteShadowOptIn)
    )
      return { code: "remoteConsent", engine: engine.label };
    if (engine.health().state === "Ready")
      return {
        code: validated.includes(id) ? "ready" : "experimental",
        engine: engine.label,
      };
  }
  return {
    code: preferred?.health().state === "Loading" ? "loading" : "unavailable",
    engine: preferred?.label,
  };
}
