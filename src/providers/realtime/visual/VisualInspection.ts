import type { ContextEnvelope, ContextFrame } from "./TemporalContext.js";
import type { Region } from "./types.js";

export const visualIntents = [
  "current",
  "current_exact",
  "recent",
  "recent_exact",
  "compare_recent_current",
  "follow_up_exact",
] as const;
export type VisualInspectionIntent = (typeof visualIntents)[number];
export const visualOperations = ["inspect", "compare"] as const;
export const visualSources = [
  "current",
  "recent",
  "previous_reference",
] as const;
export const visualPrecisions = ["overview", "exact"] as const;
export interface VisualInspectionArguments {
  operation: (typeof visualOperations)[number];
  source: (typeof visualSources)[number];
  precision: (typeof visualPrecisions)[number];
  lookbackMs?: number;
  region?: Region;
}
const intentByParameters: Record<string, VisualInspectionIntent> = {
  "inspect/current/overview": "current",
  "inspect/current/exact": "current_exact",
  "inspect/recent/overview": "recent",
  "inspect/recent/exact": "recent_exact",
  "inspect/previous_reference/exact": "follow_up_exact",
  "compare/recent/overview": "compare_recent_current",
};
// The orchestrator retains its existing internal intent contract.
export interface VisualInspectionRequest {
  mode: VisualInspectionIntent;
  lookbackMs?: number;
  region?: Region;
}
export interface VisualInspectionResult {
  intent: VisualInspectionIntent;
  status: "Complete" | "Partial" | "Unavailable" | "Expired" | "Ambiguous";
  turnId: string;
  referenceTimeUnixMs: number;
  snapshots: (Omit<ContextFrame, "base64"> & {
    temporalRole: "Current" | "Historical" | "FollowUpHistorical";
    quality: "Context" | "Recent" | "Exact";
    reused: boolean;
  })[];
  events: ContextEnvelope["events"];
  followUpReference?: ContextEnvelope["followUpReference"];
  followUpSnapshotId?: string;
  warnings: string[];
  operations: string[];
  work: {
    imagesPrepared: number;
    imagesReused: number;
    encodedBytesPrepared: number;
  };
  timings: Record<string, number>;
}
export function inspectionRequest(
  value: unknown,
): VisualInspectionRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if (
    Object.keys(a).some(
      (k) =>
        !["operation", "source", "precision", "region", "lookbackMs"].includes(
          k,
        ),
    ) ||
    !visualOperations.includes(
      a.operation as VisualInspectionArguments["operation"],
    ) ||
    !visualSources.includes(a.source as VisualInspectionArguments["source"]) ||
    !visualPrecisions.includes(
      a.precision as VisualInspectionArguments["precision"],
    )
  )
    return null;
  const mode = intentByParameters[`${a.operation}/${a.source}/${a.precision}`];
  if (!mode) return null;
  if (
    a.lookbackMs !== undefined &&
    (!["recent", "recent_exact", "compare_recent_current"].includes(mode) ||
      !Number.isSafeInteger(a.lookbackMs) ||
      (a.lookbackMs as number) < 1 ||
      (a.lookbackMs as number) > 5000)
  )
    return null;
  if (a.region !== undefined) {
    if (
      !mode.endsWith("_exact") ||
      !a.region ||
      typeof a.region !== "object" ||
      Array.isArray(a.region)
    )
      return null;
    const r = a.region as Record<string, number>;
    if (
      Object.keys(r).length !== 4 ||
      !["x", "y", "width", "height"].every(
        (k) => typeof r[k] === "number" && Number.isFinite(r[k]),
      ) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x + r.width > 1 ||
      r.y + r.height > 1
    )
      return null;
  }
  return {
    mode,
    ...(a.lookbackMs !== undefined
      ? { lookbackMs: a.lookbackMs as number }
      : {}),
    ...(a.region !== undefined ? { region: a.region as Region } : {}),
  };
}
