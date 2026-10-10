export class VoiceError extends Error {}

export function microphoneError(cause: unknown): VoiceError {
  const name =
    cause instanceof Error || cause instanceof DOMException ? cause.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new VoiceError(
        "Microphone permission denied. Allow microphone access in WebView2 and Windows Settings > Privacy & security > Microphone (desktop apps).",
      );
    case "NotFoundError":
      return new VoiceError(
        "No microphone available. Connect a microphone and try again.",
      );
    case "NotReadableError":
      return new VoiceError(
        "The microphone could not be opened. Check whether another application or Windows is blocking it.",
      );
    default:
      return new VoiceError(
        "Microphone initialization failed. Check your audio device and try again.",
      );
  }
}

export function safeError(cause: unknown): string {
  return cause instanceof VoiceError
    ? cause.message
    : "Voice connection failed. Check provider settings and network, then start again.";
}
