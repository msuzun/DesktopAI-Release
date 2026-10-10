import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { useActions } from "../hooks/useActions";

export function ActionSettings({
  actions,
}: {
  actions: ReturnType<typeof useActions>;
}) {
  const { t } = useTranslation();
  const key = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function saveKey(remove = false) {
    if (busy) return;
    setBusy(true);
    try {
      if (remove) await invoke("jev_delete_key");
      else await invoke("jev_save_key", { secret: key.current?.value ?? "" });
      setMessage(remove ? "developer.jevRemoved" : "developer.jevSaved");
    } catch {
      setMessage("developer.jevError");
    } finally {
      if (key.current) key.current.value = "";
      await actions.refresh();
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-label={t("actions.title")}>
      <h2>{t("actions.title")}</h2>
      <p>
        <strong>{t("actions.beta")}</strong>
      </p>
      <p className="help-text">{t("actions.betaNotice")}</p>
      <label className="toggle">
        <input
          type="checkbox"
          checked={actions.status.enabled}
          disabled={actions.busy}
          onChange={(event) => void actions.configure(event.target.checked)}
        />
        {t("actions.enable")}
      </label>
      <p>{t("actions.notice")}</p>
      {!actions.status.executionAvailable && (
        <p role="status">{t("actions.validationPending")}</p>
      )}
      {actions.error && <p role="alert">{t("actions.error")}</p>}
      <details>
        <summary>{t("developer.jev")}</summary>
        <p>{t("developer.jevNotice")}</p>
        <label>
          {t("developer.jevKey")}
          <input
            ref={key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            placeholder={t("developer.jevKeyHint")}
          />
        </label>
        <div className="controls">
          <button disabled={busy} onClick={() => void saveKey()}>
            {t("developer.jevSave")}
          </button>
          <button disabled={busy} onClick={() => void saveKey(true)}>
            {t("developer.jevRemove")}
          </button>
        </div>
        <p>{t("developer.jevKeyNotice")}</p>
        {message && <p role="status">{t(message)}</p>}
      </details>
    </section>
  );
}
