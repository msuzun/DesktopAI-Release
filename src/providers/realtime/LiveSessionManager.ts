import { TurnCoordinator, type TurnEvent } from "./turns/TurnCoordinator.js";
import type { ShadowVisualPreflight } from "./preflight/ShadowVisualPreflight.js";
import type { CredentialService, SessionConfig } from "./CredentialService.js";
import type {
  RealtimeVoiceProvider,
  VoiceSnapshot,
} from "./RealtimeVoiceProvider.js";
import {
  createProvider,
  defaultConfig,
  providerDefinition,
  validateConfig,
} from "./ProviderRegistry.js";
import { initialVoiceSnapshot } from "./VoiceEvents.js";
import { safeError, VoiceError } from "./errors.js";
import type { ToolDispatcher } from "./visual/ToolDispatcher.js";
import type { LiveDiagnosticSnapshot } from "./gemini/LiveDiagnostics.js";
import type { VisualIntentPreflight } from "./preflight/VisualIntentPreflight.js";
import { createContextPreparer } from "./universal/PreparedTurn.js";
import { untilCancelled } from "./universal/cancellation.js";
import { normalizeHistory } from "./universal/ConversationHistory.js";
import type { ConversationMessage } from "./universal/types.js";
import type { VisualContext } from "./visual/types.js";
import type { ActionTurnHandler } from "./actions/ActionIntentEngine.js";
const geminiVisualUnavailable =
  "Gemini Live screen awareness is unavailable: this connection cannot finalize speech before its response starts. Turn Screen Awareness off for voice-only conversation, or use a composed provider with separate speech recognition.";
export type SessionState =
  "Idle" | "Connecting" | "Connected" | "Disconnecting" | "Error" | "Testing";
