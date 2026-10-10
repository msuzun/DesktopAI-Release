import type {
  RealtimeVoiceProvider,
  VoiceSnapshot,
} from "../RealtimeVoiceProvider.js";
import { initialVoiceSnapshot } from "../VoiceEvents.js";
import { PcmAudio } from "../audio/PcmAudio.js";
import { PcmTurnDetector } from "../turns/PcmTurnDetector.js";
import type {
  AIProviderAdapter,
  ContextPreparer,
  ConversationMessage,
  PreparedTurn,
} from "./types.js";
import type {
  AudioPlayback,
  RecordedSpeech,
  SpeechRecognitionEngine,
  SpeechSynthesisEngine,
  SynthesizedSpeech,
} from "./SpeechEngines.js";
import { SpeechChunker, SpeechQueue } from "./SpeechChunker.js";
import { untilCancelled } from "./cancellation.js";
import { microphoneError, VoiceError } from "../errors.js";
import type { ActionTurnHandler } from "../actions/ActionIntentEngine.js";

export interface PipelineOptions {
  providerName: string;
  model: string;
  reasoning: AIProviderAdapter;
  recognition?: SpeechRecognitionEngine;
  synthesis?: SpeechSynthesisEngine;
  nativeAudio?: boolean;
  microphone?: (activity: (playing: boolean) => void) => PcmAudio;
  playback?: AudioPlayback;
  context?: ContextPreparer;
  completed?: () => void;
  /** Operational ceiling, not a measured latency target. */
  turnTimeoutMs?: number;
  startupTimeoutMs?: number;
  speechReady?: () => Promise<boolean>;
}
const noContext: ContextPreparer = async () => ({
  images: [],
  contextText: "No screen or saved-memory images are attached.",
  route: "none",
  validate: async () => {},
  submitted: () => {},
  release: () => {},
});

