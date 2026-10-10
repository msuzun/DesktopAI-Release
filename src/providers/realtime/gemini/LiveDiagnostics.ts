export type Counter =
  | "microphoneChunks"
  | "audioSent"
  | "activityStarts"
  | "activityEnds"
  | "imagesSent"
  | "serverMessages"
  | "audioReceived"
  | "audioDropped"
  | "audioScheduled"
  | "inputTranscriptions"
  | "outputTranscriptions"
  | "toolCalls"
  | "toolResults"
  | "toolTimeouts"
  | "recentToolRequests"
  | "recentToolResults"
  | "recentEmptyResults"
  | "recentImageResults"
  | "historicalDetailRequests"
  | "combinedVisualTurns"
  | "multiToolContinuations"
  | "toolLimitRejections"
  | "toolCorrelationFailures"
  | "interruptions";
export type TraceEvent =
  | "setup_sent"
  | "setup_complete"
  | "speech_started"
  | "speech_endpoint"
  | "reservation_requested"
  | "speech_resumed"
  | "speech_completed"
  | "visual_preparation_started"
  | "visual_context_requested"
  | "visual_ready"
  | "submission_started"
  | "first_server_event"
  | "first_content"
  | "model_continuation"
  | "response_cancelled"
  | "image_queued"
  | "image_drained"
  | "response_requested"
  | "audio_received"
  | "audio_dropped"
  | "audio_scheduled"
  | "generation_complete"
  | "turn_complete"
  | "interrupted"
  | "waiting_for_input"
  | "tool_call"
  | "tool_result"
  | "tool_timeout"
  | "response_timeout"
  | "connection_error";
export interface TraceDetails {
  intent?: import("../visual/VisualInspection.js").VisualInspectionIntent;
  callId?: string;
  requestId?: string;
  kind?: "current" | "recent" | "detail";
  snapshotId?: string;
  status?: string;
  frames?: {
    snapshotId: string;
    role: string;
    origin: string;
    width: number;
    height: number;
    encodedSizeBytes: number;
  }[];
  timings?: Record<string, number>;
}
export type Issue =
  | "NO_PROVIDER_EVENTS"
  | "PROVIDER_WAITING_FOR_INPUT"
  | "OUTPUT_SUPPRESSED"
  | "NO_AUDIO_RESPONSE"
  | "TOOL_STALLED"
  | "PLAYBACK_FAILED"
  | "CONNECTION_FAILED";
export interface LiveDiagnosticSnapshot {
  version: 1;
  connection: number;
  mode: "AUTOMATIC" | "MANUAL";
  turn: string | null;
  userTurn: string | null;
  gate: "HELD" | "OPEN" | "DISCARDING" | "RECOVERY_REQUIRED";
  issue: Issue | null;
  responseRequestedAt: number | null;
  lastServerEventAt: number | null;
  audioContext: string;
  pendingTools: number;
  socketBufferedBytes: number;
  voiceOnset?: {
    rms: number;
    threshold: number;
    sustainedMs: number;
    interrupting: boolean;
  };
  counters: Record<Counter, number>;
  events: ({
    at: number;
    monotonicAt: number;
    type: TraceEvent;
    turn: string | null;
    userTurn: string | null;
  } & TraceDetails)[];
}
// Only allowlisted event names, local identifiers, timestamps and counters enter
// this report. Provider payloads, URLs, credentials and transcript text never do.
export class LiveDiagnostics {
  data: LiveDiagnosticSnapshot;
  constructor(
    connection: number,
    controlled: boolean,
    private now: () => number,
    private monotonicNow = () => performance.now(),
  ) {
    this.data = {
      version: 1,
      connection,
      mode: controlled ? "MANUAL" : "AUTOMATIC",
      turn: null,
      userTurn: null,
      gate: controlled ? "HELD" : "OPEN",
      issue: null,
      responseRequestedAt: null,
      lastServerEventAt: null,
      audioContext: "unavailable",
      pendingTools: 0,
      socketBufferedBytes: 0,
      counters: {
        microphoneChunks: 0,
        audioSent: 0,
        activityStarts: 0,
        activityEnds: 0,
        imagesSent: 0,
        serverMessages: 0,
        audioReceived: 0,
        audioDropped: 0,
        audioScheduled: 0,
        inputTranscriptions: 0,
        outputTranscriptions: 0,
        toolCalls: 0,
        toolResults: 0,
        toolTimeouts: 0,
        recentToolRequests: 0,
        recentToolResults: 0,
        recentEmptyResults: 0,
        recentImageResults: 0,
        historicalDetailRequests: 0,
        combinedVisualTurns: 0,
        multiToolContinuations: 0,
        toolLimitRejections: 0,
        toolCorrelationFailures: 0,
        interruptions: 0,
      },
      events: [],
    };
  }
  count(key: Counter, count = 1) {
    this.data.counters[key] += count;
  }
  event(
    type: TraceEvent,
    details: TraceDetails = {},
    monotonicAt = this.monotonicNow(),
  ) {
    this.data.events.push({
      ...details,
      at: this.now(),
      monotonicAt,
      type,
      turn: this.data.turn,
      userTurn: this.data.userTurn,
    });
    if (this.data.events.length > 100) this.data.events.shift();
  }
  snapshot(): LiveDiagnosticSnapshot {
    return {
      ...this.data,
      counters: { ...this.data.counters },
      events: this.data.events.map((e) => ({
        ...e,
        frames: e.frames?.map((f) => ({ ...f })),
        timings: e.timings ? { ...e.timings } : undefined,
      })),
    };
  }
}
