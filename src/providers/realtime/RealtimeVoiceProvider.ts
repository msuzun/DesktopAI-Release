export type ConnectionState = "Disconnected" | "Connecting" | "Connected";
export type ConversationState =
  "Inactive" | "Listening" | "User Speaking" | "AI Thinking" | "AI Speaking";
export interface Transcript {
  id: string;
  role: "YOU" | "AI";
  text: string;
}
export interface VoiceSnapshot {
  connection: ConnectionState;
  conversation: ConversationState;
  microphone: "Unavailable" | "Active" | "Muted";
  provider: string;
  model: string | null;
  connectedAt: number | null;
  error: string | null;
  notice?: string | null;
  pipeline?: {
    transport: "http";
    nativeLiveSession: false;
    state: string;
    generation: number;
    timings: Record<string, number>;
  };
  diagnostics?: import("./gemini/LiveDiagnostics.js").LiveDiagnosticSnapshot;
  events: { at: number; message: string }[];
  transcripts: Transcript[];
  metrics: {
    connectionMs: number | null;
    turnToAudioMs: number | null;
    audioDurationMs: number | null;
  };
}

export interface RealtimeVoiceProvider {
  readonly composed?: boolean;
  sendText?(text: string): Promise<void>;
  /** Final conversational text only; exclude partial/cancelled assistant output and media. */
  getConversationHistory?(): import("./universal/types.js").ConversationMessage[];
  /** Seed a new connection before connect; implementations copy and bound the input. */
  setConversationHistory?(
    history: import("./universal/types.js").ConversationMessage[],
  ): void;
  interrupt?(): void;
  setActionHandler?(
    handler: import("./actions/ActionIntentEngine.js").ActionTurnHandler | null,
  ): void;
  /** Native final-user identity; never an assistant or tool item. */
  isCurrentUserTurn?(turnId: string): boolean;
  /** Local action feedback after classification; does not authorize execution. */
  actionHandled?(turnId: string, message?: string): void;
  setContextPreparer?(
    prepare: import("./universal/types.js").ContextPreparer,
    completed?: () => void,
    reserve?: (turnId: string, completedMonotonicAt: number) => void,
  ): void;
  enableResponseControl?(): Promise<void>;
  disableResponseControl?(): Promise<void>;
  restartResponseControl?(): Promise<void>;
  finishVoiceTurn?(): void;
  responseControlHint?(): string;
  setTurnHandler?(
    handler:
      ((event: import("./turns/TurnCoordinator.js").TurnEvent) => void) | null,
  ): void;
  requestTurnResponse?(
    turnId: string,
    freshness: import("./turns/TurnCoordinator.js").Freshness,
  ): void;

  setToolHandler?(
    handler: import("./visual/types.js").ToolHandler | null,
  ): void;
  maxImageBytes?(): number;
  sendVisualContext?(
    context: import("./visual/types.js").VisualContext,
    signal: AbortSignal,
    call?: import("./visual/types.js").ToolCall,
  ): Promise<import("./visual/types.js").VisualDelivery>;
  sendToolResult?(
    call: import("./visual/types.js").ToolCall,
    result: import("./visual/types.js").ToolResult,
  ): void;
  connect(testOnly?: boolean): Promise<void>;
  disconnect(): void;
  setMuted(muted: boolean): void;
  getSnapshot(): VoiceSnapshot;
  subscribe(listener: () => void): () => void;
}
