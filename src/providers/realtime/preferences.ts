import type { SessionConfig } from "./CredentialService.js";
import {
  defaultConfig,
  ensureUnavailableProvider,
  validateConfig,
} from "./ProviderRegistry.js";
import { profileIdPattern } from "./universal/ProviderProfile.js";
const key = "companion.ai.v1";
type StoragePort = Pick<Storage, "getItem" | "setItem">;
export function loadPreferences(storage: StoragePort): SessionConfig {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (
      typeof value?.providerId !== "string" ||
      typeof value?.model !== "string" ||
      typeof value?.voice !== "string"
    )
      return defaultConfig();
    if (profileIdPattern.test(value.providerId))
      ensureUnavailableProvider(value.providerId);
    const config: SessionConfig = {
      providerId: value.providerId,
      model: value.model,
      voice: value.voice,
    };
    if (
      typeof value.recognitionProfileId === "string" &&
      profileIdPattern.test(value.recognitionProfileId)
    )
      config.recognitionProfileId = value.recognitionProfileId;
    if (
      typeof value.synthesisProfileId === "string" &&
      (value.synthesisProfileId === "system" ||
        profileIdPattern.test(value.synthesisProfileId))
    )
      config.synthesisProfileId = value.synthesisProfileId;
    if (value.language === "en" || value.language === "tr")
      config.language = value.language;
    validateConfig(config);
    return config;
  } catch {
    return defaultConfig();
  }
}
export function savePreferences(storage: StoragePort, config: SessionConfig) {
  try {
    validateConfig(config);
    storage.setItem(
      key,
      JSON.stringify({
        providerId: config.providerId,
        model: config.model,
        voice: config.voice,
        recognitionProfileId: config.recognitionProfileId,
        synthesisProfileId: config.synthesisProfileId,
        language: config.language,
      }),
    );
  } catch {
    /* A blocked local store must not prevent conversation. */
  }
}
