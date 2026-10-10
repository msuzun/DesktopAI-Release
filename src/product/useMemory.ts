import { useCallback, useEffect, useRef, useState } from "react";
import {
  memoryApi,
  memoryErrorKey,
  type MemorySettings,
  type MemoryStatus,
} from "./memoryApi";
export function useMemory() {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await memoryApi.status();
      if (mounted.current) {
        setStatus(next);
        setError(
          next.health === "unavailable" ? memoryErrorKey(next.errorCode) : null,
        );
      }
    } catch (cause) {
      if (mounted.current) setError(memoryErrorKey(cause));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (status?.health !== "starting") return;
    const timer = setTimeout(() => void refresh(), 500);
    return () => clearTimeout(timer);
  }, [status, refresh]);
  async function run<T>(
    action: () => Promise<T>,
  ): Promise<{ value: T } | undefined> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await action();
      await refresh();
      if (mounted.current) setRevision((value) => value + 1);
      return { value };
    } catch (cause) {
      if (mounted.current) setError(memoryErrorKey(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return {
    status,
    error,
    busy,
    revision,
    refresh,
    run,
    configure: (settings: MemorySettings) =>
      run(() => memoryApi.configure(settings)),
  };
}
export type MemoryController = ReturnType<typeof useMemory>;
