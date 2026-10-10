// Generated speech may arrive much faster than it is spoken. Bound queued media,
// not response length to eight seconds. At 24 kHz this is <= 11.52 MB of Float32 PCM.
export const playbackLimits = {
  maxQueuedSeconds: 120,
  maxScheduledSources: 2048,
  maxChunkBase64Characters: 1_000_000,
} as const;
export class PlaybackQueueFullError extends Error {}
