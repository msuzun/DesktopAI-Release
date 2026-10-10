import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { setAIVisualAccess } from "../api";
import type { useSession } from "../useSession";
import type { useRealtimeVoice } from "./useRealtimeVoice";
import { providerDefinition } from "../providers/realtime/ProviderRegistry.js";
import { ToolDispatcher } from "../providers/realtime/visual/ToolDispatcher.js";
import { TemporalContextClient } from "../providers/realtime/visual/TemporalContext.js";
import { invoke } from "@tauri-apps/api/core";
export function useVisualTools(
  capture: ReturnType<typeof useSession>,
  live: ReturnType<typeof useRealtimeVoice>,
  screenAllowed: { current: boolean },
) {
  const [allowed, setAllowed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const allowedRef = useRef(false),
    transition = useRef(0);
  const permissionQueue = useRef(Promise.resolve());
  function nativeAccess(enabled: boolean) {
    // Preserve grant/revoke order across async native WGC startup and shutdown.
    const operation = permissionQueue.current.then(() =>
      setAIVisualAccess(enabled),
    );
    permissionQueue.current = operation.catch(() => {});
    return operation;
  }
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const [temporal] = useState(
    () =>
      new TemporalContextClient(
        invoke,
        () =>
          allowedRef.current &&
          screenAllowed.current &&
          captureRef.current.isActive() &&
          live.manager.getSnapshot().state === "Connected",
      ),
  );
  const [dispatcher] = useState(
    () =>
      new ToolDispatcher(
        () => {
          const current = live.manager.getSnapshot();
          const definition = providerDefinition(current.config.providerId);
          return {
            aiActive: current.state === "Connected",
            visualActive: captureRef.current.isActive(),
            allowed: allowedRef.current && screenAllowed.current,
            provider: definition.displayName,
            capabilities: definition.capabilities,
          };
        },
        (maxBytes, request, signal) =>
          temporal.request(
            maxBytes,
            request,
            signal,
            providerDefinition(live.manager.getSnapshot().config.providerId)
              .capabilities.maxContextImages,
          ),
        () => Date.now(),
        temporal,
      ),
  );
  const turn = useSyncExternalStore(
    live.manager.turns.subscribe,
    live.manager.turns.getSnapshot,
  );
  function revoke() {
    ++transition.current;
    allowedRef.current = false;
    live.manager.disableFreshVisual();
    setAllowed(false);
    dispatcher.revoke();
    void nativeAccess(false).catch(() => {});
  }
  useEffect(() => {
    live.manager.setToolDispatcher(dispatcher);
    const unsubscribe = live.manager.subscribe(() => {
      if (
        live.manager.getSnapshot().state !== "Connected" &&
        !live.manager.getSnapshot().switchFailed &&
        allowedRef.current
      )
        revoke();
    });
    return () => {
      unsubscribe();
      live.manager.setToolDispatcher(null);
      allowedRef.current = false;
      dispatcher.revoke();
      void nativeAccess(false).catch(() => {});
    };
  }, [live.manager, dispatcher]);
  useEffect(() => {
    if (!capture.isActive()) revoke();
  }, [capture.active, capture.transitioning]);
  async function grant() {
    const generation = ++transition.current;
    setBusy(true);
    setError(null);
    const sessionIdentity = live.manager.identity;
    try {
      if (
        live.manager.getSnapshot().state !== "Connected" ||
        !captureRef.current.isActive() ||
        !screenAllowed.current
      )
        throw new Error("Screen access is not enabled.");
      await nativeAccess(true);
      if (
        generation !== transition.current ||
        sessionIdentity !== live.manager.identity ||
        live.manager.getSnapshot().state !== "Connected" ||
        !captureRef.current.isActive() ||
        !screenAllowed.current
      ) {
        void nativeAccess(false).catch(() => {});
        throw new Error("Screen access was cancelled.");
      }
      allowedRef.current = true;
      setAllowed(true);
    } catch (cause) {
      setError(
        "Could not enable visual access. Start the visual session and try again.",
      );
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  const definition = providerDefinition(live.session.config.providerId);
  return {
    allowed,
    busy,
    error,
    dispatcher,
    revoke,
    grant,
    provider: definition.displayName,
    turn,
    freshBusy: live.session.freshBusy ?? false,
    responseControl: live.session.responseControl ?? "AUTOMATIC",
    responseControlHint: live.manager.responseControlHint(),
    finishVoiceTurn: () => live.manager.finishVoiceTurn(),
    retryVisual: () => live.manager.turns.retryVisual(),
    supported: definition.capabilities.imageInput,
  };
}
