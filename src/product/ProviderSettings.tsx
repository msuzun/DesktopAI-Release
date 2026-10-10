import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { CompanionSetup, KeyEditor } from "../components/CompanionSetup";
import type { useRealtimeVoice } from "../hooks/useRealtimeVoice";
import type { useAISetup } from "../hooks/useAISetup";
import {
  defaultConfig,
  providerDefinition,
} from "../providers/realtime/ProviderRegistry";
import { providerNoticeKey } from "./providerPresentation";
import {
  isReasoningProfile,
  nativeProfileStore,
  profileCapabilities,
  type AdapterType,
  type ConfiguredAIProvider,
} from "../providers/realtime/universal/ProviderProfile";

const profileStore = nativeProfileStore(invoke);
function freshProfile(): ConfiguredAIProvider {
  return {
    id: crypto.randomUUID(),
    displayName: "",
    adapterType: "openai-compatible",
    baseUrl: "",
    model: "",
    auth: "apiKey",
    capabilities: profileCapabilities("openai-compatible"),
  };
}
export function ProviderSettings({
  live,
  setup,
  disabled,
}: {
  live: ReturnType<typeof useRealtimeVoice>;
  setup: ReturnType<typeof useAISetup>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ConfiguredAIProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [manageId, setManageId] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const secret = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const definition = providerDefinition(live.session.config.providerId);
  const existing = draft ? live.profiles.some((p) => p.id === draft.id) : false;
  const locked = disabled || busy;
  const recognizers = live.profiles.filter(
    (p) => p.adapterType === "openai-transcription",
  );
  const synthesizers = live.profiles.filter(
    (p) => p.adapterType === "openai-speech",
  );
  const managed = live.profiles.find((p) => p.id === manageId);
  function edit(profile: ConfiguredAIProvider) {
    setDraft({ ...profile, capabilities: { ...profile.capabilities } });
    setMessage(null);
    setRemoveId(null);
  }
  function closeEditor() {
    ++operation.current;
    if (secret.current) secret.current.value = "";
    setDraft(null);
  }
  async function saveProfile() {
    if (!draft || locked) return;
    const id = ++operation.current;
    setBusy(true);
    setMessage(null);
    const profile = {
      ...draft,
      displayName: draft.displayName.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
    };
    try {
      await profileStore.save(profile);
      if (profile.auth === "apiKey" && secret.current?.value)
        await profileStore.saveKey(profile.id, secret.current.value);
      await live.refreshProfiles();
      if (live.session.config.providerId === profile.id)
        live.manager.configure({
          ...live.session.config,
          model: profile.model,
        });
      if (id === operation.current) {
        setDraft(null);
        setManageId(profile.id);
        setMessage("settings.profileSaved");
      }
    } catch {
      // Metadata may save before key storage fails; preserve the stable ID.
      await live.refreshProfiles().catch(() => undefined);
      if (id === operation.current) setMessage("settings.profileError");
    } finally {
      if (secret.current) secret.current.value = "";
      setBusy(false);
    }
  }
  async function removeProfile(profileId: string) {
    if (locked) return;
    setBusy(true);
    setMessage(null);
    try {
      await profileStore.delete(profileId);
      const config = live.session.config;
      live.manager.configure({
        ...config,
        ...(config.providerId === profileId ? defaultConfig("") : {}),
        recognitionProfileId:
          config.recognitionProfileId === profileId
            ? undefined
            : config.recognitionProfileId,
        synthesisProfileId:
          config.synthesisProfileId === profileId
            ? undefined
            : config.synthesisProfileId,
      });
      await live.refreshProfiles();
      setManageId("");
      setRemoveId(null);
      setMessage("settings.profileRemoved");
    } catch {
      setMessage("settings.profileError");
    } finally {
      setBusy(false);
    }
  }
  async function removeProfileKey(profileId: string) {
    if (locked) return;
    setBusy(true);
    try {
      await profileStore.deleteKey(profileId);
      await live.refreshProfiles();
      setMessage("settings.keyRemoved");
    } catch {
      setMessage("settings.keyError");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h2>{t("settings.aiVoice")}</h2>
      <CompanionSetup live={live} setup={setup} disabled={locked} />
      {!definition.unavailable && (
        <label>
          {t("settings.model")}
          <select
            disabled={locked || definition.composed}
            value={live.session.config.model}
            onChange={(event) =>
              live.manager.configure({
                ...live.session.config,
                model: event.target.value,
              })
            }
          >
            {definition.models.map((model) => (
              <option key={model}>{model}</option>
            ))}
          </select>
        </label>
      )}
      {setup.saved && (
        <div className="controls">
          {setup.requiresKey && (
            <>
              <button
                disabled={locked}
                onClick={() => setup.setEditing(!setup.editing)}
              >
                {t(setup.editing ? "settings.cancelKey" : "settings.changeKey")}
              </button>
              <button disabled={locked} onClick={() => void setup.update(true)}>
                {t("settings.removeKey")}
              </button>
            </>
          )}
          <button
            disabled={locked}
            onClick={() => void live.manager.start(true)}
          >
            {t("settings.test")}
          </button>
        </div>
      )}
      {setup.requiresKey && setup.saved && setup.editing && (
        <KeyEditor setup={setup} disabled={locked} />
      )}
      {live.session.testResult && (
        <p role="status">
          {t(
            live.session.testResult === "Connection Successful"
              ? "settings.testSuccess"
              : providerNoticeKey(live.session.testResult),
          )}
        </p>
      )}
      {definition.composed && (
        <>
          <p className="help-text">{t("settings.composedVoice")}</p>
          {!definition.capabilities.imageInput && (
            <p role="status">{t("settings.noVision")}</p>
          )}
          <label>
            {t("settings.recognition")}
            <select
              disabled={locked}
              value={live.session.config.recognitionProfileId ?? ""}
              onChange={(event) =>
                live.manager.configure({
                  ...live.session.config,
                  recognitionProfileId: event.target.value || undefined,
                })
              }
            >
              <option value="">{t("settings.chooseRecognition")}</option>
              {recognizers.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("settings.synthesis")}
            <select
              disabled={locked}
              value={live.session.config.synthesisProfileId ?? ""}
              onChange={(event) =>
                live.manager.configure({
                  ...live.session.config,
                  synthesisProfileId: event.target.value || undefined,
                })
              }
            >
              <option value="">{t("settings.chooseSynthesis")}</option>
              {synthesizers.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("settings.speechLanguage")}
            <select
              disabled={locked}
              value={live.session.config.language ?? "en"}
              onChange={(event) =>
                live.manager.configure({
                  ...live.session.config,
                  language: event.target.value as "en" | "tr",
                })
              }
            >
              <option value="tr">Türkçe</option>
              <option value="en">English</option>
            </select>
          </label>
          {(!recognizers.some(
            (p) => p.id === live.session.config.recognitionProfileId,
          ) ||
            !synthesizers.some(
              (p) => p.id === live.session.config.synthesisProfileId,
            )) && <p role="status">{t("settings.recognitionNeeded")}</p>}
          <p className="help-text">
            {t("settings.voicePrivacy", {
              recognition:
                recognizers.find(
                  (p) => p.id === live.session.config.recognitionProfileId,
                )?.displayName ?? t("common.notConfigured"),
              reasoning: definition.displayName,
              synthesis:
                synthesizers.find(
                  (p) => p.id === live.session.config.synthesisProfileId,
                )?.displayName ?? t("common.notConfigured"),
            })}
          </p>
        </>
      )}
      <div className="controls">
        <button disabled={locked} onClick={() => edit(freshProfile())}>
          {t("settings.addProvider")}
        </button>
      </div>
      {live.profiles.length > 0 && (
        <>
          <label>
            {t("settings.manageProfiles")}
            <select
              value={manageId}
              disabled={locked}
              onChange={(event) => {
                setManageId(event.target.value);
                setRemoveId(null);
              }}
            >
              <option value="">{t("settings.chooseProfile")}</option>
              {live.profiles.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.displayName} — {p.model}
                </option>
              ))}
            </select>
          </label>
          {managed && (
            <div className="controls">
              <button disabled={locked} onClick={() => edit(managed)}>
                {t("settings.editProfile")}
              </button>
              <button disabled={locked} onClick={() => setRemoveId(managed.id)}>
                {t("common.delete")}
              </button>
            </div>
          )}
          {removeId && (
            <div role="alert">
              <p>{t("settings.deleteProfileConfirm")}</p>
              <div className="controls">
                <button
                  disabled={locked}
                  onClick={() => void removeProfile(removeId)}
                >
                  {t("common.delete")}
                </button>
                <button disabled={locked} onClick={() => setRemoveId(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
          }}
          aria-label={t("settings.configureProfile")}
        >
          <fieldset className="setup-fields" disabled={locked}>
            <legend>{t("settings.configureProfile")}</legend>
            <label>
              {t("settings.displayName")}
              <input
                required
                maxLength={100}
                value={draft.displayName}
                onChange={(event) =>
                  setDraft({ ...draft, displayName: event.target.value })
                }
              />
            </label>
            <label>
              {t("settings.integration")}
              <select
                disabled={existing || locked}
                value={draft.adapterType}
                onChange={(event) => {
                  const adapterType = event.target.value as AdapterType;
                  setDraft({
                    ...draft,
                    adapterType,
                    capabilities: profileCapabilities(adapterType),
                  });
                }}
              >
                <option value="openai-compatible">
                  {t("settings.compatibleProvider")}
                </option>
                <option value="anthropic">Anthropic Messages</option>
                <option value="openai-transcription">
                  {t("settings.recognitionService")}
                </option>
                <option value="openai-speech">
                  {t("settings.synthesisService")}
                </option>
              </select>
            </label>
            <label>
              {t("settings.endpoint")}
              <input
                required
                type="url"
                maxLength={2048}
                value={draft.baseUrl}
                readOnly={existing}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  setDraft({ ...draft, baseUrl: event.target.value })
                }
              />
            </label>
            <p className="help-text">
              {t(
                existing
                  ? "settings.endpointImmutable"
                  : "settings.endpointPolicy",
              )}
            </p>
            <label>
              {t("settings.model")}
              <input
                required
                maxLength={200}
                value={draft.model}
                onChange={(event) =>
                  setDraft({ ...draft, model: event.target.value })
                }
              />
            </label>
            <label>
              {t("settings.authentication")}
              <select
                disabled={existing || locked}
                value={draft.auth}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    auth: event.target.value as "none" | "apiKey",
                  })
                }
              >
                <option value="apiKey">{t("settings.key")}</option>
                <option value="none">{t("settings.noAuthentication")}</option>
              </select>
            </label>
            {draft.auth === "apiKey" && (
              <label>
                {t(existing ? "settings.replaceKeyOptional" : "settings.key")}
                <input
                  ref={secret}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  placeholder={existing ? "••••••••" : ""}
                />
              </label>
            )}
            {draft.adapterType === "openai-speech" && (
              <label>
                {t("settings.voice")}
                <input
                  required
                  maxLength={80}
                  value={draft.voice ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, voice: event.target.value })
                  }
                />
              </label>
            )}
            {isReasoningProfile(draft) && (
              <>
                <p className="help-text">
                  {t("settings.declaredCapabilities")}
                </p>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={draft.capabilities.vision}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        capabilities: {
                          ...draft.capabilities,
                          vision: event.target.checked,
                          multiImage:
                            event.target.checked &&
                            draft.capabilities.multiImage,
                        },
                      })
                    }
                  />
                  {t("settings.supportsVision")}
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    disabled={!draft.capabilities.vision || locked}
                    checked={draft.capabilities.multiImage}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        capabilities: {
                          ...draft.capabilities,
                          multiImage: event.target.checked,
                        },
                      })
                    }
                  />
                  {t("settings.supportsCompare")}
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={draft.capabilities.streaming}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        capabilities: {
                          ...draft.capabilities,
                          streaming: event.target.checked,
                        },
                      })
                    }
                  />
                  {t("settings.supportsStreaming")}
                </label>
              </>
            )}
            <div className="controls">
              <button type="submit">{t("common.save")}</button>
              <button type="button" onClick={closeEditor}>
                {t("common.cancel")}
              </button>
              {existing && draft.auth === "apiKey" && (
                <button
                  type="button"
                  onClick={() => void removeProfileKey(draft.id)}
                >
                  {t("settings.removeKey")}
                </button>
              )}
            </div>
          </fieldset>
        </form>
      )}
      {message && <p role="status">{t(message)}</p>}
      {disabled && <p className="help-text">{t("settings.sessionLocked")}</p>}
      <p className="help-text">{t("settings.keyPrivacy")}</p>
      <p className="help-text">{t("settings.compatibleScope")}</p>
    </section>
  );
}