export interface LiveSnapshot {
  switching?: boolean;
  /** Replacement failed; Companion and its local visual history remain active. */
  switchFailed?: boolean;
  config: SessionConfig;
  state: SessionState;
  voice: VoiceSnapshot;
  testResult: string | null;
  freshBusy?: boolean;
  responseControl?: "AUTOMATIC" | "MANUAL";
  lastResponseFailure?: LiveDiagnosticSnapshot;
}
export class LiveSessionManager {
  private actionHandler: ActionTurnHandler | null = null;
  private cancelAction: (() => void) | undefined;
  private nativeAction: AbortController | null = null;
  private nativeActionFinals = new Set<string>();
  private nativeActionKey: string | null = null;
  private rememberActionTurn(key: string) {
    this.nativeActionFinals.add(key);
    if (this.nativeActionFinals.size > 256)
      this.nativeActionFinals.delete(
        this.nativeActionFinals.values().next().value!,
      );
  }
  private cancelActions() {
    this.nativeAction?.abort();
    this.nativeAction = null;
    if (this.nativeActionKey) this.rememberActionTurn(this.nativeActionKey);
    this.cancelAction?.();
  }
  private async finalUserAction(
    provider: RealtimeVoiceProvider,
    event: TurnEvent,
    active: () => boolean,
  ) {
    const handler = this.actionHandler;
    if (!handler || provider.composed) {
      this.turns.event(event);
      return;
    }
    const key = event.key,
      text = event.transcript;
    if (
      !key ||
      !text?.trim() ||
      text.length > 8192 ||
      this.nativeActionFinals.has(key) ||
      provider.isCurrentUserTurn?.(key) === false
    )
      return;
    this.cancelActions();
    this.nativeActionKey = key;
    this.rememberActionTurn(key);
    const controller = new AbortController();
    this.nativeAction = controller;
    const current = () =>
      active() &&
      this.nativeAction === controller &&
      !controller.signal.aborted &&
      provider.isCurrentUserTurn?.(key) !== false;
    try {
      const result = await untilCancelled(
        handler(text, key, controller.signal),
        controller.signal,
      );
      if (!current()) return;
      if (!result.handled) {
        this.turns.event(event);
        return;
      }
      const enabled = this.turns.getSnapshot().enabled;
      this.turns.resetTurn();
      this.turns.setEnabled(enabled);
      this.tools?.cancelPending(true);
      provider.actionHandled?.(key, result.message);
    } catch {
      if (current()) {
        const enabled = this.turns.getSnapshot().enabled;
        this.turns.resetTurn();
        this.turns.setEnabled(enabled);
        this.tools?.cancelPending(true);
        provider.actionHandled?.(
          key,
          "The action request could not be checked. No action was taken.",
        );
      }
    }
  }
  setActionHandler(handler: ActionTurnHandler | null, cancel?: () => void) {
    this.cancelActions();
    this.actionHandler = handler;
    this.cancelAction = cancel;
    this.provider?.setActionHandler?.(handler);
  }
  private contextRouter: VisualIntentPreflight | null = null;
  setContextRouter(router: VisualIntentPreflight | null) {
    this.cancelActions();
    const enabled = this.turns.getSnapshot().enabled;
    this.turns.resetTurn();
    this.turns.setEnabled(enabled);
    this.tools?.cancelPending(true);
    this.contextRouter = router;
  }
  screenPermitted() {
    return (
      this.snapshot.state === "Connected" && !!this.tools?.screenPermitted()
    );
  }
  sendText(text: string) {
    return this.provider?.sendText?.(text) ?? Promise.resolve();
  }
  interrupt() {
    this.cancelActions();
    const enabled = this.turns.getSnapshot().enabled;
    this.turns.resetTurn();
    this.turns.setEnabled(enabled);
    this.provider?.interrupt?.();
    this.tools?.cancelPending(true);
  }
  private preflight: ShadowVisualPreflight | null = null;
  setVisualPreflight(value: ShadowVisualPreflight | null) {
    this.preflight?.cancel();
    this.preflight = value;
  }
  visualPermitted() {
    return this.snapshot.state === "Connected" && !!this.tools?.permitted();
  }
  readonly turns = new TurnCoordinator();
  private controlChanging = false;
  private controlSequence = 0;
  disableFreshVisual() {
    this.cancelActions();
    this.preflight?.cancel();
    ++this.controlSequence;
    this.turns.setEnabled(false);
  }
  async restoreAutomaticResponses() {
    if (this.controlChanging) return;
    const provider = this.provider;
    const generation = this.generation;
    this.disableFreshVisual();
    if (
      !provider?.disableResponseControl ||
      this.snapshot.state !== "Connected"
    )
      return;
    this.controlChanging = true;
    this.publish({ freshBusy: true });
    try {
      await provider.disableResponseControl();
      if (generation !== this.generation || this.provider !== provider) return;
      this.turns.resetTurn();
      this.publish({ responseControl: "AUTOMATIC" });
    } catch {
      if (generation === this.generation) {
        this.stop();
        this.publish({
          testResult: "Could not restore automatic voice. Start AI again.",
        });
      }
    } finally {
      if (generation === this.generation) {
        this.controlChanging = false;
        this.publish({ freshBusy: false });
      }
    }
  }
  finishVoiceTurn() {
    if (this.snapshot.state === "Connected" && !this.controlChanging) {
      try {
        this.provider?.finishVoiceTurn?.();
      } catch {
        this.publish({
          voice: {
            ...this.snapshot.voice,
            notice:
              "Could not finish the voice turn. Restore automatic voice or restart AI.",
          },
        });
      }
    }
  }
  responseControlHint() {
    return (
      this.provider?.responseControlHint?.() ?? "Response control unavailable."
    );
  }
  canRestartFreshVoice() {
    return (
      this.snapshot.config.providerId !== "gemini" &&
      !!this.provider?.restartResponseControl
    );
  }
  async restartFreshVoice() {
    this.preflight?.cancel();
    const provider = this.provider;
    if (
      this.controlChanging ||
      this.snapshot.config.providerId === "gemini" ||
      this.snapshot.state !== "Connected" ||
      !this.tools?.permitted() ||
      !provider?.restartResponseControl
    )
      return;
    const generation = this.generation;
    const change = ++this.controlSequence;
    this.controlChanging = true;
    this.publish({ freshBusy: true });
    this.turns.resetTurn();
    this.tools.cancelPending();
    try {
      await provider.restartResponseControl();
      if (generation !== this.generation || this.provider !== provider) return;
      this.publish({ responseControl: "MANUAL" });
      if (
        change === this.controlSequence &&
        this.tools?.permitted() &&
        !provider.composed
      )
        this.turns.setEnabled(true);
    } catch {
      if (generation === this.generation) {
        this.stop();
        this.publish({
          testResult: "Fresh voice restart failed. Start AI again.",
        });
      }
    } finally {
      if (generation === this.generation) {
        this.controlChanging = false;
        this.publish({ freshBusy: false });
      }
    }
  }
  async enableFreshVisual() {
    if (
      this.snapshot.config.providerId === "gemini" &&
      !this.provider?.composed
    )
      throw new VoiceError(geminiVisualUnavailable);
    const permitted = this.provider?.composed
      ? this.tools?.screenPermitted()
      : this.tools?.permitted();
    if (
      this.controlChanging ||
      this.snapshot.state !== "Connected" ||
      !permitted ||
      !this.provider?.enableResponseControl
    )
      throw new VoiceError(
        "Start both sessions and allow visual access first.",
      );
    if (this.snapshot.voice.conversation !== "Listening")
      throw new VoiceError(
        "Enable fresh visual mode between voice turns, when the AI is listening.",
      );
    const provider = this.provider;
    const generation = this.generation;
    const change = ++this.controlSequence;
    this.controlChanging = true;
    this.publish({ freshBusy: true });
    try {
      await provider.enableResponseControl!();
      if (generation !== this.generation || this.provider !== provider) return;
      this.publish({ responseControl: "MANUAL" });
      if (
        change === this.controlSequence &&
        this.tools?.permitted() &&
        !provider.composed
      )
        this.turns.setEnabled(true);
    } catch (error) {
      if (generation === this.generation) {
        this.stop();
        this.publish({
          testResult:
            "Response control failed. AI stopped safely; restart to recover.",
        });
      }
      throw error;
    } finally {
      if (generation === this.generation) {
        this.controlChanging = false;
        this.publish({ freshBusy: false });
      }
    }
  }

