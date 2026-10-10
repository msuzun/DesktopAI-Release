import { useEffect, useRef, useState } from "react";
import * as api from "./api";

export function useSession() {
  const [active, setActive] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [frame, setFrame] = useState<api.CapturedFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<api.DetectionConfig | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const generation = useRef(0);
  const transitionLock = useRef(false);
  const captureLock = useRef(false);
  const activeRef = useRef(false);
  const [testing, setTesting] = useState(false);
  const testLock = useRef(false);

  useEffect(() => {
    let disposed = false;
    api
      .detectionConfig()
      .then((value) => {
        if (!disposed) {
          setConfig(value);
          setThreshold(value.defaultThreshold);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(api.errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);

  async function transition(start: boolean, clearPreview = true) {
    if (transitionLock.current)
      throw new Error("Screen access is changing. Try again.");
    transitionLock.current = true;
    setTransitioning(true);
    generation.current += 1;
    if (clearPreview) setFrame(null);
    setError(null);
    try {
      await (start ? api.startSession() : api.stopSession());
      activeRef.current = start;
      setActive(start);
    } catch (cause) {
      setError(api.errorMessage(cause));
      throw cause;
    } finally {
      transitionLock.current = false;
      setTransitioning(false);
    }
  }

  async function capture(kind: "context" | "detail") {
    if (
      !activeRef.current ||
      threshold === null ||
      transitionLock.current ||
      captureLock.current
    )
      return;
    captureLock.current = true;
    const requestGeneration = generation.current;
    setCapturing(true);
    setError(null);
    try {
      const result = await api.captureScreen(threshold, { kind });
      if (generation.current === requestGeneration) setFrame(result);
    } catch (cause) {
      if (generation.current === requestGeneration)
        setError(api.errorMessage(cause));
    } finally {
      captureLock.current = false;
      setCapturing(false);
    }
  }

  return {
    testing,
    testCapture: async (kind: "context" | "detail") => {
      if (testLock.current || transitionLock.current || captureLock.current)
        return;
      testLock.current = true;
      setTesting(true);
      const temporary = !activeRef.current;
      try {
        if (temporary) await transition(true);
        await capture(kind);
      } catch (cause) {
        setError(api.errorMessage(cause));
      } finally {
        if (temporary) {
          try {
            await transition(false, false);
          } catch {
            setError("Could not stop local capture. Close and reopen the app.");
          }
        }
        testLock.current = false;
        setTesting(false);
      }
    },
    isActive: () => activeRef.current,
    active,
    transitioning,
    capturing,
    frame,
    error,
    config,
    start: () => transition(true),
    stop: () => transition(false),
  };
}
