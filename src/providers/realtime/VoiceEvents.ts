import { voiceConfig } from "./config.js";
import type { VoiceSnapshot } from "./RealtimeVoiceProvider.js";

export function initialVoiceSnapshot(): VoiceSnapshot {
  return {
    connection: "Disconnected",
    conversation: "Inactive",
    microphone: "Unavailable",
    provider: voiceConfig.provider,
    model: null,
    connectedAt: null,
    error: null,
    events: [],
    transcripts: [],
    metrics: { connectionMs: null, turnToAudioMs: null, audioDurationMs: null },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

// Provider-specific events stay here, never in React components. No outbound messages.
export class VoiceEvents {
  private speaking = false;
  private responseId: string | null = null;
  private playingId: string | null = null;
  private turnEndedAt: number | null = null;
  private audioStartedAt: number | null = null;

  apply(
    snapshot: VoiceSnapshot,
    raw: unknown,
    now: number,
  ): { snapshot: VoiceSnapshot; sessionReady: boolean; failed: boolean } {
    const event = record(raw);
    let next = { ...snapshot };
    let message: string | null = null;
    let sessionReady = false;
    let failed = false;
    switch (event.type) {
      case "session.created":
        sessionReady = true;
        if (typeof record(event.session).model === "string")
          next.model = record(event.session).model as string;
        message = "Realtime session configured";
        break;
      case "input_audio_buffer.speech_started":
        this.speaking = true;
        this.turnEndedAt = null;
        message = "User speech started";
        break;
      case "input_audio_buffer.speech_stopped":
        this.speaking = false;
        this.turnEndedAt = now;
        message = "User speech stopped";
        break;
      case "response.created":
        this.responseId =
          typeof record(event.response).id === "string"
            ? (record(event.response).id as string)
            : null;
        message = "AI response started";
        break;
      case "response.done": {
        const response = record(event.response);
        if (response.id === this.responseId) this.responseId = null;
        failed = response.status === "failed";
        message = failed
          ? "AI response failed"
          : response.status === "cancelled"
            ? "AI response interrupted"
            : "AI response completed";
        break;
      }
      case "output_audio_buffer.started":
        this.playingId =
          typeof event.response_id === "string" ? event.response_id : "audio";
        this.audioStartedAt = now;
        next.metrics = {
          ...next.metrics,
          turnToAudioMs:
            this.turnEndedAt === null
              ? null
              : Math.max(0, now - this.turnEndedAt),
        };
        this.turnEndedAt = null;
        message = "AI audio output started";
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        if (
          typeof event.response_id !== "string" ||
          event.response_id === this.playingId
        ) {
          this.playingId = null;
          next.metrics = {
            ...next.metrics,
            audioDurationMs:
              this.audioStartedAt === null
                ? null
                : Math.max(0, now - this.audioStartedAt),
          };
          this.audioStartedAt = null;
        }
        message =
          event.type === "output_audio_buffer.cleared"
            ? "AI audio interrupted"
            : "AI audio output stopped";
        break;
      case "conversation.item.input_audio_transcription.completed":
      case "response.output_audio_transcript.done": {
        if (
          typeof event.transcript === "string" &&
          typeof event.item_id === "string"
        ) {
          const role =
            event.type === "response.output_audio_transcript.done"
              ? "AI"
              : "YOU";
          const id = `${role}:${event.item_id}`;
          const transcript = {
            id,
            role: role as "AI" | "YOU",
            text: event.transcript.slice(
              0,
              voiceConfig.maxTranscriptCharacters,
            ),
          };
          const index = next.transcripts.findIndex((entry) => entry.id === id);
          next.transcripts =
            index < 0
              ? [...next.transcripts, transcript].slice(
                  -voiceConfig.maxTranscripts,
                )
              : next.transcripts.map((entry) =>
                  entry.id === id ? transcript : entry,
                );
        }
        break;
      }
      case "conversation.item.truncated":
        // Generated transcript may include words that were never heard during interruption.
        next.transcripts = next.transcripts.filter(
          (entry) => entry.id !== `AI:${event.item_id}`,
        );
        message = "Interrupted assistant transcript removed";
        break;
      case "conversation.item.input_audio_transcription.failed":
        message = "User transcription unavailable for this turn";
        break;
      case "error":
        failed = true;
        message = "Realtime API error";
        break;
      default:
        break;
    }
    if (next.connection === "Connected")
      next.conversation = this.speaking
        ? "User Speaking"
        : this.playingId
          ? "AI Speaking"
          : this.responseId
            ? "AI Thinking"
            : "Listening";
    if (message) next = appendEvent(next, message, now);
    return { snapshot: next, sessionReady, failed };
  }
}

export function appendEvent(
  snapshot: VoiceSnapshot,
  message: string,
  now = Date.now(),
): VoiceSnapshot {
  return {
    ...snapshot,
    events: [...snapshot.events, { at: now, message }].slice(
      -voiceConfig.maxEvents,
    ),
  };
}
