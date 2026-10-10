import { useEffect, useRef, useState } from "react";
import type { useRealtimeVoice } from "./useRealtimeVoice";
import { providerDefinition } from "../providers/realtime/ProviderRegistry";
export function useAISetup(live: ReturnType<typeof useRealtimeVoice>) {
  const provider = live.session.config.providerId;
  const definition = providerDefinition(provider);
  const requiresKey =
    !definition.unavailable && definition.profile?.auth !== "none";
  const input = useRef<HTMLInputElement>(null);
  const [known, setKnown] = useState<{
    provider: string;
    saved: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef(0);
  const saved = definition.unavailable
    ? false
    : !requiresKey
      ? true
      : known?.provider === provider
        ? known.saved
        : null;
  useEffect(() => {
    const id = ++request.current;
    setEditing(false);
    setMessage(null);
    if (input.current) input.current.value = "";
    if (!requiresKey) return;
    void live.credentials.has(provider).then(
      (value) => {
        if (id === request.current) setKnown({ provider, saved: value });
      },
      () => {
        if (id === request.current)
          setMessage(
            "Secure key storage is unavailable. Open the desktop app and try again.",
          );
      },
    );
    return () => {
      ++request.current;
    };
  }, [provider, requiresKey, live.credentials, live.profiles]);
  async function update(remove = false) {
    if (busy || live.manager.locked || !requiresKey) return;
    const id = ++request.current;
    setBusy(true);
    setMessage(null);
    try {
      if (remove) await live.credentials.delete(provider);
      else await live.credentials.save(provider, input.current?.value ?? "");
      if (id === request.current) {
        setKnown({ provider, saved: !remove });
        setEditing(false);
        setMessage(remove ? "API key removed." : "API key saved securely.");
      }
    } catch {
      if (id === request.current)
        setMessage(
          "Could not save your change. Check the API key and try again.",
        );
    } finally {
      if (input.current) input.current.value = "";
      setBusy(false);
    }
  }
  return {
    input,
    saved,
    busy,
    editing,
    setEditing,
    message,
    update,
    requiresKey,
  };
}
