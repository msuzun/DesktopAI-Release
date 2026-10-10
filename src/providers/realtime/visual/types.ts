import type { ContextFrame, ContextEnvelope } from "./TemporalContext.js";
export type { ContextFrame, ContextEnvelope } from "./TemporalContext.js";
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface VisualRequest {
  kind: "context" | "current" | "detail" | "recent";
  snapshotId?: string;
  lookbackMs?: number;
  maxEvents?: number;
  maxKeyframes?: number;
  region?: Region;
  fresh?: boolean;
  turnId?: string;
}
export interface VisualContext {
  inspection?: import("./VisualInspection.js").VisualInspectionResult;
  validateIdentity?: () => Promise<void>;
  preparation?: { requestedAt: number; startedAt: number; readyAt: number };
  currentMaxAgeMs?: number;
  frames?: ContextFrame[];
  context?: ContextEnvelope;
  validate?: () => Promise<void>;
  visual?: {
    turnId: string;
    freshness: "FRESH" | "STALE" | "HISTORICAL" | "UNAVAILABLE" | "FAILED";
    source: "TURN_SYNCHRONIZED" | "ON_DEMAND_AI_REQUEST";
  };
  base64: string;
  mimeType: "image/jpeg" | "image/png";
  kind?: VisualRequest["kind"];
  sourceRegion?: Region;
  originalWidth?: number;
  originalHeight?: number;
  width: number;
  height: number;
  timestampUnixMs: number;
  source: "PrimaryDisplay";
  metadata: {
    stabilizationWaitMs?: number;
    captureDurationMs: number;
    encodingDurationMs: number;
    encodedSizeBytes: number;
    changeScore: number | null;
    threshold: number;
  };
}
export type ToolStatus =
  | "snapshot_expired"
  | "snapshot_required"
  | "current_unavailable"
  | "history_unavailable"
  | "invalid_region"
  | "visual_limit_reached"
  | "generation_changed"
  | "readback_failed"
  | "encoding_failed"
  | "visual_busy"
  | "unchanged"
  | "success"
  | "visual_session_inactive"
  | "permission_denied"
  | "capture_in_progress"
  | "rate_limited"
  | "capture_failed"
  | "provider_visual_input_unsupported"
  | "provider_function_calling_unsupported"
  | "ai_session_inactive"
  | "invalid_arguments"
  | "unknown_tool"
  | "cancelled"
  | "provider_delivery_failed"
  | "image_too_large";
export interface ToolResult {
  inspection?: import("./VisualInspection.js").VisualInspectionResult;
  context?: ContextEnvelope;
  turnId?: string;
  status: ToolStatus;
  success: boolean;
  message: string;
  timestampUnixMs?: number;
  image?: {
    role: string;
    sourceRegion?: Region;
    originalWidth?: number;
    originalHeight?: number;
  };
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  signal: AbortSignal;
}
export type ToolHandler = (call: ToolCall) => Promise<void>;
export interface VisualDelivery {
  sent: boolean;
  acknowledged?: boolean;
  acknowledgment: string;
}