/** Owns a composed voice turn. No provider protocol, visual capture or storage. */
export class VoiceConversationPipeline implements RealtimeVoiceProvider {
  readonly composed = true;
  private snapshot: VoiceSnapshot;
  private listeners = new Set<() => void>();
  private generation = 0;
  private connected = false;
  private root: AbortController | null = null;
  private mic: PcmAudio | null = null;
  private detector: PcmTurnDetector | null = null;
  private recording: RecordedSpeech = { pcm: [], sampleRate: 16000 };
  private recordedBytes = 0;
  private playbackDone: (() => void) | null = null;
  private history: ConversationMessage[] = [];
  private context: ContextPreparer;
  private actions: ActionTurnHandler | null = null;
  private completed: () => void;
  private muted = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private inputTurnId = "";
  private boundaryAt: number | null = null;
  private reserveContext:
    ((turnId: string, completedMonotonicAt: number) => void) | undefined;
  constructor(private options: PipelineOptions) {
    this.snapshot = {
      ...initialVoiceSnapshot(),
      provider: options.providerName,
      model: options.model,
    };
    this.context = options.context ?? noContext;
    this.completed = options.completed ?? (() => {});
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setContextPreparer(
    prepare: ContextPreparer,
    completed?: () => void,
    reserve?: (turnId: string, completedMonotonicAt: number) => void,
  ) {
    this.context = prepare;
    this.completed = completed ?? this.completed;
    this.reserveContext = reserve;
  }
  setActionHandler(handler: ActionTurnHandler | null) {
    if (this.connected && this.actions !== handler) this.cancelTurn();
    this.actions = handler;
  }
  getConversationHistory() {
    return this.history.map((message) => ({ ...message }));
  }
  setConversationHistory(history: ConversationMessage[]) {
    this.history = normalizeHistory(history);
  }
  private boundHistory() {
    this.history = normalizeHistory(this.history);
  }
  private publish(patch: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private stage(state: string, timings?: Record<string, number>) {
    this.publish({
      pipeline: {
        transport: "http",
        nativeLiveSession: false,
        state,
        generation: this.generation,
        timings: timings ?? this.snapshot.pipeline?.timings ?? {},
      },
    });
  }
  async connect(testOnly = false) {
    if (this.connected) return;
    const generation = ++this.generation;
    const startup = new AbortController();
    this.root = startup;
    const startupTimer = setTimeout(
      () =>
        startup.abort(
          new VoiceError(
            "Voice connection timed out. Check the selected services and try again.",
          ),
        ),
      this.options.startupTimeoutMs ?? 70000,
    );
    let startupNotice: string | null = null;
    this.connected = true;
    this.publish({ connection: "Connecting", error: null, notice: null });
    try {
      if (testOnly) {
        let complete = false;
        const iterator = this.options.reasoning
          .stream(
            {
              turnId: crypto.randomUUID(),
              generation,
              userText: "Reply with OK.",
              history: [],
              images: [],
              contextText: "Connection test. No microphone or screen input.",
            },
            startup.signal,
          )
          [Symbol.asyncIterator]();
        try {
          while (true) {
            const item = await untilCancelled(iterator.next(), startup.signal);
            if (item.done) break;
            if (item.value.type === "error")
              throw new Error("Provider connection test failed.");
            if (item.value.type === "completed") complete = true;
          }
        } finally {
          void iterator.return?.().catch(() => {});
        }
        if (!complete)
          throw new Error("Provider did not complete the connection test.");
      } else if (
        this.options.recognition &&
        (this.options.synthesis || this.options.nativeAudio)
      ) {
        const speechReady = await untilCancelled(
          this.options.speechReady?.().catch(() => false) ??
            Promise.resolve(true),
          startup.signal,
        );
        if (!this.connected || generation !== this.generation) return;
        if (speechReady) {
          let audioOwner: PcmAudio | null = null;
          this.mic = (
            this.options.microphone ?? ((activity) => new PcmAudio(activity))
          )((playing) => {
            if (this.mic !== audioOwner) return;
            if (!playing) {
              this.playbackDone?.();
              this.playbackDone = null;
            }
          });
          audioOwner = this.mic;
          const microphone = this.mic;
          this.resetDetector();
          try {
            await untilCancelled(
              microphone.start(
                (data, rate) => {
                  if (
                    this.mic === microphone &&
                    this.snapshot.connection === "Connected"
                  )
                    this.detector?.push(data, rate);
                },
                () => {
                  if (this.mic !== microphone) return;
                  this.cancelTurn();
                  this.mic = null;
                  this.detector = null;
                  microphone.close();
                  this.publish({
                    microphone: "Unavailable",
                    notice: "Microphone stopped. Restart voice or use text.",
                  });
                },
              ),
              startup.signal,
            );
          } catch (error) {
            if (this.mic === microphone) {
              this.mic = null;
              this.detector = null;
              microphone.close();
            }
            startupNotice = (
              error instanceof VoiceError ? error : microphoneError(error)
            ).message;
          }
        }
      }
      if (!this.connected || generation !== this.generation) return;
      startup.signal.throwIfAborted();
      this.publish({
        connection: "Connected",
        connectedAt: Date.now(),
        conversation: "Listening",
        microphone: this.mic ? "Active" : "Unavailable",
        notice:
          startupNotice ??
          (!testOnly && !this.mic
            ? "Text conversation is ready. Select speech recognition and speech output services to use your microphone."
            : null),
      });
      this.stage("Listening", {});
    } catch (error) {
      if (generation !== this.generation) return;
      this.disconnect();
      throw startup.signal.aborted &&
        startup.signal.reason instanceof VoiceError
        ? startup.signal.reason
        : error;
    } finally {
      clearTimeout(startupTimer);
    }
  }
  private resetDetector() {
    this.detector = new PcmTurnDetector(
      () => {
        this.cancelTurn();
        this.root = new AbortController();
        this.inputTurnId = crypto.randomUUID();
        this.boundaryAt = null;
        this.recording = { pcm: [], sampleRate: 16000 };
        this.recordedBytes = 0;
        this.publish({ conversation: "User Speaking", notice: null });
        this.stage("Listening", {});
      },
      (data, rate) => {
        if (!this.connected || this.muted || !this.root) return;
        this.recording.sampleRate = rate;
        this.recording.pcm.push(data);
        this.recordedBytes += Math.floor((data.length * 3) / 4);
        if (this.recordedBytes >= rate * 2 * 30) this.detector?.finish();
      },
      () => {
        const audio = this.recording,
          turnId = this.inputTurnId,
          completedAt = this.boundaryAt ?? performance.now();
        this.recording = { pcm: [], sampleRate: 16000 };
        this.recordedBytes = 0;
        this.reserveContext?.(turnId, completedAt);
        void this.recognize(audio, turnId, completedAt);
      },
      () => ["AI Speaking", "AI Thinking"].includes(this.snapshot.conversation),
      (completedAt) => {
        this.boundaryAt = completedAt;
      },
    );
  }
  private valid(generation: number, signal: AbortSignal) {
    return this.connected && generation === this.generation && !signal.aborted;
  }
  private async recognize(
    audio: RecordedSpeech,
    turnId: string,
    completedAt: number,
  ) {
    const signal = this.root?.signal,
      generation = this.generation;
    if (!signal || !this.options.recognition || !audio.pcm.length) return;
    const started = performance.now();
    this.startDeadline(generation, signal);
    this.publish({ conversation: "AI Thinking" });
    this.stage("Transcribing");
    try {
      const text = await untilCancelled(
        this.options.recognition.transcribe(audio, signal),
        signal,
      );
      audio.pcm.length = 0;
      if (!this.valid(generation, signal)) return;
      await this.respond(
        text,
        generation,
        signal,
        { recognitionMs: performance.now() - started },
        turnId,
        completedAt,
      );
    } catch (error) {
      this.failed(error, generation, signal);
    } finally {
      audio.pcm.length = 0;
    }
  }
  async sendText(text: string) {
    if (!this.connected || !text.trim()) return;
    if (text.length > 8192) {
      this.publish({ notice: "This message is too long. Please shorten it." });
      return;
    }
    this.cancelTurn();
    this.resetDetector();
    const generation = this.generation,
      controller = new AbortController();
    this.root = controller;
    this.startDeadline(generation, controller.signal);
    await this.respond(text.trim(), generation, controller.signal, {});
  }
  private transcript(id: string, role: "YOU" | "AI", text: string) {
    const old = this.snapshot.transcripts
      .filter((item) => item.id !== id)
      .slice(-39);
    this.publish({ transcripts: [...old, { id, role, text }] });
  }
  private async play(audio: SynthesizedSpeech, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      !Number.isFinite(audio.sampleRate) ||
      audio.sampleRate <= 0 ||
      typeof audio.base64 !== "string" ||
      audio.base64.length > 6_000_000
    )
      throw new Error("Invalid speech audio.");
    const bytes = atob(audio.base64);
    if (
      !bytes.length ||
      bytes.length % 2 ||
      bytes.length / 2 / audio.sampleRate > 60
    )
      throw new Error("Speech audio exceeded its limit.");
    if (this.options.playback)
      return untilCancelled(this.options.playback.play(audio, signal), signal);
    if (!this.mic)
      throw new Error(
        "Audio playback is unavailable. The answer remains visible.",
      );
    // At most one synthesized phrase is scheduled; long PCM is split into bounded sources.
    let stop!: () => void;
    const finished = new Promise<void>((resolve) => {
      this.playbackDone = resolve;
      stop = () => {
        this.mic?.interrupt();
        resolve();
      };
    });
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (let i = 0; i < bytes.length; i += 48000) {
        signal.throwIfAborted();
        this.mic.play(btoa(bytes.slice(i, i + 48000)), audio.sampleRate);
      }
      await finished;
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", stop);
      this.playbackDone = null;
    }
  }
  private async respond(
    text: string,
    generation: number,
    signal: AbortSignal,
    timings: Record<string, number>,
    inputTurnId?: string,
    completedMonotonicAt?: number,
  ) {
    if (!text.trim() || text.length > 8192) {
      this.failed(
        new Error("No usable speech was recognized. Please try again."),
        generation,
        signal,
      );
      return;
    }
    const turnId = inputTurnId ?? crypto.randomUUID(),
      started = performance.now();
    let prepared: PreparedTurn | undefined,
      ticker: ReturnType<typeof setInterval> | undefined;
    const current = () => this.valid(generation, signal);
    this.transcript(`${turnId}:user`, "YOU", text);
    this.publish({ conversation: "AI Thinking", notice: null });
    this.stage("PreparingContext", timings);
    let response = "",
      finished = false,
      nativeAudio = false,
      displayAt = -Infinity;
    let speechFailure: string | undefined;
    const chunker = new SpeechChunker();
    const display = (force = false) => {
      const now = performance.now();
      if (response && (force || now - displayAt >= 50)) {
        displayAt = now;
        this.transcript(`${turnId}:assistant`, "AI", response);
      }
    };
    const queue = new SpeechQueue(async (chunk) => {
      if (!current() || !this.options.synthesis || speechFailure) return;
      const synthesisStart = performance.now();
      this.stage("Synthesizing", timings);
      try {
        const audio = await untilCancelled(
          this.options.synthesis.synthesize(chunk, signal),
          signal,
        );
        if (!current()) return;
        timings.firstSynthesisMs ??= performance.now() - synthesisStart;
        timings.firstAudioMs ??= performance.now() - started;
        this.publish({ conversation: "AI Speaking" });
        this.stage("Speaking", timings);
        await this.play(audio, signal);
      } catch {
        if (!current()) return;
        speechFailure =
          "Voice playback is unavailable. The answer remains visible.";
        this.options.playback?.stop();
        this.mic?.interrupt();
        this.publish({ notice: speechFailure, conversation: "AI Thinking" });
      }
    }, signal);
    const speech = (chunks: string[], fallback = false) => {
      if (
        speechFailure ||
        !this.options.synthesis ||
        (this.options.nativeAudio && !fallback) ||
        nativeAudio
      )
        return;
      try {
        chunks.forEach((chunk) => queue.push(chunk));
      } catch {
        speechFailure =
          "Speech response exceeded its queue limit. The complete answer remains visible.";
        this.publish({ notice: speechFailure });
      }
    };
    try {
      const action = await untilCancelled(
        this.actions?.(text, turnId, signal) ??
          Promise.resolve({ handled: false }),
        signal,
      );
      if (!current()) return;
      if (action.handled) {
        response =
          "message" in action && typeof action.message === "string"
            ? action.message
            : "The action could not be completed.";
        display(true);
        speech([...chunker.add(response), ...chunker.finish()], true);
        await queue.drain();
        if (!current()) return;
        this.history.push(
          { role: "user", text },
          { role: "assistant", text: response },
        );
        this.boundHistory();
        this.completed();
        this.publish({
          conversation: "Listening",
          notice: speechFailure ?? null,
        });
        this.stage("Listening", timings);
        return;
      }
      const preparation = this.context(
        text,
        turnId,
        signal,
        completedMonotonicAt,
      );
      void preparation.then(
        (value) => {
          if (!current()) value.release();
        },
        () => {},
      );
      prepared = await untilCancelled(preparation, signal);
      if (!current()) return;
      await untilCancelled(prepared.validate(), signal);
      if (!current()) return;
      timings.contextMs = performance.now() - started;
      this.stage("WaitingForAI", timings);
      ticker = setInterval(() => {
        if (!current()) return;
        display();
        try {
          speech(chunker.due());
        } catch (error) {
          this.failed(error, generation, signal);
        }
      }, 100);
      const iterator = this.options.reasoning
        .stream(
          {
            turnId,
            generation,
            userText: text,
            history: this.history.map((m) => ({ ...m })),
            images: prepared.images,
            contextText: prepared.contextText,
            voice: !!this.options.synthesis,
          },
          signal,
        )
        [Symbol.asyncIterator]();
      try {
        while (true) {
          const item = await untilCancelled(iterator.next(), signal);
          if (item.done) break;
          const event = item.value;
          if (!current()) return;
          if (finished && event.type !== "completed")
            throw new Error("The service emitted content after completion.");
          if (event.type === "error")
            throw new Error("Reasoning service could not complete this turn.");
          if (event.type === "text_delta") {
            timings.firstTextMs ??= performance.now() - started;
            response += event.text;
            if (response.length > 32768)
              throw new Error("Answer exceeded its limit.");
            display();
            speech(chunker.add(event.text));
          } else if (event.type === "text_complete") {
            timings.firstTextMs ??= performance.now() - started;
            if (response && !event.text.startsWith(response))
              throw new Error(
                "The service changed text that was already spoken.",
              );
            const remainder = event.text.slice(response.length);
            response = event.text;
            if (response.length > 32768)
              throw new Error("Answer exceeded its limit.");
            display(true);
            speech(chunker.add(remainder));
          } else if (event.type === "audio") {
            if (!this.options.nativeAudio)
              throw new Error(
                "The service mixed incompatible speech output modes.",
              );
            nativeAudio = true;
            if (event.mimeType !== "audio/pcm" || !event.sampleRate)
              throw new Error("Unsupported native audio format.");
            timings.firstAudioMs ??= performance.now() - started;
            this.publish({ conversation: "AI Speaking" });
            this.stage("Speaking", timings);
            await this.play(
              { base64: event.base64, sampleRate: event.sampleRate },
              signal,
            );
          } else if (event.type === "completed") {
            finished = true;
          }
        }
      } finally {
        void iterator.return?.().catch(() => {});
      }
      if (!current()) return;
      if (!finished)
        throw new Error("The service response ended before completion.");
      if (!response.trim() && !nativeAudio)
        throw new Error("The service returned no usable answer.");
      display(true);
      timings.completeTextMs = performance.now() - started;
      if (this.options.nativeAudio && !nativeAudio && response) {
        const fallback = new SpeechChunker();
        speech([...fallback.add(response), ...fallback.finish()], true);
      } else speech(chunker.finish());
      clearInterval(ticker);
      ticker = undefined;
      prepared.submitted();
      await queue.drain();
      if (!current()) return;
      if (response) {
        this.history.push(
          { role: "user", text },
          { role: "assistant", text: response },
        );
        this.boundHistory();
      }
      this.completed();
      this.publish({
        conversation: "Listening",
        notice: speechFailure ?? null,
      });
      this.stage("Listening", timings);
    } catch (error) {
      if (current()) display(true);
      this.failed(error, generation, signal);
    } finally {
      clearInterval(ticker);
      prepared?.release();
      if (current()) {
        if (this.deadline) clearTimeout(this.deadline);
        this.deadline = null;
      }
    }
  }
  private startDeadline(generation: number, signal: AbortSignal) {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(
      () =>
        this.failed(
          new Error("This turn took too long. Please try again."),
          generation,
          signal,
        ),
      this.options.turnTimeoutMs ?? 180000,
    );
  }
  private failed(error: unknown, generation: number, signal: AbortSignal) {
    if (!this.valid(generation, signal)) return;
    // Application errors are deliberately bounded and never provider bodies.
    const localMessages = new Set([
      "This turn took too long. Please try again.",
      "No usable speech was recognized. Please try again.",
      "The service returned no usable answer.",
      "The service response ended before completion.",
      "The service emitted content after completion.",
      "The service changed text that was already spoken.",
      "The service mixed incompatible speech output modes.",
      "Reasoning service could not complete this turn.",
      "Unsupported native audio format.",
      "Speech audio exceeded its limit.",
      "Invalid speech audio.",
      "Answer exceeded its limit.",
    ]);
    const code =
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
    const contextErrors: Record<string, string> = {
      unsupported_capability:
        "The selected model cannot process this visual context.",
      provider_visual_input_unsupported:
        "The selected model cannot process screen images.",
      permission_denied: "Screen awareness is off. No screen image was sent.",
      routing_unavailable:
        "Visual routing is unavailable. Configure a visual decision engine or turn Screen Awareness off.",
      privacy: "The selected visual routing configuration is not permitted.",
    };
    const message =
      error instanceof VoiceError ||
      (error instanceof Error && localMessages.has(error.message))
        ? error.message
        : (contextErrors[code] ??
          "This turn could not finish. Please try again.");
    this.cancelTurn();
    this.publish({ conversation: "Listening", notice: message });
    this.stage("Error");
  }
  interrupt() {
    this.cancelTurn();
    this.resetDetector();
    this.publish({ conversation: this.connected ? "Listening" : "Inactive" });
    this.stage("Listening");
  }
  private cancelTurn() {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    ++this.generation;
    this.root?.abort();
    this.root = null;
    this.recording.pcm.length = 0;
    this.recordedBytes = 0;
    this.options.playback?.stop();
    this.mic?.interrupt();
    this.playbackDone?.();
    this.playbackDone = null;
  }
  finishVoiceTurn() {
    this.detector?.finish();
  }
  async enableResponseControl() {}
  async disableResponseControl() {}
  responseControlHint() {
    return "Speak naturally, or finish your turn manually.";
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.mic?.mute(muted);
    if (muted) this.interrupt();
    this.publish({
      microphone: this.mic ? (muted ? "Muted" : "Active") : "Unavailable",
    });
  }
  disconnect() {
    this.connected = false;
    this.cancelTurn();
    this.mic?.close();
    this.mic = null;
    this.detector = null;
    this.history = [];
    this.publish({
      connection: "Disconnected",
      conversation: "Inactive",
      microphone: "Unavailable",
      connectedAt: null,
    });
    this.stage("Idle", {});
  }
}
import { normalizeHistory } from "./ConversationHistory.js";
