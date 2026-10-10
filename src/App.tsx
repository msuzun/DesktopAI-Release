import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./i18n";
import { useSession } from "./useSession";
import { useRealtimeVoice } from "./hooks/useRealtimeVoice";
import { useVisualTools } from "./hooks/useVisualTools";
import { useCompanion } from "./hooks/useCompanion";
import { useAISetup } from "./hooks/useAISetup";
import { CompanionSetup } from "./components/CompanionSetup";
import { AdvancedOptions } from "./components/AdvancedOptions";
import {
  defaultConfig,
  providerDefinition,
  providerDefinitions,
} from "./providers/realtime/ProviderRegistry";
import { providerNoticeKey } from "./product/providerPresentation";
import {
  visualDeliveryNotice,
  visualFailureNotice,
} from "./product/visualPresentation";
import {
  loadProductPreferences,
  saveProductPreferences,
  type Language,
} from "./product/preferences";
import { MemoryPage } from "./product/MemoryPage";
import {
  MemoryConsent,
  MemorySettingsForm,
  RememberDialog,
} from "./product/MemoryControls";
import { ProviderSettings } from "./product/ProviderSettings";
import { useMemory } from "./product/useMemory";
import { useActions } from "./hooks/useActions";
import { ActionSettings } from "./product/ActionSettings";
import { ActionConfirmation } from "./product/ActionConfirmation";

