import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CompanionSession } from "../providers/realtime/CompanionSession";
import type { useSession } from "../useSession";
import type { useRealtimeVoice } from "./useRealtimeVoice";
import type { useVisualTools } from "./useVisualTools";

export function useCompanion(
  capture: ReturnType<typeof useSession>,
  live: ReturnType<typeof useRealtimeVoice>,
  visual: ReturnType<typeof useVisualTools>,
  screenAllowed: { current: boolean },
) {
  const latest = useRef({ capture, visual });
  latest.current = { capture, visual };
  const [controller] = useState(
    () =>
      new CompanionSession({
        startVoice: async () => {
          await live.manager.start();
          live.manager.setMuted(true);
        },
        voiceConnected: () => live.manager.getSnapshot().state === "Connected",
        stopVoice: () => live.manager.stop(),
        startVisual: () => latest.current.capture.start(),
        stopVisual: () => latest.current.capture.stop(),
        grantVisual: () => latest.current.visual.grant(),
        revokeVisual: () => latest.current.visual.revoke(),
        enableFresh: () => live.manager.enableFreshVisual(),
        allowScreen: (enabled) => {
          screenAllowed.current = enabled;
        },
        ready: () => live.manager.setMuted(false),
      }),
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => {
    if (snapshot.state !== "Active" || !snapshot.awareness) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function checkCapture() {
      try {
        const status = await invoke<{
          gpuFrames: boolean;
          statistics: { state: string } | null;
          perception: { state: string };
        }>("capture_backend_status");
        if (
          !disposed &&
          status.gpuFrames &&
          (status.statistics?.state !== "Running" ||
            status.perception.state !== "Running")
        ) {
          await controller.stop(
            "Screen awareness stopped unexpectedly. Start again, or turn it off to use voice only.",
          );
          return;
        }
      } catch {
        if (!disposed) {
          await controller.stop(
            "Screen awareness status is unavailable. Start the companion again.",
          );
          return;
        }
      }
      if (!disposed) timer = setTimeout(() => void checkCapture(), 1000);
    }
    timer = setTimeout(() => void checkCapture(), 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [controller, snapshot.state, snapshot.awareness]);
  useEffect(() => {
    const unsubscribe = live.manager.subscribe(() => {
      if (
        controller.getSnapshot().state === "Active" &&
        live.manager.getSnapshot().state === "Error" &&
        !live.manager.getSnapshot().switchFailed
      )
        void controller.stop(
          "The connection was lost. Check your connection and start again.",
        );
    });
    const stop = () => {
      void controller.stop();
    };
    window.addEventListener("pagehide", stop);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [controller, live.manager]);
  return { controller, snapshot };
}
