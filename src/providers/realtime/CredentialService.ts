import { VoiceError } from "./errors.js";
import { profileIdPattern } from "./universal/ProviderProfile.js";
export interface SessionConfig {
  providerId: string;
  model: string;
  voice: string;
  recognitionProfileId?: string;
  synthesisProfileId?: string;
  language?: "en" | "tr";
}
export type ProviderCredential = {
  kind: "ephemeral" | "apiKey";
  value: string;
  model: string;
};
export interface CredentialService {
  has(provider: string): Promise<boolean>;
  save(provider: string, secret: string): Promise<void>;
  delete(provider: string): Promise<void>;
  issue(
    config: SessionConfig,
    signal: AbortSignal,
  ): Promise<ProviderCredential>;
}
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export function nativeCredentials(invoke: Invoke): CredentialService {
  async function call<T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      throw new VoiceError(
        typeof error === "string" && error.length < 180
          ? error
          : "Desktop credential service unavailable. Run the Tauri desktop application.",
      );
    }
  }
  return {
    has: (provider) =>
      provider === ""
        ? Promise.resolve(false)
        : profileIdPattern.test(provider)
          ? call("ai_profile_has_key", { profileId: provider })
          : call("has_voice_key", { provider }),
    save: (provider, secret) =>
      profileIdPattern.test(provider)
        ? call("ai_profile_save_key", { profileId: provider, secret })
        : call("save_voice_key", { provider, secret }),
    delete: (provider) =>
      profileIdPattern.test(provider)
        ? call("ai_profile_delete_key", { profileId: provider })
        : call("delete_voice_key", { provider }),
    async issue(config, signal) {
      if (signal.aborted) throw new VoiceError("Connection cancelled.");
      const result = await call<ProviderCredential>("voice_credential", {
        config,
      });
      if (signal.aborted) throw new VoiceError("Connection cancelled.");
      if (
        result.kind !== "ephemeral" ||
        !result.value ||
        result.model !== config.model
      )
        throw new VoiceError("Invalid voice credential.");
      return result;
    },
  };
}
