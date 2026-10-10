import { useTranslation } from "react-i18next";
import type { useActions } from "../hooks/useActions";
import { Dialog } from "./Dialog";

export function ActionConfirmation({
  actions,
}: {
  actions: ReturnType<typeof useActions>;
}) {
  const { t } = useTranslation();
  const candidate = actions.candidate;
  if (!candidate)
    return actions.confirmationMessage ? (
      <p role="status">{actions.confirmationMessage}</p>
    ) : null;
  return (
    <Dialog
      key={candidate.id}
      title={t("actions.confirmTitle")}
      busy={actions.confirmationBusy}
      onClose={() => actions.reject(candidate)}
    >
      <p>{t("actions.confirmNotice")}</p>
      <dl className="action-candidate-details">
        <dt>{t("actions.kind")}</dt>
        <dd>{t(`actions.kinds.${candidate.kind}`)}</dd>
        <dt>{t("actions.executable")}</dt>
        <dd>
          <code>{candidate.executable}</code>
        </dd>
        <dt>{t("actions.arguments")}</dt>
        <dd>
          <code>{JSON.stringify(candidate.args)}</code>
        </dd>
        <dt>{t("actions.workingDirectory")}</dt>
        <dd>
          <code>{candidate.workingDirectory}</code>
        </dd>
        {candidate.content !== undefined && (
          <>
            <dt>{t("actions.content")}</dt>
            <dd>
              <pre className="action-candidate-content">
                {candidate.content}
              </pre>
            </dd>
          </>
        )}
        <dt>{t("actions.expires")}</dt>
        <dd>{new Date(candidate.expiresAtUnixMs).toLocaleTimeString()}</dd>
      </dl>
      <details>
        <summary>{t("actions.identity")}</summary>
        <dl className="action-candidate-details">
          <dt>{t("actions.candidateId")}</dt>
          <dd>
            <code>{candidate.id}</code>
          </dd>
          <dt>{t("actions.digest")}</dt>
          <dd>
            <code>{candidate.digest}</code>
          </dd>
          <dt>{t("actions.executableHash")}</dt>
          <dd>
            <code>{candidate.executableSha256}</code>
          </dd>
          <dt>{t("actions.turn")}</dt>
          <dd>
            <code>{candidate.turnId}</code>
          </dd>
        </dl>
      </details>
      {!actions.status.executionAvailable && (
        <p role="status">{t("actions.validationPending")}</p>
      )}
      <div className="controls">
        <button
          autoFocus
          disabled={actions.confirmationBusy}
          onClick={() => actions.reject(candidate)}
        >
          {t("actions.reject")}
        </button>
        <button
          disabled={
            actions.confirmationBusy ||
            !actions.status.enabled ||
            !actions.status.executionAvailable
          }
          onClick={() => void actions.confirm(candidate)}
        >
          {t("actions.confirm")}
        </button>
      </div>
    </Dialog>
  );
}
