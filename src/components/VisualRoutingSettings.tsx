import type { useRealtimeVoice } from "../hooks/useRealtimeVoice";
import { useTranslation } from "react-i18next";
type Live = ReturnType<typeof useRealtimeVoice>;
export function VisualRoutingSettings({
  live,
}: {
  live: Live;
  developer: boolean;
}) {
  const { t } = useTranslation();
  const r = live.routing;
  return (
    <section aria-label={t("developer.routing")}>
      <h3>{t("developer.routing")}</h3>
      <p>
        <strong>{t("developer.laya")}</strong>
      </p>
      <p className="help-text">{t("developer.layaBetaNotice")}</p>
      <label>
        {t("settings.routingEngine")}
        <select
          value={r.policy.preferred}
          onChange={(e) => r.configure({ preferred: e.target.value })}
        >
          <option value="Auto">{t("settings.auto")}</option>
          {r.available.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <p>{t("settings.routingNote")}</p>
      <details>
        <summary>
          {t("developer.laya")} — {r.laya.state}
        </summary>
        <p>{t("developer.installNote")}</p>
        <label>
          {t("developer.python")}
          <input
            value={r.layaConfig.pythonPath}
            onChange={(e) =>
              r.updateConfig({ ...r.layaConfig, pythonPath: e.target.value })
            }
            placeholder={t("developer.pythonPath")}
          />
        </label>
        <label>
          {t("developer.modelPath")}
          <input
            value={r.layaConfig.modelPath}
            onChange={(e) =>
              r.updateConfig({ ...r.layaConfig, modelPath: e.target.value })
            }
            placeholder={t("developer.modelPathHint")}
          />
        </label>
        <label>
          {t("developer.checkpoint")}
          <select
            value={r.layaConfig.checkpoint}
            onChange={(e) =>
              r.updateConfig({
                ...r.layaConfig,
                checkpoint: e.target.value as typeof r.layaConfig.checkpoint,
              })
            }
          >
            <option value="multilingual">{t("developer.multilingual")}</option>
            <option value="english">{t("developer.english")}</option>
            <option value="typed-decisions">{t("developer.typed")}</option>
          </select>
        </label>
        <label>
          {t("developer.device")}
          <select
            value={r.layaConfig.device}
            onChange={(e) =>
              r.updateConfig({
                ...r.layaConfig,
                device: e.target.value as "cpu" | "cuda",
              })
            }
          >
            <option value="cpu">CPU</option>
            <option value="cuda">{t("developer.cuda")}</option>
          </select>
        </label>
        <div className="controls">
          <button
            disabled={r.laya.state === "Loading"}
            onClick={() => void r.prepare()}
          >
            {t("developer.prepare")}
          </button>
          <button onClick={() => void r.unload()}>
            {t("developer.unload")}
          </button>
        </div>
        <p>
          {r.laya.reason ?? ""}{" "}
          {r.laya.details &&
            `${r.laya.details.checkpoint}; ${r.laya.details.device}; load ${r.laya.details.loadMs.toFixed(0)} ms; private memory ${(r.laya.details.memory.privateBytes / 1048576).toFixed(0)} MiB`}
        </p>
      </details>
      {r.error && <p role="status">{t("developer.error")}</p>}
    </section>
  );
}
export function VisualRoutingDiagnostics({ live }: { live: Live }) {
  return (
    <details className="voice-debug">
      <summary>Visual routing diagnostics</summary>
      <p>
        Screen context mode: {live.routing.mode}; semantic engine selection:{" "}
        {live.routing.policy.preferred}; readiness:{" "}
        {live.routing.readiness.code}.
      </p>
      {live.routing.available.map((e) => (
        <p key={e.id}>
          {e.label}: {e.health.state} {e.health.reason ?? ""}
        </p>
      ))}
      <p>
        Local runtime: {live.routing.laya.state}; active:{" "}
        {live.routing.laya.activeRequests}; queued:{" "}
        {live.routing.laya.queuedRequests}.
      </p>
      <p>
        Last attempt trace:{" "}
        {live.routing.attempts
          .map(
            (a) =>
              `${a.engine}: ${a.failure ?? "success"} (${a.durationMs.toFixed(0)} ms)`,
          )
          .join(" → ") || "none"}
        .
      </p>
    </details>
  );
}
