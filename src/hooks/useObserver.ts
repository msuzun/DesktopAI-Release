import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Region } from "../providers/realtime/visual/types";
export interface ObserverSnapshot {
  active: boolean;
  intervalMs: number;
  stabilizationMs: number;
  observationCount: number;
  meaningfulCount: number;
  processingMs: number;
  lastDetectionLatencyMs: number | null;
  lastChangeType: string | null;
  globalScore: number;
  changedAreaRatio: number;
  regionScore: number;
  temporalConfidence: number;
  changedTiles: number[];
  boundingRegion: Region | null;
  stable: boolean;
  stabilizationDurationMs: number;
  detectedAt: number | null;
  stableAt: number | null;
  error: string | null;
}
export function useObserver(active: boolean) {
  const [snapshot, setSnapshot] = useState<ObserverSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(null);
    setError(null);
    if (!active) return;
    async function poll() {
      try {
        const s = await invoke<ObserverSnapshot>("observer_snapshot");
        if (!disposed) {
          setSnapshot(s);
          setError(null);
        }
      } catch {
        if (!disposed) setError("Observer diagnostics unavailable.");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active]);
  return { snapshot, error };
}