type Page = "home" | "memory" | "settings";
export default function App() {
  const { t, i18n } = useTranslation();
  const [preferences, setPreferences] = useState(loadProductPreferences);
  const [page, setPage] = useState<Page>("home");
  const [step, setStep] = useState(0);
  const [typedMessage, setTypedMessage] = useState("");
  const [conversationError, setConversationError] = useState<string | null>(
    null,
  );
  const [dialog, setDialog] = useState<"consent" | "remember" | null>(null);
  // Session controllers remain mounted across every page and onboarding step.
  const capture = useSession();
  const live = useRealtimeVoice();
  const actions = useActions(live.manager, preferences.language);
  const screenAllowed = useRef(false);
  const visual = useVisualTools(capture, live, screenAllowed);
  const { controller, snapshot } = useCompanion(
    capture,
    live,
    visual,
    screenAllowed,
  );
  const setup = useAISetup(live);
  const memory = useMemory();
  useEffect(() => {
    void memory.refresh();
  }, [snapshot.awareness, snapshot.state, memory.refresh]);
  useEffect(() => {
    saveProductPreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    live.routing.configure({ developerMode: preferences.developerMode });
  }, [preferences.developerMode]);
  const idle = snapshot.state === "Idle" || snapshot.state === "Error";
  const active = snapshot.state === "Active";
  const conversationReady =
    active && live.session.state === "Connected" && !live.session.switching;
  const locked = !idle || live.manager.locked || setup.busy || capture.testing;
  const definition = providerDefinition(live.session.config.providerId);
  const speechRecognition = live.profiles.find(
    (p) => p.id === live.session.config.recognitionProfileId,
  );
  const speechSynthesis = live.profiles.find(
    (p) => p.id === live.session.config.synthesisProfileId,
  );
  useEffect(() => {
    if (
      definition.composed &&
      !live.session.config.language &&
      idle &&
      !live.manager.locked
    )
      live.manager.configure({
        ...live.session.config,
        language: preferences.language,
      });
  }, [
    definition.composed,
    idle,
    live.session.config,
    live.manager,
    preferences.language,
  ]);
  const supported = definition.capabilities.imageInput;
  const visualFailed = active && visual.turn.state === "VISUAL_FAILED";
  const visualNotice = visualFailureNotice(
    visual.turn.visualFailure,
    live.routing.readiness,
  );
  const deliveryNotice = visualDeliveryNotice(visual.turn);
  const responseFailed =
    active &&
    (visual.turn.state === "RESPONSE_FAILED" ||
      (visual.turn.state === "WAITING_FOR_AI_RESPONSE" && !!visual.turn.error));
  const status =
    snapshot.state === "Starting"
      ? "home.connecting"
      : snapshot.state === "Stopping"
        ? "home.stopping"
        : snapshot.state === "Error" || live.session.state === "Error"
          ? "home.connectionFailed"
          : live.session.state === "Testing"
            ? "home.testing"
            : !active
              ? !live.profilesLoaded
                ? "common.loading"
                : !setup.saved
                  ? "common.notConfigured"
                  : "home.ready"
              : live.voice.microphone === "Muted"
                ? "home.muted"
                : visualFailed || responseFailed
                  ? "home.paused"
                  : live.voice.conversation === "AI Speaking"
                    ? "home.speaking"
                    : live.voice.conversation === "AI Thinking"
                      ? "home.thinking"
                      : definition.composed &&
                          live.voice.microphone === "Unavailable"
                        ? "home.textReady"
                        : "home.listening";
  const settings = memory.status?.settings;
  const memoryEnabled = settings?.mode === "manual";
  const canRemember =
    active &&
    snapshot.awareness &&
    memoryEnabled &&
    !settings?.paused &&
    memory.status?.health === "ready";
  function changeLanguage(language: Language) {
    void i18n.changeLanguage(language);
    setPreferences((previous) => ({ ...previous, language }));
  }
  const languageControl = (
    <label>
      {t("settings.language")}
      <select
        value={preferences.language}
        onChange={(event) => changeLanguage(event.target.value as Language)}
      >
        <option value="en">English</option>
        <option value="tr">Türkçe</option>
      </select>
    </label>
  );
  const awareness = (
    <div className="awareness">
      <label className="toggle">
        <input
          type="checkbox"
          aria-label={t("home.screen")}
          checked={snapshot.awareness}
          disabled={
            (!supported && !snapshot.awareness) ||
            (!idle && !snapshot.awareness) ||
            snapshot.state === "Stopping" ||
            live.session.state === "Testing"
          }
          onChange={(event) => controller.setAwareness(event.target.checked)}
        />
        {t("home.screen")}
        <span className="status-badge">
          {t(snapshot.awareness ? "common.on" : "common.off")}
        </span>
      </label>
      <p>
        {t(
          snapshot.awareness
            ? active
              ? "home.screenOn"
              : "home.screenIdle"
            : "home.screenOff",
        )}
      </p>
      {active && snapshot.awareness && (
        <p className="help-text">{t("home.screenStop")}</p>
      )}
      <label>
        {t("settings.screenContextMode")}
        <select
          value={live.routing.mode}
          disabled={locked}
          onChange={(event) =>
            live.routing.selectMode(
              event.target.value as "current" | "semantic",
            )
          }
        >
          <option value="current">{t("settings.screenContextCurrent")}</option>
          <option value="semantic">
            {t("settings.screenContextSemantic")}
          </option>
        </select>
      </label>
      <p className="help-text">
        {t(
          live.routing.mode === "current"
            ? "settings.screenContextCurrentNote"
            : "settings.screenContextSemanticNote",
        )}
      </p>
      {snapshot.awareness && (
        <p className="help-text" role="status">
          {t(`routingReadiness.${live.routing.readiness.code}`, {
            engine: live.routing.readiness.engine,
          })}
        </p>
      )}
    </div>
  );
  const routing = (
    <div className="routing-settings">
      {live.routing.mode === "semantic" && (
        <>
          <p>{t("settings.screenContextSemantic")}</p>
          <p className="help-text">{t("developer.layaBetaNotice")}</p>
          <p className="help-text">{t("settings.routingNote")}</p>
        </>
      )}
      <p className="help-text" role="status">
        {t(`routingReadiness.${live.routing.readiness.code}`, {
          engine: live.routing.readiness.engine,
        })}
      </p>
    </div>
  );
  const onboardTitles = [
    "onboarding.welcomeTitle",
    "onboarding.providerTitle",
    "onboarding.screenTitle",
    "onboarding.routingTitle",
    "onboarding.memoryTitle",
  ];
  return (
    <main className="companion">
      <header className="app-header">
        <a
          className="brand"
          href="#home"
          onClick={(event) => {
            event.preventDefault();
            setPage("home");
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            ✳
          </span>
          <span>
            {t("app.name")}
            <small>{t("app.tagline")}</small>
          </span>
        </a>
        {preferences.onboardingCompleted && (
          <nav aria-label={t("app.navigation")}>
            {(["home", "memory", "settings"] as const).map((item) => (
              <button
                key={item}
                aria-current={page === item ? "page" : undefined}
                onClick={() => setPage(item)}
              >
                {t(`app.${item}`)}
              </button>
            ))}
          </nav>
        )}
      </header>
      {!preferences.onboardingCompleted ? (
        <section className="onboarding" aria-label={t("onboarding.label")}>
          <div
            className="onboarding-progress"
            aria-label={t("onboarding.step", { current: step + 1, total: 5 })}
          >
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} className={index <= step ? "complete" : ""} />
            ))}
          </div>
          <p className="eyebrow">
            {t("onboarding.step", { current: step + 1, total: 5 })}
          </p>
          <h1>{t(onboardTitles[step])}</h1>
          {step === 0 && (
            <>
              <p className="intro-copy">{t("onboarding.welcome")}</p>
              {languageControl}
            </>
          )}
          {step === 1 && (
            <>
              <p>{t("onboarding.provider")}</p>
              <CompanionSetup live={live} setup={setup} disabled={locked} />
              <p className="help-text">{t("settings.keyPrivacy")}</p>
            </>
          )}
          {step === 2 && (
            <>
              <p>{t("onboarding.screen")}</p>
              {awareness}
              <p className="help-text">{t("home.screenDescription")}</p>
            </>
          )}
          {step === 3 && (
            <>
              <p>{t("onboarding.routing")}</p>
              {routing}
            </>
          )}
          {step === 4 && (
            <>
              <p>{t("onboarding.memory")}</p>
              <p className="privacy-callout">{t("settings.encryption")}</p>
              <p>{t("memory.consentSharing")}</p>
              <button
                disabled={memory.busy || !memory.status || memoryEnabled}
                onClick={() => setDialog("consent")}
              >
                {t(memoryEnabled ? "common.on" : "memory.enable")}
              </button>
            </>
          )}
          <div className="controls onboarding-controls">
            {step > 0 && (
              <button onClick={() => setStep(step - 1)}>
                {t("common.back")}
              </button>
            )}
            <button
              className="primary"
              onClick={() =>
                step < 4
                  ? setStep(step + 1)
                  : setPreferences((previous) => ({
                      ...previous,
                      onboardingCompleted: true,
                    }))
              }
            >
              {t(step === 4 ? "onboarding.finish" : "common.next")}
            </button>
          </div>
        </section>
      ) : (
        <>
          {page === "home" && (
            <section aria-labelledby="home-title">
              <div className="home-heading">
                <p className="eyebrow">{t("home.eyebrow")}</p>
                <h1 id="home-title">{t("home.title")}</h1>
                <p>{t("home.intro")}</p>
              </div>
              <section className="session" aria-label={t("home.session")}>
                <div
                  className={`companion-orb ${active ? "is-active" : ""}`}
                  aria-hidden="true"
                >
                  <span>✳</span>
                </div>
                <p className="session-status" role="status">
                  {t(status)}
                </p>
                <p className="provider-line">
                  {definition.unavailable
                    ? t("common.notConfigured")
                    : definition.displayName}{" "}
                  ·{" "}
                  {definition.composed
                    ? live.session.config.model
                    : live.session.config.voice}
                </p>
                {active && (
                  <label>
                    {t("settings.provider")}
                    <select
                      disabled={live.session.switching}
                      value={live.session.config.providerId}
                      onChange={(event) => {
                        setConversationError(null);
                        void live.manager
                          .switchProvider({
                            ...live.session.config,
                            ...defaultConfig(event.target.value),
                          })
                          .catch((error: unknown) =>
                            setConversationError(
                              providerNoticeKey(
                                error instanceof Error ? error.message : null,
                              ),
                            ),
                          );
                      }}
                    >
                      {providerDefinitions
                        .filter((p) => !p.unavailable)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {snapshot.error && (
                  <p role="alert" className="error">
                    {t(providerNoticeKey(snapshot.error))}
                  </p>
                )}
                {active && live.voice.error && (
                  <p role="alert" className="error">
                    {t(providerNoticeKey(live.voice.error))}
                  </p>
                )}
                {visualFailed && (
                  <div role="alert" className="error">
                    <p>
                      {t(visualNotice.key, {
                        engine: live.routing.readiness.engine,
                      })}
                    </p>
                    {visualNotice.canRetry && (
                      <button onClick={visual.retryVisual}>
                        {t("home.retryVisual")}
                      </button>
                    )}
                    {visualNotice.showSettings && (
                      <button onClick={() => setPage("settings")}>
                        {t("app.settings")}
                      </button>
                    )}
                  </div>
                )}
                {active && snapshot.awareness && deliveryNotice && (
                  <p className="help-text" role="status">
                    {t(deliveryNotice.key, { count: deliveryNotice.count })}
                  </p>
                )}
                {responseFailed && (
                  <p role="alert" className="error">
                    {t("home.responseFailed")}
                  </p>
                )}
                {active && live.voice.notice && !responseFailed && (
                  <p role="status">{t(providerNoticeKey(live.voice.notice))}</p>
                )}
                <div className="controls primary-controls">
                  {idle && (
                    <button
                      className="primary"
                      disabled={
                        locked ||
                        !live.profilesLoaded ||
                        !setup.saved ||
                        (snapshot.awareness &&
                          ((!supported && !definition.composed) ||
                            !capture.config))
                      }
                      onClick={() => void controller.start()}
                    >
                      {t("home.start")}
                    </button>
                  )}
                  {active && live.voice.microphone !== "Unavailable" && (
                    <button onClick={live.toggleMute}>
                      {t(
                        live.voice.microphone === "Muted"
                          ? "home.unmute"
                          : "home.mute",
                      )}
                    </button>
                  )}
                  {active && definition.composed && (
                    <button
                      disabled={!conversationReady}
                      onClick={() => live.manager.interrupt()}
                    >
                      {t("home.interrupt")}
                    </button>
                  )}
                  {(!idle || live.manager.locked) && (
                    <button
                      disabled={snapshot.state === "Stopping"}
                      onClick={() => void controller.stop()}
                    >
                      {t("home.stop")}
                    </button>
                  )}
                  {active && (responseFailed || !!live.voice.notice) && (
                    <button
                      onClick={async () => {
                        await controller.stop();
                        await controller.start();
                      }}
                    >
                      {t("home.restart")}
                    </button>
                  )}
                </div>
                {idle && !setup.saved ? (
                  <div className="setup-prompt">
                    <p>{t("home.setup")}</p>
                    <button
                      className="text-button"
                      onClick={() => setPage("settings")}
                    >
                      {t("home.configure")} →
                    </button>
                  </div>
                ) : (
                  idle && (
                    <p className="help-text">
                      {definition.composed
                        ? t("settings.voicePrivacy", {
                            recognition:
                              speechRecognition?.displayName ??
                              t("common.notConfigured"),
                            reasoning: definition.displayName,
                            synthesis:
                              speechSynthesis?.displayName ??
                              t("common.notConfigured"),
                          })
                        : t("home.audioNotice", {
                            provider: definition.displayName,
                          })}
                    </p>
                  )
                )}
                {snapshot.state === "Starting" && <p>{t("home.wait")}</p>}
                {definition.composed && (
                  <>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const text = typedMessage.trim();
                        if (!text || !conversationReady) return;
                        setTypedMessage("");
                        setConversationError(null);
                        void live.manager
                          .sendText(text)
                          .catch((error: unknown) =>
                            setConversationError(
                              providerNoticeKey(
                                error instanceof Error ? error.message : null,
                              ),
                            ),
                          );
                      }}
                    >
                      <label>
                        {t("home.message")}
                        <textarea
                          value={typedMessage}
                          rows={3}
                          maxLength={8192}
                          disabled={!conversationReady}
                          placeholder={t(
                            active
                              ? "home.messagePlaceholder"
                              : "home.messageStart",
                          )}
                          onChange={(event) =>
                            setTypedMessage(event.target.value)
                          }
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={!conversationReady || !typedMessage.trim()}
                      >
                        {t("home.send")}
                      </button>
                    </form>
                    {active && (
                      <p className="help-text">
                        {t("settings.voicePrivacy", {
                          recognition:
                            live.voice.microphone === "Unavailable"
                              ? t("common.off")
                              : (speechRecognition?.displayName ??
                                t("common.notConfigured")),
                          reasoning: definition.displayName,
                          synthesis:
                            speechSynthesis?.displayName ??
                            t("common.notConfigured"),
                        })}
                      </p>
                    )}
                    {live.voice.transcripts.length > 0 && (
                      <div
                        className="conversation-history"
                        aria-label={t("home.conversation")}
                        aria-live="polite"
                      >
                        {live.voice.transcripts.slice(-8).map((transcript) => (
                          <p key={transcript.id}>
                            <strong>
                              {t(
                                transcript.role === "YOU"
                                  ? "home.you"
                                  : "home.assistant",
                              )}
                              :
                            </strong>{" "}
                            {transcript.text}
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {conversationError && (
                  <p role="alert">{t(conversationError)}</p>
                )}
              </section>
              <div className="home-capabilities">
                <section className="capability">{awareness}</section>
                <section className="capability">
                  <div className="capability-title">
                    <h2>{t("memory.titleShort")}</h2>
                    <span className="status-badge">
                      {t(
                        !memoryEnabled
                          ? "common.off"
                          : settings?.paused
                            ? "common.paused"
                            : "common.on",
                      )}
                    </span>
                  </div>
                  <p>
                    {t(
                      !memoryEnabled
                        ? "home.memoryOff"
                        : settings?.paused
                          ? "home.memoryPaused"
                          : settings?.automaticMemoryEnabled
                            ? "home.memoryAutomatic"
                            : "home.memoryManual",
                      { count: memory.status?.savedCount ?? 0 },
                    )}
                  </p>
                  <div className="controls">
                    {memoryEnabled ? (
                      <button
                        disabled={!canRemember || memory.busy}
                        onClick={() => setDialog("remember")}
                      >
                        {t("home.remember")}
                      </button>
                    ) : (
                      <button
                        disabled={
                          !memory.status ||
                          memory.busy ||
                          memory.status.health !== "ready"
                        }
                        onClick={() => setDialog("consent")}
                      >
                        {t("memory.enable")}
                      </button>
                    )}
                    <button
                      className="text-button"
                      onClick={() => setPage("memory")}
                    >
                      {t("home.openMemory")} →
                    </button>
                  </div>
                  {memoryEnabled && !canRemember && (
                    <p className="help-text">{t("home.rememberHint")}</p>
                  )}
                  {memory.error && (
                    <p className="help-text" role="status">
                      {t("memory.degraded")}
                    </p>
                  )}
                </section>
              </div>
              <div className="routing-summary">
                <span>
                  {t("home.routing")}:{" "}
                  {t(`routingReadiness.${live.routing.readiness.code}`, {
                    engine: live.routing.readiness.engine,
                  })}
                </span>
                <button
                  className="text-button"
                  onClick={() => setPage("settings")}
                >
                  {t("app.settings")} →
                </button>
              </div>
            </section>
          )}
          {page === "memory" && (
            <MemoryPage
              memory={memory}
              onEnable={() => setDialog("consent")}
              onRemember={() => setDialog("remember")}
              canRemember={!!canRemember}
            />
          )}
          {page === "settings" && (
            <section aria-labelledby="settings-title">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">{t("app.settings")}</p>
                  <h1 id="settings-title">{t("settings.title")}</h1>
                  <p>{t("settings.intro")}</p>
                </div>
              </div>
              <section className="settings-section">
                <h2>{t("settings.general")}</h2>
                {languageControl}
                <p className="help-text">{t("settings.languageNote")}</p>
              </section>
              <ProviderSettings live={live} setup={setup} disabled={locked} />
              <ActionSettings actions={actions} />
              <section className="settings-section">
                <h2>{t("settings.privacy")}</h2>
                {awareness}
                <p>{t("home.screenDescription")}</p>
                <p>{t("settings.privacyNote")}</p>
                <h3>{t("settings.routing")}</h3>
                {routing}
              </section>
              <MemorySettingsForm
                memory={memory}
                onEnable={() => setDialog("consent")}
              />
              <button className="text-button" onClick={() => setPage("memory")}>
                {t("settings.memoryLink")} →
              </button>
              {memory.error && (
                <p className="error" role="alert">
                  {t(memory.error)}
                </p>
              )}
              <section className="settings-section">
                <h2>{t("settings.advanced")}</h2>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={preferences.developerMode}
                    onChange={(event) =>
                      setPreferences((previous) => ({
                        ...previous,
                        developerMode: event.target.checked,
                      }))
                    }
                  />
                  {t("settings.developer")}
                </label>
                <p className="help-text">{t("settings.developerNote")}</p>
                <button
                  disabled={!idle}
                  onClick={() => {
                    setStep(0);
                    setPreferences((previous) => ({
                      ...previous,
                      onboardingCompleted: false,
                    }));
                  }}
                >
                  {t("settings.onboarding")}
                </button>
                {preferences.developerMode && (
                  <>
                    <AdvancedOptions
                      capture={capture}
                      live={live}
                      visual={visual}
                    />
                    <details className="voice-debug">
                      <summary>{t("settings.diagnostics")}</summary>
                      <pre>{JSON.stringify(memory.status, null, 2)}</pre>
                    </details>
                  </>
                )}
              </section>
            </section>
          )}
        </>
      )}
      <ActionConfirmation actions={actions} />
      {dialog === "consent" && (
        <MemoryConsent memory={memory} onClose={() => setDialog(null)} />
      )}
      {dialog === "remember" && (
        <RememberDialog memory={memory} onClose={() => setDialog(null)} />
      )}
      <footer>
        <span>{t("app.name")}</span>
        <span>{t("app.tagline")}</span>
      </footer>
    </main>
  );
}
