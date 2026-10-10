import type {
  DecisionEngineRegistry,
  EngineId,
} from "./VisualDecisionEngine.js";

export interface EngineSelectionPolicy {
  preferred: "Auto" | "Legacy" | EngineId;
  fallback?: EngineId;
  localOnly: boolean;
}
// Promotion is a measured release decision. No engine has earned authority yet.
export const validatedPriority: readonly EngineId[] = [];
export const defaultPolicy: EngineSelectionPolicy = {
  preferred: "Auto",
  localOnly: true,
};

export function enginePlan(
  policy: EngineSelectionPolicy,
  registry: DecisionEngineRegistry,
  validated: readonly EngineId[] = validatedPriority,
): EngineId[] {
  if (policy.preferred === "Legacy") return [];
  // M11: JEV belongs to Actions. Persisted selections and developer consent
  // cannot restore its former visual-routing authority or fallback role.
  if (policy.preferred === "jev") return [];
  if (
    policy.preferred !== "Auto" &&
    policy.localOnly &&
    registry.get(policy.preferred)?.capabilities.executionLocation === "Remote"
  )
    return [];
  const candidates =
    policy.preferred === "Auto"
      ? validated.filter((id) => registry.get(id)?.health().state === "Ready")
      : [policy.preferred, ...(policy.fallback ? [policy.fallback] : [])];
  return [...new Set(candidates)]
    .filter((id) => {
      const e = registry.get(id);
      return (
        id !== "jev" &&
        !!e &&
        (!policy.localOnly || e.capabilities.executionLocation === "Local")
      );
    })
    .slice(0, 2);
}
