import catalog from "./catalog.json" with { type: "json" };
import type { CredentialService, SessionConfig } from "./CredentialService.js";
import type { RealtimeVoiceProvider } from "./RealtimeVoiceProvider.js";
import { OpenAIRealtimeVoiceProvider } from "./OpenAIRealtimeVoiceProvider.js";
import { GeminiLiveProvider } from "./gemini/GeminiLiveProvider.js";
import { VoiceError } from "./errors.js";
import { createComposedProvider } from "./universal/createComposedProvider.js";
import {
  isProviderProfile,
  isReasoningProfile,
  type ConfiguredAIProvider,
} from "./universal/ProviderProfile.js";
export type ProviderCapabilities =
  (typeof catalog.providers)[number]["capabilities"];
export interface ProviderDefinition {
  id: string;
  displayName: string;
  models: string[];
  voices: string[];
  capabilities: ProviderCapabilities;
  composed?: boolean;
  unavailable?: boolean;
  profile?: ConfiguredAIProvider;
}
export const providerDefinitions: ProviderDefinition[] = [...catalog.providers];
let configuredProfiles: ConfiguredAIProvider[] = [];
const emptyCapabilities: ProviderCapabilities = {
  realtimeAudio: false,
  textInput: false,
  imageInput: false,
  toolCalling: false,
  interruption: false,
  serverVad: false,
  semanticVad: false,
  transcription: false,
  multipleImages: false,
  maxContextImages: 0,
  visualMetadata: false,
};
const noProvider: ProviderDefinition = {
  id: "",
  displayName: "Needs Setup",
  models: [""],
  voices: [""],
  capabilities: emptyCapabilities,
  unavailable: true,
};
export function configuredProvider(id: string) {
  return configuredProfiles.find((p) => p.id === id);
}
export function getConfiguredProviders(): readonly ConfiguredAIProvider[] {
  return configuredProfiles;
}
export function setConfiguredProviders(
  profiles: readonly ConfiguredAIProvider[],
) {
  configuredProfiles = profiles.filter(isProviderProfile).slice(0, 64);
  providerDefinitions.splice(
    0,
    providerDefinitions.length,
    ...catalog.providers,
  );
  for (const profile of configuredProfiles) {
    if (!isReasoningProfile(profile)) {
      if (
        !["openai-transcription", "openai-speech"].includes(profile.adapterType)
      )
        ensureUnavailableProvider(profile.id, profile.displayName);
      continue;
    }
    if (providerDefinitions.some((p) => p.id === profile.id)) continue;
    providerDefinitions.push({
      id: profile.id,
      displayName: profile.displayName,
      models: [profile.model],
      voices: ["system"],
      composed: true,
      profile,
      capabilities: {
        ...emptyCapabilities,
        textInput: profile.capabilities.textInput,
        imageInput: profile.capabilities.vision,
        interruption: true,
        multipleImages: profile.capabilities.multiImage,
        maxContextImages: profile.capabilities.vision
          ? profile.capabilities.multiImage
            ? 4
            : 1
          : 0,
        visualMetadata: true,
      },
    });
  }
}
export function ensureUnavailableProvider(
  id: string,
  displayName = "Unavailable provider",
) {
  if (!id || providerDefinitions.some((p) => p.id === id)) return;
  providerDefinitions.push({ ...noProvider, id, displayName });
}
export function providerDefinition(id: string): ProviderDefinition {
  if (!id) return noProvider;
  const definition = providerDefinitions.find((item) => item.id === id);
  if (!definition) throw new VoiceError("Unsupported AI provider.");
  return definition;
}
export function defaultConfig(id = providerDefinitions[0].id): SessionConfig {
  const def = providerDefinition(id);
  return { providerId: id, model: def.models[0], voice: def.voices[0] };
}
export function validateConfig(config: SessionConfig) {
  const def = providerDefinition(config.providerId);
  if (def.unavailable) return;
  if (
    !def.models.includes(config.model) ||
    !def.voices.includes(config.voice) ||
    (!def.composed && !def.capabilities.realtimeAudio)
  )
    throw new VoiceError("Unsupported voice configuration.");
}
export function createProvider(
  config: SessionConfig,
  credentials: CredentialService,
): RealtimeVoiceProvider {
  validateConfig(config);
  const definition = providerDefinition(config.providerId);
  if (definition.unavailable)
    throw new VoiceError("Choose an available AI provider in Settings.");
  if (definition.composed) return createComposedProvider(config, credentials);
  const factories: Record<string, () => RealtimeVoiceProvider> = {
    openai: () =>
      new OpenAIRealtimeVoiceProvider(undefined, async (signal) => {
        const credential = await credentials.issue(config, signal);
        if (
          credential.kind !== "ephemeral" ||
          !credential.value.startsWith("ek_")
        )
          throw new VoiceError("Invalid realtime credential.");
        return {
          clientSecret: credential.value,
          model: credential.model,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        };
      }),
    gemini: () => new GeminiLiveProvider(config, credentials),
  };
  const factory = factories[config.providerId];
  if (!factory) throw new VoiceError("Provider implementation unavailable.");
  return factory();
}
