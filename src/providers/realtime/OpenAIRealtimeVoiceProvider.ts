import type { TurnEvent, Freshness } from "./turns/TurnCoordinator.js";
import { observeSpeechBoundary } from "./turns/SpeechBoundaryObserver.js";
import catalog from "./catalog.json" with { type: "json" };
import { voiceConfig } from "./config.js";
import { NativeConversationHistory } from "./universal/ConversationHistory.js";
import type { ConversationMessage } from "./universal/types.js";
import { contextText } from "./visual/TemporalContext.js";
import { noteVisualEnqueue } from "./visual/DeliveryCounters.js";
import type {
  ToolHandler,
  ToolCall,
  ToolResult,
  VisualContext,
  VisualDelivery,
} from "./visual/types.js";
import { microphoneError, safeError, VoiceError } from "./errors.js";
import { exchangeOffer, getCredential } from "./handshake.js";
import {
  appendEvent,
  initialVoiceSnapshot,
  VoiceEvents,
} from "./VoiceEvents.js";
import type {
  RealtimeVoiceProvider,
  VoiceSnapshot,
} from "./RealtimeVoiceProvider.js";

export interface VoiceEnvironment {
  fetch: typeof fetch;
  createPeer: () => RTCPeerConnection;
  createAudio: () => HTMLAudioElement;
  getMicrophone: () => Promise<MediaStream>;
  now: () => number;
  observeBoundary?: typeof observeSpeechBoundary;
}

const browserEnvironment: VoiceEnvironment = {
  fetch: (...args) => fetch(...args),
  createPeer: () => new RTCPeerConnection(),
  createAudio: () => new Audio(),
  getMicrophone: () => {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new VoiceError(
        "Microphone access is unavailable in this WebView. Update WebView2 and check Windows microphone settings.",
      );
    return navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  },
  now: () => Date.now(),
  observeBoundary: observeSpeechBoundary,
};

interface Attempt {
  abort: AbortController;
  startedAt: number;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  microphone?: MediaStream;
  audio?: HTMLAudioElement;
  timeout?: ReturnType<typeof setTimeout>;
  sessionReady: boolean;
  events: VoiceEvents;
  resolve: () => void;
  toolCalls: Set<string>;
  responseActive: boolean;
  pendingTools: number;
  continueTools: boolean;
  stopBoundaryObserver?: () => void;
}

