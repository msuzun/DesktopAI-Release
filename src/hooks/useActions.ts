import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LiveSessionManager } from "../providers/realtime/LiveSessionManager";
import {
  ActionIntentEngine,
  type ActionCandidateIdentity,
} from "../providers/realtime/actions/ActionIntentEngine";

export function useActions(manager: LiveSessionManager, language: string) {
  const locale = useRef(language);
  locale.current = language;
  const [engine] = useState(
    () => new ActionIntentEngine(invoke, () => locale.current),
  );
  const [snapshot, setSnapshot] = useState(() => engine.getSnapshot());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = engine.subscribe(setSnapshot);
    manager.setActionHandler(engine.handle, () => engine.cancel());
    void engine.configure(false).catch(() => {
      if (mounted) setError(true);
    });
    const cancel = () => engine.cancel();
    window.addEventListener("pagehide", cancel);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("pagehide", cancel);
      manager.setActionHandler(null);
      engine.cancel();
      void engine.configure(false).catch(() => {});
    };
  }, [engine, manager]);
  async function configure(enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await engine.configure(enabled);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    try {
      await engine.refresh();
    } catch {
      setError(true);
    }
  }
  return {
    status: snapshot.status,
    candidate: snapshot.candidate,
    confirmationBusy: snapshot.confirming,
    confirmationMessage: snapshot.message,
    confirm: (identity: ActionCandidateIdentity) => engine.confirm(identity),
    reject: (identity: ActionCandidateIdentity) => engine.reject(identity),
    configure,
    refresh,
    busy,
    error,
  };
}
