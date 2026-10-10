import { inspectionRequest } from "../visual/VisualInspection.js";
import { FinalTranscript } from "../preflight/FinalTranscript.js";
import {
  NativeConversationHistory,
  historyLimits,
} from "../universal/ConversationHistory.js";
import type { ConversationMessage } from "../universal/types.js";
import type { TurnEvent, Freshness } from "../turns/TurnCoordinator.js";
import { PcmTurnDetector } from "../turns/PcmTurnDetector.js";
import { waitForDrain } from "./waitForDrain.js";
import {
  LiveDiagnostics,
  type Issue,
  type TraceEvent,
  type TraceDetails,
} from "./LiveDiagnostics.js";
import type { CredentialService, SessionConfig } from "../CredentialService.js";
import type {
  RealtimeVoiceProvider,
  VoiceSnapshot,
} from "../RealtimeVoiceProvider.js";
import { appendEvent, initialVoiceSnapshot } from "../VoiceEvents.js";
import { safeError, VoiceError } from "../errors.js";
import { PcmAudio } from "../audio/PcmAudio.js";
import { PlaybackQueueFullError } from "../audio/playbackLimits.js";
import catalog from "../catalog.json" with { type: "json" };
import visualConfig from "../visual/config.json" with { type: "json" };
import { contextText } from "../visual/TemporalContext.js";
import { noteVisualEnqueue } from "../visual/DeliveryCounters.js";
import type {
  ToolHandler,
  ToolCall,
  ToolResult,
  VisualContext,
  VisualDelivery,
} from "../visual/types.js";

