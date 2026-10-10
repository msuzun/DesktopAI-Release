import type { useRealtimeVoice } from "../hooks/useRealtimeVoice";
import type { useAISetup } from "../hooks/useAISetup";
import { useTranslation } from "react-i18next";
import {
  defaultConfig,
  providerDefinition,
  providerDefinitions,
} from "../providers/realtime/ProviderRegistry";
export function KeyEditor({
  setup,
  disabled,
}: {
  setup: ReturnType<typeof useAISetup>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="key-editor">
      <label>
        {t("settings.key")}
        <input
          ref={setup.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          disabled={disabled}
          placeholder={t("settings.keyPlaceholder")}
        />
      </label>
      <button disabled={disabled} onClick={() => void setup.update()}>
        {t("common.save")}
      </button>
    </div>
  );
}
export function CompanionSetup({
  live,
  setup,
  disabled,
}: {
  live: ReturnType<typeof useRealtimeVoice>;
  setup: ReturnType<typeof useAISetup>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const config = live.session.config;
  const definition = providerDefinition(config.providerId);
  return (
    <section aria-label={t("settings.provider")}>
      <fieldset className="setup-fields" disabled={disabled}>
        <label>
          {t("settings.provider")}
          <select
            value={config.providerId}
            onChange={(e) =>
              live.manager.configure({
                ...config,
                ...defaultConfig(e.target.value),
              })
            }
          >
            <option value="">{t("settings.chooseProvider")}</option>
            {providerDefinitions.map((p) => (
              <option value={p.id} key={p.id} disabled={p.unavailable}>
                {p.displayName}
                {p.unavailable ? ` — ${t("common.unavailable")}` : ""}
              </option>
            ))}
          </select>
        </label>
        {definition.voices.length > 1 && (
          <label>
            {t("settings.voice")}
            <select
              value={config.voice}
              onChange={(e) =>
                live.manager.configure({ ...config, voice: e.target.value })
              }
            >
              {definition.voices.map((voice) => (
                <option key={voice}>{voice}</option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
      {setup.requiresKey && setup.saved === false && (
        <KeyEditor setup={setup} disabled={disabled} />
      )}
      <p className="setup-status">
        {definition.unavailable
          ? t("settings.chooseProvider")
          : !setup.requiresKey
            ? t("settings.noKeyNeeded")
            : setup.saved === null
              ? t("settings.keyChecking")
              : setup.saved
                ? t("common.configured")
                : t("settings.keyMissing")}
      </p>
      {setup.message && (
        <p role="status">
          {t(
            setup.message === "API key saved securely."
              ? "settings.keySaved"
              : setup.message === "API key removed."
                ? "settings.keyRemoved"
                : setup.message.startsWith("Secure key storage")
                  ? "settings.keyUnavailable"
                  : "settings.keyError",
          )}
        </p>
      )}
    </section>
  );
}
