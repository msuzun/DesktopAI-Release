export const voiceConfig = {
  provider: "OpenAI Realtime",
  brokerUrl: "http://127.0.0.1:4317/api/realtime/session",
  callsUrl: "https://api.openai.com/v1/realtime/calls",
  connectionTimeoutMs: 60_000,
  maxEvents: 80,
  maxTranscripts: 40,
  maxTranscriptCharacters: 8_000,
} as const;