export class OpenAIRealtimeVoiceProvider implements RealtimeVoiceProvider {
  private history = new NativeConversationHistory();
  private actionTurn: string | null = null;
  isCurrentUserTurn(turnId: string) {
    return (
      !!this.attempt && (!this.lastAudioItem || this.lastAudioItem === turnId)
    );
  }
  actionHandled(turnId: string, message?: string) {
    if (!this.isCurrentUserTurn(turnId)) return;
    this.actionTurn = turnId;
    this.held = false;
    for (const owner of this.historyResponses.values()) {
      if (owner.turn === turnId)
        for (const id of owner.items) this.history.removeAssistant(id);
    }
    if (this.attempt) this.attempt.continueTools = false;
    // Automatic provider audio may have started before STT finalization. Stop
    // its remaining output; the local confirmation is never sent as a prompt.
    try {
      if (this.attempt?.responseActive)
        this.sendEvent({ type: "response.cancel" });
      this.sendEvent({ type: "output_audio_buffer.clear" });
    } catch {
      /* Local confirmation remains visible if transport has closed. */
    }
    this.publish({
      ...this.snapshot,
      conversation: "Listening",
      notice: message ?? "Review the action request in the app.",
    });
  }
  interrupt() {
    if (this.lastAudioItem) this.actionHandled(this.lastAudioItem, "");
  }
  private actionOutput(raw: Record<string, any>) {
    if (
      !this.actionTurn ||
      this.actionTurn !== this.lastAudioItem ||
      !(
        String(raw.type).startsWith("response.") ||
        String(raw.type).startsWith("output_audio_buffer.")
      )
    )
      return false;
    if (raw.type === "response.created") {
      try {
        this.sendEvent({ type: "response.cancel" });
        this.sendEvent({ type: "output_audio_buffer.clear" });
      } catch {
        /* Connection cleanup handles a closed channel. */
      }
    }
    if (raw.type === "response.done" && this.attempt)
      this.attempt.responseActive = false;
    return true;
  }
  private historyResponses = new Map<
    string,
    { turn: string; epoch: number; items: string[]; done: boolean }
  >();
  getConversationHistory() {
    return this.history.get();
  }
  setConversationHistory(history: ConversationMessage[]) {
    if (this.attempt)
      throw new VoiceError("Stop the active session before changing settings.");
    this.history.set(history);
    this.historyResponses.clear();
  }
  private historyEvent(raw: Record<string, any>) {
    if (
      (raw.type === "input_audio_buffer.speech_started" ||
        raw.type === "input_audio_buffer.committed") &&
      typeof raw.item_id === "string"
    ) {
      this.history.begin(raw.item_id);
    }
    if (
      raw.type === "conversation.item.input_audio_transcription.completed" &&
      typeof raw.item_id === "string" &&
      typeof raw.transcript === "string"
    ) {
      this.history.user(raw.item_id, raw.transcript);
    }
    if (
      raw.type === "response.created" &&
      typeof raw.response?.id === "string" &&
      this.lastAudioItem
    ) {
      this.historyResponses.set(raw.response.id, {
        turn: this.lastAudioItem,
        epoch: this.turnEpoch,
        items: [],
        done: false,
      });
      if (this.historyResponses.size > 24)
        this.historyResponses.delete(
          this.historyResponses.keys().next().value!,
        );
    }
    if (raw.type === "response.done") {
      const response = raw.response;
      const owner = this.historyResponses.get(response?.id);
      if (!owner || owner.done) return;
      owner.done = true;
      if (
        owner.epoch !== this.turnEpoch ||
        response.status !== "completed" ||
        !Array.isArray(response.output)
      )
        return;
      // response.done carries final output text/transcripts; deltas and separate
      // transcript.done notifications never create a second history message.
      for (const item of response.output) {
        if (
          item?.type !== "message" ||
          item.role !== "assistant" ||
          item.status !== "completed" ||
          typeof item.id !== "string" ||
          !Array.isArray(item.content)
        )
          continue;
        const text = item.content
          .map((part: Record<string, unknown>) =>
            part.type === "output_text" && typeof part.text === "string"
              ? part.text
              : part.type === "output_audio" &&
                  typeof part.transcript === "string"
                ? part.transcript
                : "",
          )
          .join("");
        this.history.assistant(owner.turn, item.id, text);
        owner.items.push(item.id);
      }
    }
    if (
      raw.type === "conversation.item.truncated" ||
      raw.type === "conversation.item.deleted"
    ) {
      if (typeof raw.item_id === "string")
        this.history.removeAssistant(raw.item_id);
    }
    if (
      raw.type === "output_audio_buffer.cleared" &&
      typeof raw.response_id === "string"
    ) {
      for (const id of this.historyResponses.get(raw.response_id)?.items ?? [])
        this.history.removeAssistant(id);
    }
  }
  private controlled = false;
  private turnHandler: ((event: TurnEvent) => void) | null = null;
  private held = false;
  private turnEpoch = 0;
  private lastAudioItem: string | null = null;
  private controlAck: ((ok: boolean) => void) | null = null;
  private expectedAutomatic = false;
  private manualCommitKey: string | null = null;
  setTurnHandler(handler: ((event: TurnEvent) => void) | null) {
    this.turnHandler = handler;
  }
  responseControlHint() {
    return "OpenAI changes response timing on the existing connection. Enable between voice turns.";
  }
  async enableResponseControl() {
    await this.configureResponseControl(true);
  }
  async disableResponseControl() {
    await this.configureResponseControl(false);
  }
  private async configureResponseControl(controlled: boolean) {
    if (this.controlled === controlled) return;
    if (!this.attempt || this.snapshot.connection !== "Connected")
      throw new VoiceError("Start AI first.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(false), 5000);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.controlAck = null;
        if (ok) {
          this.controlled = controlled;
          const attempt = this.attempt;
          if (!controlled) {
            this.held = false;
            attempt?.stopBoundaryObserver?.();
            if (attempt) attempt.stopBoundaryObserver = undefined;
          } else if (attempt) this.startBoundaryObserver(attempt);
          resolve();
        } else
          reject(
            new VoiceError(
              "Response control was not acknowledged. Stop and restart AI before retrying.",
            ),
          );
      };
      this.controlAck = done;
      this.expectedAutomatic = !controlled;
      try {
        this.sendEvent({
          type: "session.update",
          event_id: "fresh_control",
          session: {
            type: "realtime",
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  create_response: !controlled,
                  interrupt_response: true,
                },
              },
            },
          },
        });
      } catch {
        done(false);
      }
    });
  }
  private startBoundaryObserver(attempt: Attempt) {
    if (
      !attempt.microphone ||
      !this.environment.observeBoundary ||
      attempt.stopBoundaryObserver
    )
      return;
    const unavailable = () => {
      if (this.attempt !== attempt || !this.controlled) return;
      this.publish({
        ...this.snapshot,
        notice:
          "Local speech timing is unavailable; screen context will use provider turn timing.",
      });
    };
    try {
      attempt.stopBoundaryObserver = this.environment.observeBoundary(
        attempt.microphone,
        (at) => {
          if (
            this.attempt !== attempt ||
            !this.controlled ||
            !this.held ||
            !this.lastAudioItem
          )
            return;
          this.turnHandler?.({
            type: at === null ? "speech_resumed" : "speech_boundary",
            key: this.lastAudioItem,
            completedMonotonicAt: at ?? undefined,
          });
        },
        unavailable,
      );
    } catch {
      // Server completion remains available when the local audio observer cannot start.
      unavailable();
    }
  }
  requestTurnResponse(turnId: string, freshness: Freshness) {
    if (!this.controlled || !this.attempt)
      throw new VoiceError("Response control unavailable.");
    this.held = false;
    const meaning =
      freshness === "FRESH"
        ? "Locally selected visual evidence was supplied for this user turn. Respect the supplied temporal roles; historical evidence is not Current."
        : freshness === "STALE"
          ? "A bounded-age Current snapshot was delivered for this user turn. Respect its stated capture time and stale label."
          : freshness === "HISTORICAL"
            ? "Historical visual evidence was supplied for this user turn. It is not the current desktop. Respect the supplied temporal roles and any missing evidence."
            : freshness === "UNAVAILABLE"
              ? "The requested visual evidence is unavailable. No usable image was supplied for this turn. Explain the limitation without inventing screen contents or requesting another capture."
              : freshness === "FAILED"
                ? "Fresh screen synchronization FAILED for this turn. Earlier images may be stale. Do not claim to see the current desktop; answer without new visual evidence."
                : "No mandatory fresh visual synchronization for this turn. Earlier images may be stale.";
    this.sendEvent({
      type: "response.create",
      event_id: `turn_response_${turnId}`,
      response: { instructions: `${catalog.instructions} ${meaning}` },
    });
  }
  finishVoiceTurn() {
    if (this.controlled && this.held && !this.manualCommitKey) {
      this.manualCommitKey = this.lastAudioItem;
      try {
        this.sendEvent({ type: "input_audio_buffer.commit" });
      } catch (error) {
        this.manualCommitKey = null;
        throw error;
      }
    }
  }
  private turnEvent(raw: Record<string, any>) {
    if (
      raw.type === "conversation.item.input_audio_transcription.completed" &&
      typeof raw.item_id === "string" &&
      typeof raw.transcript === "string"
    ) {
      this.lastAudioItem ??= raw.item_id;
      this.turnHandler?.({
        type: "transcript_final",
        key: raw.item_id,
        transcript: raw.transcript,
      });
    }
    if (
      raw.type === "session.updated" &&
      raw.session?.audio?.input?.turn_detection?.create_response ===
        this.expectedAutomatic
    ) {
      this.controlAck?.(true);
      return;
    }
    if (raw.type === "error" && raw.error?.event_id === "fresh_control") {
      this.controlAck?.(false);
      return;
    }
    if (raw.type === "input_audio_buffer.speech_started") {
      if (typeof raw.item_id !== "string" || raw.item_id === this.lastAudioItem)
        return;
      this.lastAudioItem = raw.item_id;
      this.actionTurn = null;
      this.held = this.controlled;
      ++this.turnEpoch;
      if (this.attempt) this.attempt.continueTools = false;
      this.turnHandler?.({ type: "speech_started", key: raw.item_id });
    }
    if (raw.type === "input_audio_buffer.speech_stopped")
      this.turnHandler?.({ type: "turn_completed", key: raw.item_id });
    if (raw.type === "input_audio_buffer.committed") {
      const key = this.manualCommitKey ?? raw.item_id;
      this.manualCommitKey = null;
      this.turnHandler?.({ type: "turn_completed", key });
    }
    if (raw.type === "response.created")
      this.turnHandler?.({ type: "response_started" });
    if (raw.type === "output_audio_buffer.started")
      this.turnHandler?.({ type: "first_audio" });
    if (raw.type === "response.done")
      this.turnHandler?.({ type: "response_done" });
  }
  private snapshot = initialVoiceSnapshot();
  private listeners = new Set<() => void>();
  private attempt: Attempt | null = null;
  private toolHandler: ToolHandler | null = null;
  private visualSequence = 0;
  private visualAcks = new Map<string, (acknowledged: boolean) => void>();
  setToolHandler(handler: ToolHandler | null) {
    this.toolHandler = handler;
  }

  constructor(
    private readonly environment: VoiceEnvironment = browserEnvironment,
    private readonly credentialSource?: (
      signal: AbortSignal,
    ) => Promise<import("./handshake.js").Credential>,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(snapshot: VoiceSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  private log(message: string) {
    this.publish(appendEvent(this.snapshot, message, this.environment.now()));
  }

  async connect(testOnly = false): Promise<void> {
    if (this.attempt) return;
    let resolve = () => {};
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const attempt: Attempt = {
      abort: new AbortController(),
      startedAt: this.environment.now(),
      sessionReady: false,
      events: new VoiceEvents(),
      resolve,
      toolCalls: new Set(),
      responseActive: false,
      pendingTools: 0,
      continueTools: false,
    };
    this.attempt = attempt;
    this.publish({ ...initialVoiceSnapshot(), connection: "Connecting" });
    this.log("Session connecting");
    attempt.timeout = setTimeout(
      () =>
        this.fail(
          attempt,
          new VoiceError(
            "Voice connection timed out. Check microphone permission, provider settings and network, then try again.",
          ),
        ),
      voiceConfig.connectionTimeoutMs,
    );
    void this.initialize(attempt, testOnly);
    await completed;
  }

  private async initialize(attempt: Attempt, testOnly: boolean) {
    try {
      // Request permission before minting a 60-second credential, avoiding expiry while the user decides.
      const stream = testOnly ? null : await this.requestMicrophone(attempt);
      if (this.attempt !== attempt) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      attempt.microphone = stream ?? undefined;
      if (stream && stream.getAudioTracks().length === 0)
        throw new VoiceError("No microphone audio track is available.");
      stream?.getAudioTracks().forEach((track) => {
        // History is seeded before microphone input can create the first turn.
        track.enabled = false;
        track.onended = () =>
          this.fail(
            attempt,
            new VoiceError(
              "Microphone disconnected. Reconnect it and start again.",
            ),
          );
      });
      this.publish({
        ...this.snapshot,
        microphone: stream ? "Active" : "Unavailable",
      });
      const credential = this.credentialSource
        ? await this.credentialSource(attempt.abort.signal)
        : await getCredential(this.environment.fetch, attempt.abort.signal);
      if (this.attempt !== attempt) return;
      this.publish({ ...this.snapshot, model: credential.model });
      const peer = this.environment.createPeer();
      attempt.peer = peer;
      const audio = this.environment.createAudio();
      attempt.audio = audio;
      audio.autoplay = true;
      audio.onerror = () =>
        this.fail(
          attempt,
          new VoiceError(
            "AI audio playback failed. Check your output device, then start again.",
          ),
        );
      peer.ontrack = (event) => {
        if (this.attempt !== attempt || event.track.kind !== "audio") return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .catch(() =>
            this.fail(
              attempt,
              new VoiceError(
                "AI audio could not play automatically. Check WebView2 audio permissions and restart the voice session.",
              ),
            ),
          );
      };
      peer.onconnectionstatechange = () => {
        if (this.attempt !== attempt) return;
        if (["failed", "disconnected", "closed"].includes(peer.connectionState))
          this.fail(
            attempt,
            new VoiceError(
              "The realtime connection was interrupted. Check your network and start again.",
            ),
          );
        else this.ready(attempt);
      };
      if (stream)
        stream
          .getAudioTracks()
          .forEach((track) => peer.addTrack(track, stream));
      else peer.addTransceiver("audio", { direction: "recvonly" });
      const channel = peer.createDataChannel("oai-events");
      attempt.channel = channel;
      channel.onopen = () => this.ready(attempt);
      channel.onerror = () =>
        this.fail(
          attempt,
          new VoiceError(
            "The realtime event channel failed. Start the session again.",
          ),
        );
      channel.onclose = () =>
        this.fail(
          attempt,
          new VoiceError(
            "The realtime event channel closed unexpectedly. Start again.",
          ),
        );
      channel.onmessage = (event) => {
        if (this.attempt !== attempt) return;
        try {
          const raw = JSON.parse(event.data as string);
          if (this.actionOutput(raw)) return;
          this.turnEvent(raw);
          this.historyEvent(raw);
          if (raw.type === "error" && raw.error?.event_id === "fresh_control")
            return;
          if (this.visualEvent(raw)) return;
          const result = attempt.events.apply(
            this.snapshot,
            raw,
            this.environment.now(),
          );
          this.publish(result.snapshot);
          if (result.failed) {
            this.fail(
              attempt,
              new VoiceError(
                "OpenAI reported a realtime error. Check model access and quota, then start again.",
              ),
            );
            return;
          }
          if (result.sessionReady) attempt.sessionReady = true;
          this.ready(attempt);
          if (raw.type === "response.created") attempt.responseActive = true;
          if (raw.type === "response.done") {
            attempt.responseActive = false;
            if (
              raw.response?.status === "completed" &&
              Array.isArray(raw.response.output)
            ) {
              for (const item of raw.response.output) {
                if (
                  item?.type !== "function_call" ||
                  item.status !== "completed" ||
                  typeof item.call_id !== "string" ||
                  typeof item.name !== "string" ||
                  attempt.toolCalls.has(item.call_id)
                )
                  continue;
                if (attempt.toolCalls.size >= 256)
                  attempt.toolCalls.delete(
                    attempt.toolCalls.values().next().value!,
                  );
                attempt.toolCalls.add(item.call_id);
                let args: unknown = null;
                try {
                  if (
                    typeof item.arguments === "string" &&
                    item.arguments.length <= 4096
                  )
                    args = JSON.parse(item.arguments);
                } catch {
                  /* dispatcher returns invalid_arguments */
                }
                const call: ToolCall = {
                  id: item.call_id,
                  name: item.name,
                  arguments: args,
                  signal: attempt.abort.signal,
                };
                if (this.toolHandler) {
                  const toolEpoch = this.turnEpoch;
                  attempt.pendingTools++;
                  void this.toolHandler(call)
                    .catch(() =>
                      this.log("Visual tool failed; voice remains active"),
                    )
                    .finally(() => {
                      attempt.pendingTools--;
                      if (toolEpoch !== this.turnEpoch) return;
                      attempt.continueTools = true;
                      this.continueAfterTools(attempt);
                    });
                }
              }
            }
            this.continueAfterTools(attempt);
          }
        } catch {
          this.fail(
            attempt,
            new VoiceError(
              "An invalid realtime event was received. Start again.",
            ),
          );
        }
      };
      const offer = await peer.createOffer();
      if (this.attempt !== attempt) return;
      await peer.setLocalDescription(offer);
      if (this.attempt !== attempt) return;
      if (!offer.sdp)
        throw new VoiceError("WebRTC could not create an audio offer.");
      const answer = await exchangeOffer(
        this.environment.fetch,
        offer.sdp,
        credential,
        attempt.abort.signal,
      );
      if (this.attempt !== attempt) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      this.ready(attempt);
    } catch (cause) {
      this.fail(attempt, cause);
    }
  }

  private requestMicrophone(attempt: Attempt): Promise<MediaStream> {
    return new Promise((resolve, reject) => {
      const signal = attempt.abort.signal;
      let settled = false;
      const cancel = () => {
        settled = true;
        signal.removeEventListener("abort", cancel);
        reject(new VoiceError("Voice connection cancelled."));
      };
      signal.addEventListener("abort", cancel, { once: true });
      const request = async () => this.environment.getMicrophone();
      request().then(
        (stream) => {
          signal.removeEventListener("abort", cancel);
          if (settled || signal.aborted) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          settled = true;
          resolve(stream);
        },
        (cause: unknown) => {
          signal.removeEventListener("abort", cancel);
          if (!settled) {
            settled = true;
            reject(
              cause instanceof VoiceError ? cause : microphoneError(cause),
            );
          }
        },
      );
    });
  }

  private ready(attempt: Attempt) {
    if (
      this.attempt !== attempt ||
      this.snapshot.connection === "Connected" ||
      !attempt.sessionReady ||
      attempt.peer?.connectionState !== "connected" ||
      attempt.channel?.readyState !== "open"
    )
      return;
    clearTimeout(attempt.timeout);
    // Text-only seed in order. No response.create: restoring history must not
    // replay a previous answer or trigger speech in the new session.
    try {
      for (const message of this.history.get()) {
        this.sendEvent(
          {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: message.role,
              content: [
                {
                  type: message.role === "user" ? "input_text" : "output_text",
                  text: message.text,
                },
              ],
            },
          },
          true,
        );
      }
    } catch (error) {
      this.fail(attempt, error);
      return;
    }
    attempt.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    const now = this.environment.now();
    this.publish({
      ...this.snapshot,
      connection: "Connected",
      conversation: "Listening",
      connectedAt: now,
      metrics: {
        ...this.snapshot.metrics,
        connectionMs: now - attempt.startedAt,
      },
    });
    this.log("Session connected");
    attempt.resolve();
  }

  setMuted(muted: boolean) {
    if (this.snapshot.connection !== "Connected" || !this.attempt?.microphone)
      return;
    this.attempt.microphone.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.publish({ ...this.snapshot, microphone: muted ? "Muted" : "Active" });
    this.log(muted ? "Microphone muted" : "Microphone unmuted");
  }

  maxImageBytes() {
    const limit = this.attempt?.peer?.sctp?.maxMessageSize;
    return limit && Number.isFinite(limit)
      ? Math.max(0, Math.floor((limit - 16384) * 0.75))
      : 1_048_576;
  }
  private sendEvent(event: unknown, initializing = false) {
    const channel = this.attempt?.channel;
    if (
      !channel ||
      channel.readyState !== "open" ||
      (this.snapshot.connection !== "Connected" && !initializing)
    )
      throw new VoiceError("Realtime connection is not ready.");
    const encoded = JSON.stringify(event);
    const limit = this.attempt?.peer?.sctp?.maxMessageSize;
    if ((limit && encoded.length > limit) || channel.bufferedAmount > 2_000_000)
      throw new VoiceError("Visual message exceeds the connection limit.");
    channel.send(encoded);
  }
  async sendVisualContext(
    context: VisualContext,
    signal: AbortSignal,
  ): Promise<VisualDelivery> {
    if (!context.context || !context.frames)
      return this.sendVisualMessage(context, signal);
    if (
      context.frames.length > 4 ||
      context.frames.some((f) => f.encodedSizeBytes > this.maxImageBytes())
    )
      throw new VoiceError("Visual context exceeds the connection limit.");
    const frames = context.frames.length ? context.frames : [undefined];
    let receipt: VisualDelivery = { sent: false, acknowledgment: "Not sent" };
    for (let index = 0; index < frames.length; index++) {
      await context.validate?.();
      if (signal.aborted) throw new VoiceError("Visual request cancelled.");
      const frame = frames[index];
      const role =
        context.inspection?.snapshots.find(
          (snapshot) => snapshot.snapshotId === frame?.snapshotId,
        )?.temporalRole ?? frame?.role;
      const attachment = frame
        ? `Attached snapshot ${frame.snapshotId}; temporal role ${role}; offset ${frame.offsetMs} ms from user turn completion.`
        : "No image attached.";
      receipt = await this.sendVisualMessage(
        frame ? { ...context, ...frame } : context,
        signal,
        index === 0 ? `${contextText(context)}\n${attachment}` : attachment,
        !!frame,
      );
      if (receipt.sent)
        noteVisualEnqueue(
          "openai",
          context,
          frame ? 1 : 0,
          frame?.encodedSizeBytes ?? 0,
          index === 0,
        );
      if (!receipt.sent || receipt.acknowledged === false) return receipt;
    }
    return receipt;
  }
  private sendVisualMessage(
    context: VisualContext,
    signal: AbortSignal,
    text?: string,
    includeImage = true,
  ): Promise<VisualDelivery> {
    if (signal.aborted)
      return Promise.reject(new VoiceError("Visual request cancelled."));
    if (includeImage && !context.base64?.trim())
      return Promise.reject(
        new VoiceError("No usable screen image was supplied."),
      );
    const id = `visual_${++this.visualSequence}`;
    return new Promise((resolve, reject) => {
      const done = (acknowledged: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.visualAcks.delete(id);
        resolve({
          sent: true,
          acknowledged,
          acknowledgment: acknowledged
            ? "Conversation image acknowledged"
            : "Image acknowledgment unavailable or rejected",
        });
      };
      const cancel = () => done(false);
      const timer = setTimeout(() => done(false), 8000);
      this.visualAcks.set(id, done);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.sendEvent({
          type: "conversation.item.create",
          event_id: id,
          item: {
            id,
            type: "message",
            role: "user",
            content: [
              ...(includeImage
                ? [
                    {
                      type: "input_image",
                      image_url: `data:${context.mimeType};base64,${context.base64}`,
                    },
                  ]
                : []),
              ...(text || context.visual
                ? [
                    {
                      type: "input_text",
                      text:
                        text ??
                        `${context.kind === "detail" ? "HIGH RESOLUTION DETAIL (crop)" : "FULL SCREEN CONTEXT"} for ${context.visual?.turnId}; captured at ${context.timestampUnixMs}. This snapshot belongs to this completed user turn.`,
                    },
                  ]
                : []),
            ],
          },
        });
      } catch (error) {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.visualAcks.delete(id);
        reject(error);
      }
    });
  }
  sendToolResult(call: ToolCall, result: ToolResult) {
    if (call.signal.aborted) return;
    this.sendEvent({
      type: "conversation.item.create",
      event_id: `visual_result_${++this.visualSequence}`,
      item: {
        type: "function_call_output",
        call_id: call.id,
        output: JSON.stringify(result),
      },
    });
  }
  private visualEvent(event: {
    type?: string;
    item?: { id?: string };
    error?: { event_id?: string };
  }): boolean {
    if (
      event.type === "conversation.item.added" ||
      event.type === "conversation.item.done"
    ) {
      if (event.item?.id) this.visualAcks.get(event.item.id)?.(true);
    }
    if (
      event.type === "error" &&
      event.error?.event_id?.startsWith("visual_")
    ) {
      this.visualAcks.get(event.error.event_id)?.(false);
      this.log(
        "Visual input or tool continuation rejected; voice remains active",
      );
      return true;
    }
    return false;
  }
  private continueAfterTools(attempt: Attempt) {
    if (
      this.attempt !== attempt ||
      !attempt.continueTools ||
      attempt.pendingTools ||
      attempt.responseActive ||
      this.held
    )
      return;
    attempt.continueTools = false;
    try {
      this.sendEvent({
        type: "response.create",
        event_id: `visual_continue_${++this.visualSequence}`,
      });
    } catch {
      this.log("Visual tool continuation could not be sent");
    }
  }

  disconnect() {
    this.cleanup();
    this.history.set([]);
    this.historyResponses.clear();
    this.publish(
      appendEvent(
        initialVoiceSnapshot(),
        "Session disconnected",
        this.environment.now(),
      ),
    );
  }

  private fail(attempt: Attempt, cause: unknown) {
    if (this.attempt !== attempt) return;
    const message = safeError(cause);
    const events = this.snapshot.events;
    this.cleanup();
    this.publish(
      appendEvent(
        { ...initialVoiceSnapshot(), events, error: message },
        message,
        this.environment.now(),
      ),
    );
  }

  private cleanup() {
    this.actionTurn = null;
    this.manualCommitKey = null;
    this.lastAudioItem = null;
    this.controlAck?.(false);
    this.controlled = false;
    this.held = false;
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt) return;
    attempt.abort.abort();
    attempt.stopBoundaryObserver?.();
    for (const complete of this.visualAcks.values()) complete(false);
    this.visualAcks.clear();
    clearTimeout(attempt.timeout);
    attempt.microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (attempt.channel) {
      attempt.channel.onopen =
        attempt.channel.onclose =
        attempt.channel.onerror =
        attempt.channel.onmessage =
          null;
      attempt.channel.close();
    }
    if (attempt.peer) {
      attempt.peer.ontrack = attempt.peer.onconnectionstatechange = null;
      attempt.peer.getReceivers().forEach((receiver) => receiver.track?.stop());
      attempt.peer.close();
    }
    if (attempt.audio) {
      attempt.audio.onerror = null;
      attempt.audio.pause();
      attempt.audio.srcObject = null;
      attempt.audio.remove();
    }
    attempt.resolve();
  }
}
