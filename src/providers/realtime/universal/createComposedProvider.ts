import type { CredentialService, SessionConfig } from "../CredentialService.js";
import { configuredProvider } from "../ProviderRegistry.js";
import { VoiceError } from "../errors.js";
import {
  NativeReasoningAdapter,
  nativeRecognition,
  nativeSynthesis,
} from "./NativeTransport.js";
import { VoiceConversationPipeline } from "./VoiceConversationPipeline.js";

export function createComposedProvider(
  config: SessionConfig,
  credentials: CredentialService,
) {
  const profile = configuredProvider(config.providerId);
  if (!profile) throw new VoiceError("Choose an available reasoning service.");
  const recognition = configuredProvider(config.recognitionProfileId ?? "");
  const synthesis = configuredProvider(config.synthesisProfileId ?? "");
  return new VoiceConversationPipeline({
    providerName: profile.displayName,
    model: profile.model,
    reasoning: new NativeReasoningAdapter(
      profile.id,
      profile.capabilities.streaming,
    ),
    recognition:
      recognition?.adapterType === "openai-transcription"
        ? nativeRecognition(recognition.id, config.language ?? "en")
        : undefined,
    synthesis:
      synthesis?.adapterType === "openai-speech"
        ? nativeSynthesis(synthesis.id, synthesis.voice)
        : undefined,
    speechReady: async () => {
      if (!recognition || !synthesis) return false;
      try {
        const readiness = await Promise.all([
          recognition.auth === "none" || credentials.has(recognition.id),
          synthesis.auth === "none" || credentials.has(synthesis.id),
        ]);
        return readiness.every(Boolean);
      } catch {
        return false;
      }
    },
  });
}
