import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LiveSessionManager } from "../providers/realtime/LiveSessionManager.js";
import { ShadowVisualPreflight } from "../providers/realtime/preflight/ShadowVisualPreflight.js";
import { DecisionEngineRegistry } from "../providers/realtime/preflight/VisualDecisionEngine.js";
import {
  VisualIntentRouter,
  type RouterPolicy,
} from "../providers/realtime/preflight/VisualIntentRouter.js";
import { enginePlan } from "../providers/realtime/preflight/EngineSelectionPolicy.js";
import { CurrentScreenPreflight } from "../providers/realtime/preflight/CurrentScreenPreflight.js";
import {
  parseScreenContextMode,
  screenContextModeStorageKey,
  serializeScreenContextMode,
  type ScreenContextMode,
} from "../providers/realtime/preflight/ScreenContextMode.js";
import {
  parseRoutingPolicy,
  routingPolicyStorageKey,
  routingReadiness,
  serializeRoutingPolicy,
} from "../providers/realtime/preflight/RoutingReadiness.js";
import {
  LayaVisualDecisionEngine,
  type LayaConfig,
} from "../providers/realtime/preflight/LayaVisualDecisionEngine.js";

const emptyConfig: LayaConfig = {
  pythonPath: "",
  modelPath: "",
  checkpoint: "multilingual",
  device: "cpu",
};
export function useVisualRouting(manager: LiveSessionManager) {
  const [engines] = useState(() => {
    const laya = new LayaVisualDecisionEngine(invoke);
    const registry = new DecisionEngineRegistry([laya]);
    const coordinator = new VisualIntentRouter(registry, () =>
      manager.screenPermitted(),
    );
    try {
      coordinator.configure({
        ...coordinator.getPolicy(),
        ...parseRoutingPolicy(
          localStorage.getItem(routingPolicyStorageKey),
          registry,
        ),
      });
    } catch {
      // Unavailable browser storage leaves the safe default in place.
    }
    const shadow = new ShadowVisualPreflight(
      coordinator,
      () => manager.visualPermitted(),
      coordinator.totalBudgetMs + 100,
    );
    const current = new CurrentScreenPreflight(() => manager.screenPermitted());
    return { registry, laya, coordinator, shadow, current };
  });
  const snapshot = useSyncExternalStore(
    engines.shadow.subscribe,
    engines.shadow.getSnapshot,
  );
  const [policy, setPolicy] = useState(engines.coordinator.getPolicy());
  const [mode, setMode] = useState<ScreenContextMode>(() => {
    try {
      return parseScreenContextMode(
        localStorage.getItem(screenContextModeStorageKey),
      );
    } catch {
      return "current";
    }
  });
  const [healthRevision, changed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [layaConfig, setConfig] = useState<LayaConfig>(() => {
    try {
      return {
        ...emptyConfig,
        ...JSON.parse(localStorage.getItem("companion.routing.laya") ?? "{}"),
      };
    } catch {
      return emptyConfig;
    }
  });
  function selectMode(value: ScreenContextMode) {
    if (manager.locked || !["current", "semantic"].includes(value)) return;
    engines.coordinator.cancel();
    engines.shadow.cancel();
    setMode(value);
    try {
      localStorage.setItem(
        screenContextModeStorageKey,
        serializeScreenContextMode(value),
      );
    } catch {
      // The explicitly selected mode remains usable for this session.
    }
  }
  function configure(patch: Partial<RouterPolicy>) {
    const previous = engines.coordinator.getPolicy(),
      next = {
        ...previous,
        ...patch,
        localOnly: true,
        remoteShadowOptIn: false,
        fallback: undefined,
      };
    engines.coordinator.configure(next);
    try {
      localStorage.setItem(
        routingPolicyStorageKey,
        serializeRoutingPolicy(next),
      );
    } catch {
      // The selected preference remains usable for this session.
    }
    engines.shadow.configure(
      engines.shadow.getSnapshot().mode,
      enginePlan(next, engines.registry).length > 0,
    );
    setPolicy(next);
    if (
      (previous.preferred !== next.preferred ||
        previous.fallback !== next.fallback) &&
      !enginePlan(next, engines.registry).includes("laya")
    )
      void engines.laya
        .dispose()
        .then(() => changed((n) => n + 1))
        .catch(() => setError("Could not unload the local runtime."));
  }
  async function refresh() {
    await engines.laya.refresh().catch(() => {});
    changed((n) => n + 1);
  }
  async function prepare() {
    engines.coordinator.cancel();
    engines.shadow.cancel();
    setError(null);
    const pending = engines.laya.initialize(layaConfig);
    changed((n) => n + 1);
    try {
      await pending;
    } catch {
      setError(
        `LAYA could not start: ${engines.laya.health().reason ?? "load_failed"}. Check the optional runtime and model paths.`,
      );
    }
    changed((n) => n + 1);
  }
  async function unload() {
    engines.coordinator.cancel();
    engines.shadow.cancel();
    try {
      await engines.laya.dispose();
    } catch {
      setError("Could not unload the local runtime.");
    }
    changed((n) => n + 1);
  }
  function updateConfig(value: LayaConfig) {
    setConfig(value);
    try {
      localStorage.setItem("companion.routing.laya", JSON.stringify(value));
    } catch {
      /* Session-only paths still work. */
    }
  }
  useEffect(() => {
    manager.setVisualPreflight(engines.shadow);
    void refresh();
    const stop = () => {
      engines.shadow.cancel();
      void engines.coordinator.dispose().catch(() => {});
    };
    window.addEventListener("pagehide", stop);
    const timer = setInterval(() => {
      if (["Ready", "Loading"].includes(engines.laya.health().state))
        void engines.laya
          .refresh()
          .then(() => changed((n) => n + 1))
          .catch(() => {});
    }, 5000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", stop);
      manager.setVisualPreflight(null);
      stop();
    };
  }, [engines, manager]);
  useEffect(() => {
    manager.setContextRouter(
      mode === "current" ? engines.current : engines.coordinator,
    );
    return () => manager.setContextRouter(null);
  }, [engines, manager, mode]);
  const readiness: ReturnType<typeof routingReadiness> =
    mode === "current"
      ? { code: "currentScreen" }
      : routingReadiness(policy, engines.registry);
  return {
    mode,
    selectMode,
    snapshot,
    policy,
    configure,
    refresh,
    prepare,
    unload,
    layaConfig,
    updateConfig,
    error,
    healthRevision,
    readiness,
    attempts: engines.coordinator.getLastAttempts(),
    laya: engines.laya.status(),
    available: engines.registry.list().map((e) => ({
      id: e.id,
      label: e.label,
      health: e.health(),
      capabilities: e.capabilities,
    })),
    enabled: (value: boolean) => {
      engines.shadow.configure(
        value ? "Shadow" : "Disabled",
        enginePlan(policy, engines.registry).length > 0,
      );
      if (!value) void unload();
    },
  };
}
