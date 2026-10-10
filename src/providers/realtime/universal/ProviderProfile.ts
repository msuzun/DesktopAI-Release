/** Metadata only. Credentials never enter this object or browser storage. */
export interface AIProviderCapabilities {
  textInput: boolean;
  textOutput: boolean;
  vision: boolean;
  multiImage: boolean;
  streaming: boolean;
  nativeAudioInput: boolean;
  nativeAudioOutput: boolean;
  realtime: boolean;
}
export type AdapterType =
  "openai-compatible" | "anthropic" | "openai-transcription" | "openai-speech";
export interface ConfiguredAIProvider {
  id: string;
  displayName: string;
  adapterType: AdapterType;
  baseUrl: string;
  model: string;
  capabilities: AIProviderCapabilities;
  auth: "none" | "apiKey";
  voice?: string;
}
export const profileIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isReasoningProfile(profile: ConfiguredAIProvider) {
  return ["openai-compatible", "anthropic"].includes(profile.adapterType);
}
export function profileCapabilities(
  adapterType: AdapterType,
): AIProviderCapabilities {
  const reasoning = ["openai-compatible", "anthropic"].includes(adapterType);
  return {
    textInput: reasoning || adapterType === "openai-speech",
    textOutput: reasoning || adapterType === "openai-transcription",
    vision: false,
    multiImage: false,
    streaming: false,
    nativeAudioInput: adapterType === "openai-transcription",
    nativeAudioOutput: adapterType === "openai-speech",
    realtime: false,
  };
}
/** Defensive metadata validation; native validation remains authoritative. */
export function isProviderProfile(
  value: unknown,
): value is ConfiguredAIProvider {
  if (!value || typeof value !== "object") return false;
  const p = value as ConfiguredAIProvider;
  return (
    typeof p.id === "string" &&
    profileIdPattern.test(p.id) &&
    typeof p.displayName === "string" &&
    p.displayName.length > 0 &&
    p.displayName.length <= 100 &&
    typeof p.adapterType === "string" &&
    p.adapterType.length <= 80 &&
    typeof p.baseUrl === "string" &&
    p.baseUrl.length <= 2048 &&
    typeof p.model === "string" &&
    p.model.length > 0 &&
    p.model.length <= 200 &&
    (p.auth === "none" || p.auth === "apiKey") &&
    !!p.capabilities &&
    Object.keys(profileCapabilities("openai-compatible")).every(
      (key) =>
        typeof p.capabilities[key as keyof AIProviderCapabilities] ===
        "boolean",
    )
  );
}
export type ProfileInvoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;
export function nativeProfileStore(invoke: ProfileInvoke) {
  return {
    async list(): Promise<ConfiguredAIProvider[]> {
      const values = await invoke<unknown>("ai_profiles_list", {});
      return Array.isArray(values)
        ? values.filter(isProviderProfile).slice(0, 64)
        : [];
    },
    save: (profile: ConfiguredAIProvider) =>
      invoke<void>("ai_profile_save", { profile }),
    delete: (profileId: string) =>
      invoke<void>("ai_profile_delete", { profileId }),
    hasKey: (profileId: string) =>
      invoke<boolean>("ai_profile_has_key", { profileId }),
    saveKey: (profileId: string, secret: string) =>
      invoke<void>("ai_profile_save_key", { profileId, secret }),
    deleteKey: (profileId: string) =>
      invoke<void>("ai_profile_delete_key", { profileId }),
  };
}