export interface GeminiEnvironment {
  socket(url: string): WebSocket;
  audio(activity: (playing: boolean) => void): PcmAudio;
  now(): number;
}
const browserEnvironment: GeminiEnvironment = {
  socket: (url) => new WebSocket(url),
  audio: (activity) => new PcmAudio(activity),
  now: () => Date.now(),
};
interface Attempt {
  actionTurn?: string;
  historyOutput?: string;
  historyOutputTurn?: string;
  historyOutputOverflow?: boolean;
  historyRetiring?: boolean;
  historyInputFinished?: boolean;
  historyTurnComplete?: boolean;
  transcript?: FinalTranscript;
  abort: AbortController;
  socket?: WebSocket;
  audio?: PcmAudio;
  timer?: ReturnType<typeof setTimeout>;
  resolve: () => void;
  started: number;
  turn: number;
  generating: boolean;
  discardAudio?: boolean;
  visualAllowance?: number;
  detector?: PcmTurnDetector;
  passiveDetector?: PcmTurnDetector;
  activityOpen?: boolean;
  userTurn?: string;
  outputAllowed: boolean;
  visualTurnId?: string;
  suppressGeneration?: boolean;
  responseStarted?: boolean;
  audioStarted?: boolean;
  retiredTurnCompletion?: boolean;
  diagnostics: LiveDiagnostics;
  diagnosticTimer?: ReturnType<typeof setTimeout>;
  responseTimer?: ReturnType<typeof setTimeout>;
  recoveryRequired?: boolean;
  waitingForInput?: boolean;
  visualKinds: Set<string>;
  answeredInTurn: number;
  firstServerEvent?: boolean;
  firstContent?: boolean;
  continuationCall?: string;
}
export class GeminiLiveProvider implements RealtimeVoiceProvider {
  private history = new NativeConversationHistory();
  isCurrentUserTurn(turnId: string) {
    return this.attempt?.userTurn === turnId;
  }
  actionHandled(turnId: string, message?: string) {
    const attempt = this.attempt;
    if (!attempt || attempt.userTurn !== turnId) return;
    attempt.actionTurn = turnId;
    attempt.historyOutput = "";
    attempt.historyOutputTurn = undefined;
    attempt.audio?.interrupt();
    attempt.generating = false;
    this.cancelTools();
    this.publish({
      ...this.snapshot,
      conversation: "Listening",
      notice: message ?? "Review the action request in the app.",
    });
  }
  interrupt() {
    const turn = this.attempt?.userTurn;
    if (turn) this.actionHandled(turn, "");
  }
  getConversationHistory() {
    return this.history.get();
  }
  setConversationHistory(history: ConversationMessage[]) {
    if (this.attempt)
      throw new VoiceError("Stop the active session before changing settings.");
    this.history.set(history);
  }
  private beginHistoryTurn(attempt: Attempt) {
    attempt.actionTurn = undefined;
    attempt.historyRetiring = !!(
      attempt.historyOutput ||
      attempt.generating ||
      this.snapshot.conversation === "AI Speaking"
    );
    if (attempt.userTurn) this.history.begin(attempt.userTurn);
    attempt.historyOutput = "";
    attempt.historyOutputTurn = undefined;
    attempt.historyOutputOverflow = false;
    attempt.historyInputFinished = false;
    attempt.historyTurnComplete = false;
  }
  private controlled = false;
  private turnSequence = 0;
  private connectionSequence = 0;
  private turnHandler: ((event: TurnEvent) => void) | null = null;
  setTurnHandler(handler: ((event: TurnEvent) => void) | null) {
    this.turnHandler = handler;
  }
  responseControlHint() {
    return "Gemini reconnects when changing response mode or restarting fresh voice. Bounded conversation text is restored; earlier audio and images are not replayed. Wait for setup before speaking. Fresh turns use local voice detection.";
  }
  async enableResponseControl() {
    await this.configureResponseControl(true);
  }
  async disableResponseControl() {
    await this.configureResponseControl(false);
  }
  async restartResponseControl() {
    await this.configureResponseControl(true, true);
  }
  private async configureResponseControl(controlled: boolean, force = false) {
    if (this.controlled === controlled && !force) return;
    const muted = this.snapshot.microphone === "Muted";
    const history = this.getConversationHistory();
    this.disconnect();
    this.setConversationHistory(history);
    this.controlled = controlled;
    await this.connect();
    if (this.snapshot.connection !== "Connected")
      throw new VoiceError("Controlled Gemini connection failed. Restart AI.");
    if (muted) this.setMuted(true);
  }
  requestTurnResponse(turnId: string, freshness: Freshness) {
    const attempt = this.attempt;
    if (
      !attempt ||
      !this.controlled ||
      !attempt.activityOpen ||
      attempt.recoveryRequired
    )
      throw new VoiceError("No completed voice activity to release.");
    if (
      ["FRESH", "STALE", "HISTORICAL", "UNAVAILABLE"].includes(freshness) &&
      attempt.visualTurnId !== turnId
    )
      throw new VoiceError(
        "No visual context was submitted for this voice turn.",
      );
    const meaning =
      freshness === "FRESH"
        ? "Locally selected visual evidence for this completed voice turn was submitted. Respect its temporal roles; historical evidence is not Current."
        : freshness === "FAILED"
          ? "Fresh visual synchronization FAILED. Earlier screenshots are stale; do not claim to see the current screen."
          : "No mandatory fresh snapshot for this turn. Earlier images may be stale.";
    // The image is already submitted. Do not add another user text prompt on
    // successful turns: activityEnd is the single response trigger.
    if (freshness === "FAILED")
      this.send(attempt, {
        realtimeInput: {
          text: `Visual status for ${turnId}: ${meaning} Answer the user's spoken question aloud.`,
        },
      });
    this.send(attempt, { realtimeInput: { activityEnd: {} } });
    attempt.activityOpen = false;
    attempt.responseStarted = false;
    attempt.audioStarted = false;
    attempt.outputAllowed = true;
    attempt.waitingForInput = false;
    attempt.firstServerEvent = false;
    attempt.firstContent = false;
    attempt.diagnostics.data.turn = turnId;
    attempt.diagnostics.data.responseRequestedAt = this.environment.now();
    attempt.diagnostics.count("activityEnds");
    this.trace(attempt, "response_requested");
    this.watchResponse(attempt);
    this.log(
      ["FRESH", "STALE", "HISTORICAL", "UNAVAILABLE"].includes(freshness)
        ? "Controlled response released after local visual context submission"
        : "Controlled voice-only response released",
    );
  }
  finishVoiceTurn() {
    this.attempt?.detector?.finish();
  }
  private snapshot: VoiceSnapshot;
  private listeners = new Set<() => void>();
  private attempt: Attempt | null = null;
  private toolHandler: ToolHandler | null = null;
  private toolCalls = new Map<string, AbortController>();
  private toolTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private answeredTools = new Set<string>();
  private seenToolCalls = new Set<string>();
  setToolHandler(handler: ToolHandler | null) {
    this.toolHandler = handler;
  }
  constructor(
    private config: SessionConfig,
    private credentials: CredentialService,
    private environment = browserEnvironment,
  ) {
    this.snapshot = this.initial();
  }
  private initial(): VoiceSnapshot {
    return {
      ...initialVoiceSnapshot(),
      provider: "Google Gemini Live",
      model: this.config.model,
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: VoiceSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((fn) => fn());
  }
  private log(message: string) {
    this.publish(appendEvent(this.snapshot, message, this.environment.now()));
  }
  private trace(attempt: Attempt, event?: TraceEvent, details?: TraceDetails) {
    if (this.attempt !== attempt) return;
    if (event) attempt.diagnostics.event(event, details);
    const data = attempt.diagnostics.data;
    data.gate = attempt.recoveryRequired
      ? "RECOVERY_REQUIRED"
      : attempt.suppressGeneration
        ? "DISCARDING"
        : attempt.outputAllowed
          ? "OPEN"
          : "HELD";
    data.pendingTools = this.toolCalls.size;
    data.socketBufferedBytes = attempt.socket?.bufferedAmount ?? 0;
    data.audioContext = attempt.audio?.outputState?.() ?? "unavailable";
    this.publish({
      ...this.snapshot,
      diagnostics: attempt.diagnostics.snapshot(),
    });
  }
  private scheduleTrace(attempt: Attempt) {
    if (attempt.diagnosticTimer) return;
    attempt.diagnosticTimer = setTimeout(() => {
      attempt.diagnosticTimer = undefined;
      this.trace(attempt);
    }, 1000);
  }
  private watchResponse(attempt: Attempt) {
    clearTimeout(attempt.responseTimer);
    const baseline = { ...attempt.diagnostics.data.counters };
    attempt.responseTimer = setTimeout(() => {
      if (this.attempt !== attempt || attempt.audioStarted) return;
      const counts = attempt.diagnostics.data.counters;
      const issue: Issue = this.toolCalls.size
        ? "TOOL_STALLED"
        : counts.audioDropped > baseline.audioDropped
          ? "OUTPUT_SUPPRESSED"
          : attempt.waitingForInput
            ? "PROVIDER_WAITING_FOR_INPUT"
            : counts.serverMessages === baseline.serverMessages
              ? "NO_PROVIDER_EVENTS"
              : "NO_AUDIO_RESPONSE";
      attempt.recoveryRequired = true;
      attempt.outputAllowed = false;
      attempt.audio?.interrupt();
      this.cancelTools();
      attempt.diagnostics.data.issue = issue;
      const message = `Gemini response timed out (${issue}). Restart fresh voice, wait for setup, then repeat your question.`;
      this.publish({
        ...this.snapshot,
        notice: message,
        conversation: "Listening",
      });
      this.trace(attempt, "response_timeout");
      this.turnHandler?.({ type: "response_failed", message });
    }, 15000);
  }
  private cancelTools() {
    for (const abort of this.toolCalls.values()) abort.abort();
    for (const timer of this.toolTimers.values()) clearTimeout(timer);
    this.toolCalls.clear();
    this.toolTimers.clear();
  }
  async connect(testOnly = false) {
    if (this.attempt) return;
    let resolve = () => {};
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const attempt: Attempt = {
      abort: new AbortController(),
      resolve,
      started: this.environment.now(),
      turn: 0,
      generating: false,
      outputAllowed: !this.controlled,
      visualKinds: new Set(),
      answeredInTurn: 0,
      diagnostics: new LiveDiagnostics(
        ++this.connectionSequence,
        this.controlled,
        this.environment.now,
      ),
    };
    this.attempt = attempt;
    this.publish({ ...this.initial(), connection: "Connecting" });
    attempt.timer = setTimeout(
      () =>
        this.fail(
          attempt,
          new VoiceError(
            "Voice connection timed out. Check permissions and network.",
          ),
        ),
      60_000,
    );
    // Run initialization separately so Stop/timeout settles connect even during an OS permission prompt.
    void this.initialize(attempt, testOnly).catch((error) =>
      this.fail(attempt, error),
    );
    await completed;
  }
  private async initialize(attempt: Attempt, testOnly: boolean) {
    if (!testOnly) {
      const audio = this.environment.audio((playing) => {
        if (
          this.attempt !== attempt ||
          this.snapshot.connection !== "Connected"
        )
          return;
        this.publish({
          ...this.snapshot,
          conversation: playing
            ? "AI Speaking"
            : attempt.generating
              ? "AI Thinking"
              : "Listening",
        });
      });
      attempt.audio = audio;
      if (this.controlled)
        attempt.detector = new PcmTurnDetector(
          (onset) => {
            if (this.attempt !== attempt) return;
            if (attempt.outputAllowed)
              this.trace(attempt, "response_cancelled");
            clearTimeout(attempt.responseTimer);
            this.cancelTools();
            attempt.userTurn = `gemini_voice_${++this.turnSequence}`;
            this.beginHistoryTurn(attempt);
            (attempt.transcript ??= new FinalTranscript()).begin(
              attempt.userTurn,
            );
            attempt.visualKinds.clear();
            attempt.answeredInTurn = 0;
            attempt.continuationCall = undefined;
            attempt.outputAllowed = false;
            attempt.responseStarted = false;
            attempt.audioStarted = false;
            attempt.visualTurnId = undefined;
            attempt.audio?.interrupt();
            attempt.generating = false;
            attempt.diagnostics.data.turn = attempt.userTurn;
            attempt.diagnostics.data.userTurn = attempt.userTurn;
            attempt.diagnostics.data.responseRequestedAt = null;
            attempt.diagnostics.data.voiceOnset = {
              rms: onset.rms,
              threshold: onset.threshold,
              sustainedMs: onset.sustainedMs,
              interrupting: onset.interrupting,
            };
            this.turnHandler?.({
              type: "speech_started",
              key: attempt.userTurn,
            });
            // Speech resuming during a held barrier continues the open provider activity.
            // Never send activityEnd for the superseded local turn, or duplicate activityStart.
            if (!attempt.activityOpen) {
              this.send(attempt, { realtimeInput: { activityStart: {} } });
              attempt.diagnostics.count("activityStarts");
            }
            attempt.activityOpen = true;
            this.publish({ ...this.snapshot, conversation: "User Speaking" });
            this.log(
              `Local voice activity started: ${onset.interrupting ? "interruption" : "idle"}, ${onset.sustainedMs} ms, level ${onset.rms.toFixed(4)}, threshold ${onset.threshold.toFixed(4)}`,
            );
            this.trace(attempt, "speech_started");
          },
          (data, rate) => {
            this.send(attempt, {
              realtimeInput: {
                audio: { data, mimeType: `audio/pcm;rate=${rate}` },
              },
            });
            attempt.diagnostics.count("audioSent");
          },
          () => {
            if (this.attempt === attempt) {
              this.publish({ ...this.snapshot, conversation: "AI Thinking" });
              this.log(
                "Local voice activity completed; waiting for visual synchronization",
              );
              this.turnHandler?.({
                type: "turn_completed",
                key: attempt.userTurn,
              });
              this.trace(attempt, "speech_completed");
            }
          },
          () =>
            !!(
              attempt.userTurn &&
              (attempt.activityOpen ||
                attempt.outputAllowed ||
                attempt.generating ||
                this.snapshot.conversation === "AI Speaking")
            ),
          (completedMonotonicAt) => {
            if (this.attempt !== attempt) return;
            if (completedMonotonicAt !== null)
              this.trace(attempt, "reservation_requested");
            attempt.diagnostics.event(
              completedMonotonicAt === null
                ? "speech_resumed"
                : "speech_endpoint",
              {},
              completedMonotonicAt ?? performance.now(),
            );
            this.turnHandler?.({
              type:
                completedMonotonicAt === null
                  ? "speech_resumed"
                  : "speech_boundary",
              key: attempt.userTurn,
              completedMonotonicAt: completedMonotonicAt ?? undefined,
            });
          },
        );
      if (!this.controlled)
        attempt.passiveDetector = new PcmTurnDetector(
          () => {
            if (this.attempt !== attempt) return;
            attempt.userTurn = `gemini_voice_${++this.turnSequence}`;
            this.beginHistoryTurn(attempt);
            (attempt.transcript ??= new FinalTranscript()).begin(
              attempt.userTurn,
            );
            attempt.visualKinds.clear();
            attempt.answeredInTurn = 0;
            this.turnHandler?.({
              type: "speech_started",
              key: attempt.userTurn,
            });
          },
          () => {},
          () => {
            if (this.attempt === attempt)
              this.turnHandler?.({
                type: "turn_completed",
                key: attempt.userTurn,
              });
          },
        );
      await audio.start(
        (data, rate) => {
          if (
            this.attempt !== attempt ||
            this.snapshot.connection !== "Connected"
          )
            return;
          attempt.diagnostics.count("microphoneChunks");
          this.scheduleTrace(attempt);
          if (attempt.recoveryRequired) return;
          try {
            if (attempt.detector) {
              attempt.detector.push(data, rate);
              return;
            }
            // Observe turn identity for on-demand Current/Recent while provider
            // automatic VAD continues to control audio and response timing.
            attempt.passiveDetector?.push(data, rate);
            this.send(attempt, {
              realtimeInput: {
                audio: { data, mimeType: `audio/pcm;rate=${rate}` },
              },
            });
            attempt.diagnostics.count("audioSent");
          } catch (error) {
            this.fail(attempt, error);
          }
        },
        () =>
          this.fail(
            attempt,
            new VoiceError(
              "Microphone disconnected or audio processing failed.",
            ),
          ),
      );
      if (this.attempt !== attempt) return;
      this.publish({ ...this.snapshot, microphone: "Active" });
    }
    const credential = await this.credentials.issue(
      this.config,
      attempt.abort.signal,
    );
    if (this.attempt !== attempt) return;
    if (credential.kind !== "ephemeral")
      throw new VoiceError("This transport requires an ephemeral credential.");
    const socket = this.environment.socket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(credential.value)}`,
    );
    attempt.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.attempt !== attempt) return;
      try {
        this.send(attempt, {
          setup: {
            model: `models/${this.config.model}`,
            ...(this.controlled
              ? {
                  realtimeInputConfig: {
                    automaticActivityDetection: { disabled: true },
                    activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
                    turnCoverage: "TURN_INCLUDES_ALL_INPUT",
                  },
                }
              : {}),
            generationConfig: {
              responseModalities: ["AUDIO"],
              mediaResolution: "MEDIA_RESOLUTION_HIGH",
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: this.config.voice },
                },
              },
            },
            systemInstruction: { parts: [{ text: catalog.instructions }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [],
          },
        });
        this.trace(attempt, "setup_sent");
      } catch (error) {
        this.fail(attempt, error);
      }
    };
    socket.onerror = () =>
      this.fail(
        attempt,
        new VoiceError(
          "Gemini connection failed. Check network, key permissions and model access.",
        ),
      );
    socket.onclose = () =>
      this.fail(
        attempt,
        new VoiceError(
          "Gemini session closed. Check quota or session limits, then start again.",
        ),
      );
    socket.onmessage = (event) => {
      if (this.attempt !== attempt) return;
      try {
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        if (text.length > 1_000_000)
          throw new VoiceError(
            "Provider message exceeds the audio buffer limit.",
          );
        this.message(attempt, JSON.parse(text) as ServerMessage);
      } catch (error) {
        this.fail(
          attempt,
          error instanceof VoiceError
            ? error
            : new VoiceError("Invalid Gemini realtime message."),
        );
      }
    };
  }
  private send(attempt: Attempt, message: unknown) {
    const socket = attempt.socket;
    if (!socket || socket.readyState !== 1)
      throw new VoiceError("Realtime connection is not open.");
    attempt.visualAllowance = Math.min(
      attempt.visualAllowance ?? 0,
      socket.bufferedAmount,
    );
    if (socket.bufferedAmount > 128_000 + (attempt.visualAllowance ?? 0))
      throw new VoiceError(
        "Network cannot keep up with microphone audio. Start again.",
      );
    socket.send(JSON.stringify(message));
  }
  private message(attempt: Attempt, event: ServerMessage) {
    attempt.diagnostics.count("serverMessages");
    attempt.diagnostics.data.lastServerEventAt = this.environment.now();
    if (event.error)
      throw new VoiceError(
        "Gemini rejected the session. Check model access, configuration and quota.",
      );
    this.scheduleTrace(attempt);
    // Generation control and playback control are independent. Never play or
    // display an unsolicited/premature reply while the visual barrier is held.
    // Only actual output arms suppression. Empty/thought-only modelTurn packets
    // are not audio and must not lock out the later spoken response.
    const content = event.serverContent;
    if (
      attempt.outputAllowed &&
      attempt.diagnostics.data.responseRequestedAt !== null &&
      !attempt.firstServerEvent
    ) {
      attempt.firstServerEvent = true;
      this.trace(attempt, "first_server_event");
    }
    const modelContent = !!(
      content?.modelTurn?.parts?.length || content?.outputTranscription?.text
    );
    if (attempt.outputAllowed && modelContent && !attempt.firstContent) {
      attempt.firstContent = true;
      this.trace(attempt, "first_content");
    }
    if (
      attempt.outputAllowed &&
      attempt.continuationCall &&
      (modelContent ||
        event.toolCall?.functionCalls?.length ||
        content?.turnComplete)
    ) {
      this.trace(attempt, "model_continuation", {
        callId: attempt.continuationCall,
      });
      attempt.continuationCall = undefined;
    }
    const incomingAudio =
      content?.modelTurn?.parts?.filter((p) =>
        p.inlineData?.mimeType?.startsWith("audio/"),
      ).length ?? 0;
    attempt.diagnostics.count("audioReceived", incomingAudio);
    if (incomingAudio && !attempt.audioStarted)
      this.trace(attempt, "audio_received");
    if (content?.inputTranscription?.text)
      attempt.diagnostics.count("inputTranscriptions");
    if (content?.outputTranscription?.text)
      attempt.diagnostics.count("outputTranscriptions");
    if (content?.generationComplete) this.trace(attempt, "generation_complete");
    if (content?.turnComplete) this.trace(attempt, "turn_complete");
    if (content?.interrupted) {
      attempt.diagnostics.count("interruptions");
      this.trace(attempt, "interrupted");
    }
    if (content?.waitingForInput) {
      attempt.waitingForInput = true;
      this.trace(attempt, "waiting_for_input");
    }
    const hasSpokenOutput = !!(
      content?.modelTurn?.parts?.some((part) =>
        part.inlineData?.mimeType?.startsWith("audio/"),
      ) || content?.outputTranscription?.text
    );
    const hasOutput =
      hasSpokenOutput || !!event.toolCall?.functionCalls?.length;
    if (
      this.controlled &&
      !attempt.outputAllowed &&
      attempt.activityOpen &&
      hasSpokenOutput &&
      !attempt.suppressGeneration
    ) {
      attempt.suppressGeneration = true;
      this.log("Premature provider output discarded while response is held");
    }
    const discardOutput =
      this.controlled &&
      (!attempt.outputAllowed || !!attempt.suppressGeneration);
    // generationComplete/interrupted terminate generation before turnComplete,
    // which may be delayed for playback. Consume that old lifecycle marker
    // without closing the newly released turn's output gate.
    if (
      attempt.suppressGeneration &&
      (content?.generationComplete ||
        content?.interrupted ||
        content?.turnComplete)
    ) {
      attempt.suppressGeneration = false;
      attempt.retiredTurnCompletion = !content.turnComplete;
      this.log(
        "Discarded response generation ended; fresh response gate preserved",
      );
    }
    const retiredCompletion =
      this.controlled &&
      !!content?.turnComplete &&
      !!attempt.retiredTurnCompletion;
    if (retiredCompletion) attempt.retiredTurnCompletion = false;
    if (discardOutput) {
      attempt.diagnostics.count("audioDropped", incomingAudio);
      if (incomingAudio) this.trace(attempt, "audio_dropped");
      for (const call of event.toolCall?.functionCalls ?? []) {
        if (typeof call.id === "string" && typeof call.name === "string")
          this.send(attempt, {
            toolResponse: {
              functionResponses: [
                {
                  id: call.id,
                  name: call.name,
                  response: {
                    success: false,
                    status: "cancelled",
                    message:
                      "Response is held for the current user turn. No image supplied by this tool.",
                  },
                },
              ],
            },
          });
      }
      if (event.serverContent?.turnComplete) {
        ++attempt.turn;
      }
      event = {
        ...event,
        toolCall: undefined,
        serverContent: event.serverContent
          ? { inputTranscription: event.serverContent.inputTranscription }
          : undefined,
      };
    } else if (retiredCompletion) {
      event = {
        ...event,
        serverContent: { ...content, turnComplete: false, interrupted: false },
      };
    }
    for (const id of event.toolCallCancellation?.ids ?? []) {
      this.toolCalls.get(id)?.abort();
      this.toolCalls.delete(id);
      clearTimeout(this.toolTimers.get(id));
      this.toolTimers.delete(id);
    }
    for (const item of event.toolCall?.functionCalls ?? []) {
      if (
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        this.seenToolCalls.has(item.id)
      )
        continue;
      if (this.seenToolCalls.size >= 256)
        this.seenToolCalls.delete(this.seenToolCalls.values().next().value!);
      this.seenToolCalls.add(item.id);
      const abort = new AbortController();
      this.toolCalls.set(item.id, abort);
      attempt.diagnostics.count("toolCalls");
      const intent = inspectionRequest(item.args)?.mode;
      if (
        ["recent", "recent_exact", "compare_recent_current"].includes(
          intent ?? "",
        )
      )
        attempt.diagnostics.count("recentToolRequests");
      if (["recent_exact", "follow_up_exact"].includes(intent ?? ""))
        attempt.diagnostics.count("historicalDetailRequests");
      if (attempt.answeredInTurn)
        attempt.diagnostics.count("multiToolContinuations");
      this.trace(attempt, "tool_call", {
        callId: item.id,
        intent,
      });
      const call: ToolCall = {
        id: item.id,
        name: item.name,
        arguments: item.args,
        signal: abort.signal,
      };
      const missingResult = (timedOut: boolean) => {
        if (
          this.attempt !== attempt ||
          abort.signal.aborted ||
          this.answeredTools.has(call.id)
        )
          return;
        if (timedOut) {
          attempt.diagnostics.count("toolTimeouts");
          this.trace(attempt, "tool_timeout");
        }
        this.sendToolResult(call, {
          status: "capture_failed",
          success: false,
          message: timedOut
            ? "Visual tool timed out; no image supplied. Do not retry this tool in a loop."
            : "Visual tool unavailable; no image supplied.",
        });
        abort.abort();
        this.toolCalls.delete(call.id);
        this.trace(attempt);
      };
      this.toolTimers.set(
        call.id,
        setTimeout(() => {
          try {
            missingResult(true);
          } catch (error) {
            this.fail(attempt, error);
          }
        }, 6000),
      );
      void (async () => {
        await this.toolHandler?.(call);
      })()
        .then(
          () => missingResult(false),
          () => missingResult(false),
        )
        .catch((error) => this.fail(attempt, error))
        .finally(() => {
          if (this.attempt !== attempt || this.toolCalls.get(call.id) !== abort)
            return;
          clearTimeout(this.toolTimers.get(call.id));
          this.toolTimers.delete(call.id);
          this.toolCalls.delete(call.id);
          this.trace(attempt);
        });
    }
    if (event.error)
      throw new VoiceError(
        "Gemini rejected the session. Check model access, configuration and quota.",
      );
    if (event.goAway)
      throw new VoiceError(
        "Gemini session is nearing its time limit. Stop and start a new session.",
      );
    if (event.setupComplete && this.snapshot.connection !== "Connected") {
      clearTimeout(attempt.timer);
      const history = this.history.get();
      if (history.length)
        this.send(attempt, {
          clientContent: {
            turns: history.map((message) => ({
              role: message.role === "assistant" ? "model" : "user",
              parts: [{ text: message.text }],
            })),
            turnComplete: false,
          },
        });
      const now = this.environment.now();
      this.publish({
        ...this.snapshot,
        connection: "Connected",
        conversation: "Listening",
        connectedAt: now,
        metrics: {
          ...this.snapshot.metrics,
          connectionMs: now - attempt.started,
        },
      });
      this.log("Session connected");
      this.trace(attempt, "setup_complete");
      attempt.resolve();
    }
    if (!discardOutput && hasOutput) {
      attempt.responseStarted = true;
      this.turnHandler?.({ type: "response_started" });
    }
    const acceptedContent = event.serverContent;
    if (!acceptedContent) return;
    this.serverContent(attempt, acceptedContent);
  }
  private serverContent(
    attempt: Attempt,
    content: NonNullable<ServerMessage["serverContent"]>,
  ) {
    if (this.snapshot.connection !== "Connected")
      throw new VoiceError("Received audio before session setup.");
    if (content.inputTranscription) {
      // Server VAD can recognize a quiet utterance the local observer missed.
      // Finalize that text under a local identity without synthesizing speech
      // boundaries or replacing an unfinished, potentially late transcript.
      if (
        content.inputTranscription.text &&
        (!attempt.userTurn ||
          (attempt.historyInputFinished && attempt.historyTurnComplete))
      ) {
        attempt.userTurn = `gemini_voice_${++this.turnSequence}`;
        this.beginHistoryTurn(attempt);
        (attempt.transcript ??= new FinalTranscript()).begin(attempt.userTurn);
      }
      const final = attempt.transcript?.push(content.inputTranscription);
      if (content.inputTranscription.finished)
        attempt.historyInputFinished = true;
      if (final) {
        this.history.user(final.key, final.text);
        this.turnHandler?.({
          type: "transcript_final",
          key: final.key,
          transcript: final.text,
        });
      }
    }
    if (content.interrupted) {
      attempt.historyRetiring = false;
      attempt.historyOutput = "";
      attempt.historyOutputTurn = undefined;
      attempt.discardAudio = false;
      attempt.generating = false;
      attempt.audio?.interrupt();
      this.publish({
        ...this.snapshot,
        transcripts: this.snapshot.transcripts.filter(
          (t) => t.id !== `AI:${attempt.turn}`,
        ),
        conversation: "Listening",
      });
      this.log("Assistant interrupted");
      attempt.turn++;
    }
    for (const [role, transcription] of [
      ["YOU", content.inputTranscription],
      ["AI", content.outputTranscription],
    ] as const) {
      if (typeof transcription?.text !== "string") continue;
      if (
        role === "AI" &&
        (attempt.discardAudio ||
          (attempt.actionTurn === attempt.userTurn && !!attempt.actionTurn))
      )
        continue;
      if (
        role === "AI" &&
        !content.interrupted &&
        !attempt.historyRetiring &&
        attempt.userTurn &&
        !attempt.historyOutputOverflow
      ) {
        attempt.historyOutputTurn ??= attempt.userTurn;
        const text = (attempt.historyOutput ?? "") + transcription.text;
        if (text.length > historyLimits.characters) {
          attempt.historyOutputOverflow = true;
          attempt.historyOutput = "";
        } else attempt.historyOutput = text;
      }
      const id = `${role}:${attempt.turn}`;
      const previous = this.snapshot.transcripts.find((t) => t.id === id);
      const entry = {
        id,
        role,
        text: ((previous?.text ?? "") + transcription.text).slice(-8000),
      };
      this.publish({
        ...this.snapshot,
        transcripts: [
          ...this.snapshot.transcripts.filter((t) => t.id !== id),
          entry,
        ].slice(-40),
      });
    }
    let played = false;
    for (const part of content.modelTurn?.parts ?? []) {
      const audio = part.inlineData;
      if (!audio) continue;
      if (
        attempt.discardAudio ||
        (attempt.actionTurn === attempt.userTurn && !!attempt.actionTurn)
      ) {
        attempt.diagnostics.count("audioDropped");
        continue;
      }
      if (
        typeof audio.data !== "string" ||
        !/^audio\/pcm(?:;rate=24000)?$/.test(audio.mimeType ?? "")
      )
        throw new VoiceError("Unsupported provider audio format.");
      attempt.generating = true;
      try {
        if (!attempt.audio)
          throw new VoiceError("Audio output is unavailable.");
        attempt.audio.play(audio.data, 24000);
        played = true;
        attempt.diagnostics.count("audioScheduled");
        clearTimeout(attempt.responseTimer);
        if (this.controlled && !attempt.audioStarted) {
          attempt.audioStarted = true;
          this.log("First controlled response audio accepted");
          this.trace(attempt, "audio_scheduled");
        }
        if (this.snapshot.notice)
          this.publish({ ...this.snapshot, notice: null });
      } catch (error) {
        if (!(error instanceof PlaybackQueueFullError)) {
          attempt.diagnostics.data.issue = "PLAYBACK_FAILED";
          this.trace(attempt);
          throw error;
        }
        attempt.diagnostics.count("audioDropped");
        // Drop this response through turnComplete, rather than replaying its tail
        // or closing the microphone/socket. The next turn starts with a clean queue.
        attempt.discardAudio = true;
        attempt.generating = false;
        attempt.audio?.interrupt();
        const notice =
          "Audio playback fell too far behind, so this reply was stopped. The session is still connected; please ask for a shorter reply.";
        this.publish({
          ...this.snapshot,
          notice,
          conversation: "Listening",
          transcripts: this.snapshot.transcripts.filter(
            (t) => t.id !== `AI:${attempt.turn}`,
          ),
        });
        this.log(notice);
      }
    }
    if (played) this.turnHandler?.({ type: "first_audio" });
    if (content.turnComplete) {
      // A delayed completion for an earlier turn must not close the gate before
      // any output from the released turn has arrived.
      if (this.controlled && !attempt.responseStarted) return;
      attempt.historyTurnComplete = true;
      if (
        !attempt.discardAudio &&
        !content.interrupted &&
        attempt.historyOutputTurn === attempt.userTurn &&
        attempt.userTurn &&
        attempt.historyOutput
      ) {
        this.history.assistant(
          attempt.userTurn,
          `response:${attempt.turn}`,
          attempt.historyOutput,
        );
      }
      attempt.historyOutput = "";
      attempt.historyOutputTurn = undefined;
      attempt.historyRetiring = false;
      if (this.controlled) attempt.outputAllowed = false;
      attempt.responseStarted = false;
      this.turnHandler?.({ type: "response_done" });
      attempt.discardAudio = false;
      attempt.generating = false;
      attempt.turn++;
      if (this.snapshot.conversation !== "AI Speaking")
        this.publish({ ...this.snapshot, conversation: "Listening" });
      this.log("Assistant turn complete");
    }
  }
  setMuted(muted: boolean) {
    const attempt = this.attempt;
    if (!attempt || this.snapshot.connection !== "Connected" || !attempt.audio)
      return;
    attempt.audio.mute(muted);
    try {
      if (muted) {
        if (attempt.detector) attempt.detector.finish();
        else this.send(attempt, { realtimeInput: { audioStreamEnd: true } });
      }
    } catch (error) {
      this.fail(attempt, error);
      return;
    }
    this.publish({ ...this.snapshot, microphone: muted ? "Muted" : "Active" });
  }
  maxImageBytes() {
    return visualConfig.maxEncodedBytes;
  }
  async sendVisualContext(
    context: VisualContext,
    signal: AbortSignal,
    call?: ToolCall,
  ): Promise<VisualDelivery> {
    const attempt = this.attempt;
    if (!attempt || signal.aborted || this.snapshot.connection !== "Connected")
      throw new VoiceError("Visual request cancelled.");
    if (context.context && context.frames) {
      // Trace only explicit metadata fields; never spread an image-owning context.
      const details: TraceDetails = {
        callId: call?.id,
        requestId: context.context.requestId,
        kind: context.context.kind,
        intent: context.inspection?.intent,
        status: context.context.completeness,
        frames: context.frames.map((f) => ({
          snapshotId: f.snapshotId,
          role: f.role,
          origin: f.origin,
          width: f.width,
          height: f.height,
          encodedSizeBytes: f.encodedSizeBytes,
        })),
        timings: context.context.timings,
      };
      attempt.diagnostics.data.turn = context.context.turnId;
      if (context.preparation) {
        attempt.diagnostics.event(
          "visual_context_requested",
          details,
          context.preparation.requestedAt,
        );
        attempt.diagnostics.event(
          "visual_preparation_started",
          details,
          context.preparation.startedAt,
        );
        attempt.diagnostics.event(
          "visual_ready",
          details,
          context.preparation.readyAt,
        );
      }
      if (
        context.frames.length > 4 ||
        context.frames.some((f) => f.encodedSizeBytes > this.maxImageBytes()) ||
        (attempt.socket?.bufferedAmount ?? 0) > 128_000
      )
        throw new VoiceError("Visual context exceeds the connection limit.");
      await context.validate?.();
      if (
        this.attempt !== attempt ||
        signal.aborted ||
        this.snapshot.connection !== "Connected"
      )
        throw new VoiceError("Visual request cancelled.");
      this.trace(attempt, "submission_started", details);
      if (call) {
        if (call.signal.aborted || this.answeredTools.has(call.id))
          throw new VoiceError("Visual tool request cancelled.");
        const intent = inspectionRequest(call.arguments)?.mode;
        if (
          call.name !== visualConfig.tool.name ||
          !context.inspection ||
          intent !== context.inspection.intent
        ) {
          attempt.diagnostics.count("toolCorrelationFailures");
          this.trace(attempt);
          throw new VoiceError(
            "Visual context does not match the tool request.",
          );
        }
        this.send(attempt, {
          toolResponse: {
            functionResponses: [
              {
                id: call.id,
                name: call.name,
                response: {
                  status: context.inspection!.status,
                  success: context.inspection!.status === "Complete",
                  inspection: context.inspection,
                  images: context.frames.map((frame, index) => ({
                    snapshotId: frame.snapshotId,
                    temporalRole: context.inspection!.snapshots.find(
                      (f) => f.snapshotId === frame.snapshotId,
                    )?.temporalRole,
                    image: { $ref: `visual-${index}` },
                  })),
                  message:
                    "Requested visual evidence is ready. Exact images inspect the selected original visual moment. Respect explicit temporal roles, reused images, partial or ambiguous results. State when requested evidence is unavailable; do not invent missing text.",
                },
                parts: context.frames.map((frame, index) => ({
                  inlineData: {
                    data: frame.base64,
                    mimeType: frame.mimeType,
                    displayName: `visual-${index}`,
                  },
                })),
              },
            ],
          },
        });
        this.markToolAnswered(attempt, call.id);
      } else {
        // Still images use ordered content, retaining image resolution rather
        // than the video-frame token budget. The held audio activity is ended
        // only by requestTurnResponse after this message has drained.
        this.send(attempt, {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  { text: contextText(context) },
                  ...context.frames.flatMap((frame) => [
                    {
                      text: `Snapshot ${frame.snapshotId}; ${frame.role}; offset ${frame.offsetMs} ms from user turn completion.`,
                    },
                    {
                      inlineData: {
                        data: frame.base64,
                        mimeType: frame.mimeType,
                      },
                    },
                  ]),
                ],
              },
            ],
            turnComplete: false,
          },
        });
      }
      for (const _ of context.frames) attempt.diagnostics.count("imagesSent");
      const combinedBefore =
        attempt.visualKinds.has("current") && attempt.visualKinds.has("recent");
      attempt.visualKinds.add(context.context.kind);
      if (
        !combinedBefore &&
        attempt.visualKinds.has("current") &&
        attempt.visualKinds.has("recent")
      )
        attempt.diagnostics.count("combinedVisualTurns");
      if (context.context.kind === "recent") {
        attempt.diagnostics.count("recentToolResults");
        attempt.diagnostics.count(
          context.frames.length ? "recentImageResults" : "recentEmptyResults",
        );
      }
      noteVisualEnqueue(
        "gemini",
        context,
        context.frames.length,
        context.frames.reduce((sum, frame) => sum + frame.encodedSizeBytes, 0),
      );
      attempt.visualAllowance = attempt.socket?.bufferedAmount ?? 0;
      this.trace(attempt, "image_queued");
      await waitForDrain(
        attempt.socket!,
        signal,
        () =>
          this.attempt === attempt && this.snapshot.connection === "Connected",
      );
      attempt.visualAllowance = 0;
      this.trace(attempt, "image_drained", details);
      if (context.visual?.source === "TURN_SYNCHRONIZED")
        attempt.visualTurnId = context.visual.turnId;
      return {
        sent: true,
        acknowledgment:
          "Local transport drained; Gemini provides no per-frame acknowledgment",
      };
    }
    if (
      (attempt.socket?.bufferedAmount ?? 0) > 128_000 ||
      context.metadata.encodedSizeBytes > this.maxImageBytes()
    )
      throw new VoiceError("Visual connection is busy or image is too large.");
    this.send(attempt, {
      realtimeInput: {
        video: { data: context.base64, mimeType: context.mimeType },
      },
    });
    attempt.diagnostics.count("imagesSent");
    attempt.visualAllowance = attempt.socket?.bufferedAmount ?? 0;
    this.trace(attempt, "image_queued");
    await waitForDrain(
      attempt.socket!,
      signal,
      () =>
        this.attempt === attempt && this.snapshot.connection === "Connected",
    );
    this.trace(attempt, "image_drained");
    attempt.visualAllowance = 0;
    if (context.visual?.source === "TURN_SYNCHRONIZED")
      attempt.visualTurnId = context.visual.turnId;
    return {
      sent: true,
      acknowledgment:
        "Local transport drained; Gemini provides no per-frame acknowledgment",
    };
  }
  sendToolResult(call: ToolCall, result: ToolResult) {
    if (!this.attempt || call.signal.aborted || this.answeredTools.has(call.id))
      return;
    if (result.status === "visual_limit_reached")
      this.attempt.diagnostics.count("toolLimitRejections");
    this.send(this.attempt, {
      toolResponse: {
        functionResponses: [{ id: call.id, name: call.name, response: result }],
      },
    });
    this.markToolAnswered(this.attempt, call.id);
  }
  private markToolAnswered(attempt: Attempt, id: string) {
    attempt.answeredInTurn++;
    if (this.answeredTools.size >= 256)
      this.answeredTools.delete(this.answeredTools.values().next().value!);
    this.answeredTools.add(id);
    clearTimeout(this.toolTimers.get(id));
    this.toolTimers.delete(id);
    attempt.diagnostics.count("toolResults");
    attempt.continuationCall = id;
    this.trace(attempt, "tool_result", { callId: id });
  }
  disconnect() {
    this.cleanup();
    this.history.set([]);
    this.controlled = false;
    this.publish(this.initial());
  }
  private fail(attempt: Attempt, error: unknown) {
    if (this.attempt !== attempt) return;
    const message = safeError(error);
    attempt.diagnostics.data.issue ??= "CONNECTION_FAILED";
    this.trace(attempt, "connection_error");
    const diagnostics = this.snapshot.diagnostics;
    this.cleanup();
    this.publish({ ...this.initial(), error: message, diagnostics });
    this.log(message);
  }
  private cleanup() {
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt) return;
    attempt.abort.abort();
    this.cancelTools();
    this.answeredTools.clear();
    this.seenToolCalls.clear();
    clearTimeout(attempt.timer);
    clearTimeout(attempt.responseTimer);
    clearTimeout(attempt.diagnosticTimer);
    attempt.audio?.close();
    if (attempt.socket) {
      const socket = attempt.socket;
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
    attempt.resolve();
  }
}
interface ServerMessage {
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  toolCall?: {
    functionCalls?: { id?: string; name?: string; args?: unknown }[];
  };
  toolCallCancellation?: { ids?: string[] };
  setupComplete?: object;
  error?: object;
  goAway?: object;
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    generationComplete?: boolean;
    waitingForInput?: boolean;
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string };
    modelTurn?: {
      parts?: { inlineData?: { data?: string; mimeType?: string } }[];
    };
  };
}
