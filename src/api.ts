import type { Region } from "./providers/realtime/visual/types";
import { invoke } from "@tauri-apps/api/core";

export interface CapturedFrame {
  imageBase64: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  timestampUnixMs: number;
  encodedSizeBytes: number;
  stabilizationWaitMs: number;
  captureDurationMs: number;
  encodingDurationMs: number;
  analysisDurationMs: number;
  totalDurationMs: number;
  analysis: ChangeAnalysis;
  encoding: "jpeg" | "png";
  kind: "context" | "detail";
  sourceRegion: Region;
}

export interface ChangeAnalysis {
  previousFrameAvailable: boolean;
  changeScore: number | null;
  threshold: number;
  decision:
    | "baseline"
    | "resolution_changed"
    | "no_meaningful_change"
    | "meaningful_change";
  analysisWidth: number;
  analysisHeight: number;
}

export interface DetectionConfig {
  defaultThreshold: number;
  minThreshold: number;
  maxThreshold: number;
  thresholdStep: number;
}

export const detectionConfig = () =>
  invoke<DetectionConfig>("detection_config");

export const startSession = () => invoke<void>("start_session");
export const stopSession = () => invoke<void>("stop_session");
export const captureScreen = (
  threshold: number,
  request?: { kind: "context" | "detail"; region?: Region },
) => invoke<CapturedFrame>("capture_screen", { threshold, request });
export const setAIVisualAccess = (enabled: boolean) =>
  invoke<void>("set_ai_visual_access", { enabled });
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "The operation failed. Please try again.";
}
