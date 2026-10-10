import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./Dialog";
import { memoryApi, type MemorySettings } from "./memoryApi";
import type { MemoryController } from "./useMemory";
export function MemoryConsent({
  memory,
  onClose,
}: {
  memory: MemoryController;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const settings = memory.status?.settings;
  const [storageMode, setStorageMode] = useState<MemorySettings["storageMode"]>(
    settings?.storageMode ?? "metadata",
  );
  return (
    <Dialog
      title={t("memory.consentTitle")}
      onClose={onClose}
      busy={memory.busy}
    >
      <p>{t("memory.consent")}</p>
      <p>{t("memory.consentSharing")}</p>
      <label>
        {t("memory.storageMode")}
        <select
          value={storageMode}
          onChange={(event) =>
            setStorageMode(event.target.value as MemorySettings["storageMode"])
          }
        >
          <option value="metadata">{t("memory.metadata")}</option>
          <option value="thumbnail">{t("memory.thumbnail")}</option>
          <option value="visual">{t("memory.visual")}</option>
        </select>
      </label>
      <p>{t("memory.modeHelp")}</p>
      <p>
        {t("memory.consentPolicy", {
          days: settings?.retentionDays ?? 7,
          size: settings?.storageLimitMb ?? 256,
        })}
      </p>
      <p className="privacy-callout">{t("settings.encryption")}</p>
      {memory.error && (
        <p role="alert" className="error">
          {t(memory.error)}
        </p>
      )}
      <div className="controls">
        <button disabled={memory.busy} onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          className="primary"
          disabled={memory.busy || !settings}
          onClick={async () => {
            if (
              settings &&
              (await memory.configure({
                ...settings,
                mode: "manual",
                automaticMemoryEnabled: false,
                storageMode,
                paused: false,
              }))
            )
              onClose();
          }}
        >
          {t("memory.consentConfirm")}
        </button>
      </div>
    </Dialog>
  );
}
export function RememberDialog({
  memory,
  onClose,
}: {
  memory: MemoryController;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  return (
    <Dialog
      title={t("memory.rememberTitle")}
      onClose={onClose}
      busy={memory.busy}
    >
      <p>{t("memory.rememberDescription")}</p>
      <p className="privacy-callout">
        {t("memory.storageMode")}:{" "}
        {t(`memory.${memory.status?.settings.storageMode ?? "metadata"}`)}
      </p>
      <label>
        {t("memory.labelOptional")}
        <input
          autoFocus
          maxLength={160}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t("memory.labelPlaceholder")}
        />
      </label>
      {memory.error && (
        <p className="error" role="alert">
          {t(memory.error)}
        </p>
      )}
      <div className="controls">
        <button disabled={memory.busy} onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          className="primary"
          disabled={memory.busy}
          onClick={async () => {
            if (
              await memory.run(() => memoryApi.remember(label.trim() || null))
            )
              onClose();
          }}
        >
          {memory.busy ? t("common.working") : t("memory.rememberConfirm")}
        </button>
      </div>
    </Dialog>
  );
}
export function MemoryState({
  memory,
  onEnable,
}: {
  memory: MemoryController;
  onEnable: () => void;
}) {
  const { t } = useTranslation();
  const status = memory.status;
  const enabled = status?.settings.mode === "manual";
  return (
    <div className="memory-state">
      <div>
        <span className="eyebrow">{t("memory.state")}</span>
        <h3>
          {!status
            ? t("common.unavailable")
            : !enabled
              ? t("common.off")
              : status.settings.paused
                ? t("common.paused")
                : t(
                    status.settings.automaticMemoryEnabled
                      ? "memory.automatic"
                      : "memory.manual",
                  )}
        </h3>
        <p>
          {!enabled
            ? t("memory.disabledDescription")
            : status?.settings.paused
              ? t("memory.pausedDescription")
              : t(
                  status?.settings.automaticMemoryEnabled
                    ? "memory.automaticDescription"
                    : "memory.manualDescription",
                )}
        </p>
      </div>
      <div className="controls">
        {!enabled ? (
          <button
            className="primary"
            disabled={memory.busy || !status || status.health !== "ready"}
            onClick={onEnable}
          >
            {t("memory.enable")}
          </button>
        ) : (
          <>
            <button
              disabled={memory.busy}
              onClick={() =>
                void memory.configure({
                  ...status!.settings,
                  paused: !status!.settings.paused,
                })
              }
            >
              {t(status!.settings.paused ? "memory.resume" : "memory.pause")}
            </button>
            <button
              disabled={memory.busy}
              onClick={() =>
                void memory.configure({ ...status!.settings, mode: "off" })
              }
            >
              {t("memory.disable")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
export function MemorySettingsForm({
  memory,
  onEnable,
}: {
  memory: MemoryController;
  onEnable: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MemorySettings | null>(null);
  const [saved, setSaved] = useState(false);
  const settings = memory.status?.settings;
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [
    settings?.storageMode,
    settings?.retentionDays,
    settings?.storageLimitMb,
    settings?.mode,
    settings?.paused,
    settings?.automaticMemoryEnabled,
  ]);
  return (
    <section className="settings-section">
      <h2>{t("memory.titleShort")}</h2>
      <MemoryState memory={memory} onEnable={onEnable} />
      {draft && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (await memory.configure(draft)) setSaved(true);
          }}
        >
          <fieldset disabled={memory.busy} className="settings-fields">
            <label>
              {t("memory.storageMode")}
              <select
                value={draft.storageMode}
                onChange={(event) => {
                  setSaved(false);
                  setDraft({
                    ...draft,
                    storageMode: event.target
                      .value as MemorySettings["storageMode"],
                  });
                }}
              >
                <option value="visual">{t("memory.visual")}</option>
                <option value="thumbnail">{t("memory.thumbnail")}</option>
                <option value="metadata">{t("memory.metadata")}</option>
              </select>
            </label>
            <label>
              {t("memory.retention")}
              <select
                value={draft.retentionDays}
                onChange={(event) => {
                  setSaved(false);
                  setDraft({
                    ...draft,
                    retentionDays: Number(event.target.value),
                  });
                }}
              >
                {[1, 7, 30, 90].map((days) => (
                  <option key={days} value={days}>
                    {days === 1
                      ? t("memory.day")
                      : t("memory.days", { count: days })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("memory.storageLimit")}
              <input
                type="number"
                min={16}
                max={4096}
                step={1}
                required
                value={draft.storageLimitMb}
                onChange={(event) => {
                  setSaved(false);
                  setDraft({
                    ...draft,
                    storageLimitMb: Number(event.target.value),
                  });
                }}
              />
            </label>
          </fieldset>
          <p className="help-text">{t("memory.modeHelp")}</p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.automaticMemoryEnabled === true}
              disabled={memory.busy || draft.mode === "off"}
              onChange={(event) => {
                setSaved(false);
                setDraft({
                  ...draft,
                  automaticMemoryEnabled: event.target.checked,
                });
              }}
            />
            {t("memory.automaticSetting")}
          </label>
          <p className="help-text">{t("memory.automaticDescription")}</p>
          <p className="help-text">{t("memory.bookmarkNote")}</p>
          <button disabled={memory.busy}>{t("memory.settingsSave")}</button>
          {saved && <p role="status">{t("memory.settingsSaved")}</p>}
        </form>
      )}
      <p className="privacy-callout">{t("settings.encryption")}</p>
      <h3>{t("settings.storageLocation")}</h3>
      <p>{t("settings.storageLocationNote")}</p>
      {memory.status?.storageLocation && (
        <code className="storage-path">{memory.status.storageLocation}</code>
      )}
    </section>
  );
}