  private snapshot: LiveSnapshot = {
    config: defaultConfig(),
    state: "Idle",
    voice: initialVoiceSnapshot(),
    testResult: null,
  };
  private listeners = new Set<() => void>();
  private provider: RealtimeVoiceProvider | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private startup: AbortController | null = null;
  private history: ConversationMessage[] = [];
  getConversationHistory() {
    this.remember();
    return normalizeHistory(this.history);
  }
  private remember(provider = this.provider) {
    if (provider?.getConversationHistory)
      this.history = normalizeHistory(provider.getConversationHistory());
  }
  private previousUserContext(text: string, provider: RealtimeVoiceProvider) {
    const history = normalizeHistory(
      provider.getConversationHistory?.() ?? this.history,
    );
    // Native STT has already finalized this turn into M10 history; composed
    // providers append it after the response. Never use the current question
    // as its own prior subject, or pass assistant text as visual truth.
    const last = history.at(-1);
    if (!provider.composed && last?.role === "user" && last.text === text)
      history.pop();
    const previous = history
      .reverse()
      .find((message) => message.role === "user")?.text;
    return previous && new TextEncoder().encode(previous).length <= 1024
      ? previous
      : undefined;
  }
  private tools: ToolDispatcher | null = null;
  setToolDispatcher(tools: ToolDispatcher | null) {
    this.disableFreshVisual();
    this.tools?.revoke();
    this.tools = tools;
  }
  constructor(
    private credentials: CredentialService,
    private factory = createProvider,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<LiveSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  get locked() {
    return !["Idle", "Error"].includes(this.snapshot.state);
  }
  get identity() {
    return this.generation;
  }
  async switchProvider(config: SessionConfig) {
    if (this.snapshot.switching) return;
    if (this.snapshot.state !== "Connected" && !this.snapshot.switchFailed) {
      this.configure(config);
      return;
    }
    validateConfig(config);
    if (providerDefinition(config.providerId).unavailable)
      throw new VoiceError("Choose an available AI provider in Settings.");
    this.remember();
    ++this.generation;
    this.startup?.abort();
    this.startup = null;
    this.controlChanging = false;
    this.disableFreshVisual();
    this.turns.detach();
    this.tools?.cancelPending(true);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.provider?.setTurnHandler?.(null);
    this.provider?.setToolHandler?.(null);
    this.provider?.setActionHandler?.(null);
    this.provider?.disconnect();
    this.provider = null;
    this.publish({
      config: { ...config },
      switching: true,
      voice: {
        ...initialVoiceSnapshot(),
        provider: providerDefinition(config.providerId).displayName,
      },
    });
    const pending = this.start(false, true);
    const identity = this.generation;
    try {
      await pending;
      if (
        identity === this.generation &&
        this.snapshot.state === "Connected" &&
        this.tools?.permitted()
      )
        if (config.providerId === "gemini")
          this.publish({
            voice: { ...this.snapshot.voice, notice: geminiVisualUnavailable },
          });
        else await this.enableFreshVisual();
    } finally {
      if (identity === this.generation) this.publish({ switching: false });
    }
  }
  configure(config: SessionConfig) {
    if (this.locked)
      throw new VoiceError("Stop the active session before changing settings.");
    validateConfig(config);
    this.cancelActions();
    this.publish({
      config: { ...config },
      state: "Idle",
      voice: {
        ...initialVoiceSnapshot(),
        provider: providerDefinition(config.providerId).displayName,
      },
      testResult: null,
    });
  }
  async start(testOnly = false, switching = false) {
    if (this.locked && !switching) return;
    const generation = ++this.generation;
    this.startup?.abort();
    const startup = new AbortController();
    this.startup = startup;
    const config = { ...this.snapshot.config };
    this.publish({ lastResponseFailure: undefined });
    this.publish({
      state: switching ? "Connected" : testOnly ? "Testing" : "Connecting",
      switchFailed: false,
      testResult: null,
      voice: {
        ...initialVoiceSnapshot(),
        provider: providerDefinition(config.providerId).displayName,
        model: config.model,
        connection: "Connecting",
      },
    });
    try {
      validateConfig(config);
      if (
        providerDefinition(config.providerId).profile?.auth !== "none" &&
        !(await untilCancelled(
          this.credentials.has(config.providerId),
          startup.signal,
        ))
      )
        throw new VoiceError(
          "No saved API key. Save a key in AI settings first.",
        );
      if (generation !== this.generation) return;
      const provider = this.factory(config, this.credentials);
      this.provider = provider;
      this.nativeActionFinals.clear();
      this.nativeActionKey = null;
      provider.setActionHandler?.(testOnly ? null : this.actionHandler);
      provider.setConversationHistory?.(
        testOnly ? [] : normalizeHistory(this.history),
      );
      provider.setContextPreparer?.(
        async (text, turnId, signal, completedMonotonicAt) => {
          if (this.tools && this.contextRouter) {
            return createContextPreparer({
              tools: this.tools,
              router: this.contextRouter,
              previousContext: () => this.previousUserContext(text, provider),
              capabilities: () => ({
                imageInput: providerDefinition(config.providerId).capabilities
                  .imageInput,
                maxImages: providerDefinition(config.providerId).capabilities
                  .maxContextImages,
              }),
            })(
              text,
              turnId,
              signal,
              this.contextRouter.selectionTiming === "before_response"
                ? performance.now()
                : completedMonotonicAt,
            );
          }
          if (this.tools?.screenPermitted())
            throw new VoiceError(
              "Screen routing is not ready. Select a visual decision engine in Settings.",
            );
          return {
            images: [],
            contextText:
              "Screen awareness is off. No screen or saved-memory images were supplied.",
            route: "none",
            validate: async () => {
              signal.throwIfAborted();
            },
            submitted() {},
            release() {},
          };
        },
        () => this.tools?.completeTurn(),
        (turnId, completedMonotonicAt) => {
          if (
            this.snapshot.state !== "Connected" ||
            !this.tools?.screenPermitted() ||
            this.contextRouter?.selectionTiming === "before_response"
          )
            return;
          this.tools.cancelPending(true);
          this.tools.beginTurn(turnId, completedMonotonicAt, turnId);
          this.tools.reserveTurn();
        },
      );
      this.publish({ responseControl: "AUTOMATIC" });
      const active = () =>
        this.provider === provider &&
        generation === this.generation &&
        this.snapshot.state === "Connected";
      this.turns.attach({
        selectionTiming: () =>
          this.contextRouter?.selectionTiming ?? "speech_end",
        prepare: async (turnId, text, signal) => {
          if (!active() || !this.tools || !this.contextRouter)
            throw new VoiceError("Local visual routing is unavailable.");
          let frame: VisualContext | null = null;
          const prepared = await createContextPreparer({
            tools: this.tools,
            router: this.contextRouter,
            previousContext: () => this.previousUserContext(text, provider),
            capabilities: () => ({
              imageInput: providerDefinition(config.providerId).capabilities
                .imageInput,
              maxImages: providerDefinition(config.providerId).capabilities
                .maxContextImages,
              maxImageBytes: provider.maxImageBytes?.() ?? 1_048_576,
            }),
            onContextPrepared: (context) => {
              frame = context;
            },
          })(text, turnId, signal);
          return { ...prepared, frame };
        },
        beginTurn: (id, completed, conversationId) =>
          this.tools?.beginTurn?.(id, completed, conversationId),
        reserveTurn: () => this.tools?.reserveTurn(),
        active,
        permitted: () => !!this.tools?.permitted(),
        provider: providerDefinition(config.providerId).displayName,
        maxImageBytes: () => provider.maxImageBytes?.() ?? 1048576,
        capture: async (id, max, signal) => {
          if (!active() || !this.tools)
            throw new VoiceError("Visual synchronization cancelled.");
          return this.tools.captureFresh(id, max, signal);
        },
        submit: async (frame, signal) => {
          await this.tools?.waitForDeliverySlot(signal);
          if (
            !active() ||
            signal.aborted ||
            !this.tools?.permitted() ||
            !provider.sendVisualContext
          )
            throw new VoiceError("Visual synchronization cancelled.");
          const receipt = await provider.sendVisualContext(frame, signal);
          return receipt;
        },
        respond: (id, freshness) => {
          if (active() && this.snapshot.responseControl === "MANUAL")
            provider.requestTurnResponse?.(id, freshness);
        },
      });
      provider.setTurnHandler?.((event) => {
        if (!active()) return;
        if (event.type === "transcript_final") {
          void this.finalUserAction(provider, event, active);
          return;
        }
        if (event.type === "speech_started") {
          this.cancelActions();
          this.nativeActionKey = event.key ?? null;
        }
        if (event.type === "response_failed") {
          this.cancelActions();
          this.preflight?.cancel();
        }
        if (event.type === "speech_started") this.tools?.cancelPending(true);
        if (event.type === "response_done") {
          this.tools?.completeTurn();
          this.preflight?.responseCompleted();
        }
        if (event.type === "response_failed") this.tools?.cancelPending();
        this.turns.event(event);
        if (
          event.type === "response_failed" &&
          this.snapshot.responseControl === "MANUAL" &&
          provider.restartResponseControl
        ) {
          // Gemini Live has no per-response wire ID. A fresh socket is the
          // reliable boundary that prevents timed-out audio reaching a new turn.
          // Keep local perception/history running; revoke only turn resources.
          this.publish({
            lastResponseFailure: provider.getSnapshot().diagnostics,
          });
          void this.restartFreshVoice();
        }
      });
      provider.setToolHandler?.(async (call) => {
        if (!active() || call.signal.aborted) return;
        // A reasoning provider cannot select a temporal source or trigger capture.
        provider.sendToolResult?.(call, {
          status: "unknown_tool",
          success: false,
          message:
            "Visual context is selected locally for the finalized user turn. No additional image supplied.",
        });
      });
      this.unsubscribe = provider.subscribe(() => {
        if (generation !== this.generation) return;
        if (!testOnly) this.remember(provider);
        const voice = provider.getSnapshot();
        if (voice.error) {
          const switchFailed = this.snapshot.switching === true;
          this.release(switchFailed);
          this.publish({
            state: "Error",
            switchFailed,
            voice,
            testResult: testOnly ? `Connection failed: ${voice.error}` : null,
          });
          return;
        }
        this.publish({
          voice,
          state:
            this.controlChanging || this.snapshot.switching
              ? "Connected"
              : testOnly
                ? "Testing"
                : voice.connection === "Connected"
                  ? "Connected"
                  : "Connecting",
        });
      });
      await untilCancelled(provider.connect(testOnly), startup.signal);
      if (generation !== this.generation || this.snapshot.state === "Error")
        return;
      if (testOnly) {
        if (provider.getSnapshot().connection !== "Connected")
          throw new VoiceError("Provider did not confirm a connection.");
        this.stop();
        this.publish({ testResult: "Connection Successful" });
      }
    } catch (error) {
      if (generation !== this.generation || this.snapshot.state === "Error")
        return;
      this.release(switching);
      this.publish({
        state: "Error",
        switchFailed: switching,
        voice: {
          ...initialVoiceSnapshot(),
          provider: providerDefinition(config.providerId).displayName,
          error: safeError(error),
        },
        testResult: testOnly ? `Connection failed: ${safeError(error)}` : null,
      });
    } finally {
      if (this.startup === startup) this.startup = null;
    }
  }
  stop() {
    ++this.generation;
    this.controlChanging = false;
    this.publish({
      state: "Disconnecting",
      freshBusy: false,
      switching: false,
      switchFailed: false,
    });
    this.release();
    this.history = [];
    this.publish({
      state: "Idle",
      lastResponseFailure: undefined,
      voice: {
        ...initialVoiceSnapshot(),
        provider: providerDefinition(this.snapshot.config.providerId)
          .displayName,
      },
      testResult: null,
    });
  }
  setMuted(muted: boolean) {
    if (this.snapshot.state === "Connected") this.provider?.setMuted(muted);
  }
  private release(preserveVisual = false) {
    this.startup?.abort();
    this.startup = null;
    this.disableFreshVisual();
    this.turns.detach();
    if (preserveVisual) this.tools?.cancelPending(true);
    else this.tools?.revoke();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const provider = this.provider;
    this.provider = null;
    provider?.setToolHandler?.(null);
    provider?.setActionHandler?.(null);
    provider?.setTurnHandler?.(null);
    provider?.disconnect();
  }
}
