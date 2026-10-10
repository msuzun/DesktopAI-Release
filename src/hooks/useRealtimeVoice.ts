import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVisualRouting } from "./useVisualRouting";
import { nativeCredentials } from "../providers/realtime/CredentialService.js";
import { LiveSessionManager } from "../providers/realtime/LiveSessionManager.js";
import {
  nativeProfileStore,
  type ConfiguredAIProvider,
} from "../providers/realtime/universal/ProviderProfile.js";
import {
  setConfiguredProviders,
  ensureUnavailableProvider,
} from "../providers/realtime/ProviderRegistry.js";
import {
  loadPreferences,
  savePreferences,
} from "../providers/realtime/preferences.js";

export function useRealtimeVoice() {
  const [runtimeSupport] = useState(() => ({
    secureContext: window.isSecureContext,
    webRtc: typeof RTCPeerConnection !== "undefined",
    microphone: typeof navigator.mediaDevices?.getUserMedia === "function",
  }));
  const [credentials] = useState(() => nativeCredentials(invoke));
  const [profiles, setProfiles] = useState<ConfiguredAIProvider[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profileStore] = useState(() => nativeProfileStore(invoke));
  const profileRevision = useRef(0);
  const [manager] = useState(() => {
    const value = new LiveSessionManager(credentials);
    try {
      value.configure(loadPreferences(window.localStorage));
    } catch {
      /* Defaults remain available. */
    }
    return value;
  });
  const session = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const refreshProfiles = useCallback(async () => {
    const revision = ++profileRevision.current;
    const values = await profileStore.list();
    if (revision !== profileRevision.current) return;
    setConfiguredProviders(values);
    const selected = manager.getSnapshot().config.providerId;
    ensureUnavailableProvider(selected);
    setProfiles(values);
  }, [manager, profileStore]);
  useEffect(() => {
    let active = true;
    const pending = refreshProfiles();
    const revision = profileRevision.current;
    void pending
      .then(() => {
        if (active && revision === profileRevision.current && !manager.locked)
          manager.configure(loadPreferences(window.localStorage));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setProfilesLoaded(true);
      });
    return () => {
      active = false;
      ++profileRevision.current;
    };
  }, [refreshProfiles, manager]);
  const routing = useVisualRouting(manager);
  const voice = session.voice;
  useEffect(() => {
    if (!profilesLoaded) return;
    try {
      savePreferences(window.localStorage, session.config);
    } catch {
      /* Storage may be disabled. */
    }
  }, [session.config, profilesLoaded]);
  useEffect(() => {
    const stop = () => manager.stop();
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      manager.stop();
    };
  }, [manager]);
  return {
    runtimeSupport,
    profiles,
    refreshProfiles,
    profilesLoaded,
    routing,
    session,
    manager,
    credentials,
    voice,
    toggleMute: () => manager.setMuted(voice.microphone !== "Muted"),
  };
}
