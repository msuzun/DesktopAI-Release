/** Application-owned reasoning content. No transport or speech SDK types. */
export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export type AIImageRole =
  | "Current"
  | "Historical"
  | "HistoricalExact"
  | "FollowUpReference"
  | "CompareHistorical"
  | "CompareCurrent"
  | "PersistentMemory";

export interface AIImage {
  base64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  role: AIImageRole;
  snapshotId?: string;
  timestampUnixMs?: number;
}

export interface AIRequest {
  turnId: string;
  generation: number;
  userText: string;
  history: ConversationMessage[];
  images: AIImage[];
  contextText: string;
  voice?: boolean;
}

export type AIResponseEvent =
  | { type: "text_delta"; text: string }
  | { type: "text_complete"; text: string }
  | { type: "audio"; base64: string; mimeType: string; sampleRate?: number }
  | { type: "completed"; finishReason?: string }
  | { type: "error"; code: string; message: string };

export interface AIProviderAdapter {
  stream(
    request: AIRequest,
    signal: AbortSignal,
  ): AsyncIterable<AIResponseEvent>;
}

/** Byte ownership ends with release. Call validate immediately before submission. */
export interface PreparedTurn {
  images: AIImage[];
  contextText: string;
  route: string;
  validate(): Promise<void>;
  submitted(): void;
  release(): void;
}

export type ContextPreparer = (
  text: string,
  turnId: string,
  signal: AbortSignal,
  completedMonotonicAt?: number,
) => Promise<PreparedTurn>;
