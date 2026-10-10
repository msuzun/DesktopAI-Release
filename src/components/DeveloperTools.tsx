import type { useSession } from "../useSession";
import { useTranslation } from "react-i18next";
import type { useRealtimeVoice } from "../hooks/useRealtimeVoice";
import type { useVisualTools } from "../hooks/useVisualTools";
import { useObserver } from "../hooks/useObserver";
import { VoiceDiagnostics } from "./LiveAI/VoiceDiagnostics";
import { VisualDiagnostics } from "./VisualDiagnostics";
import { ScreenshotPreview } from "./ScreenshotPreview";
import { DebugPanel } from "./DebugPanel";
import { ObserverPanel } from "./ObserverPanel";
import { ChangeDetectionPanel } from "./ChangeDetectionPanel";
import { CaptureDiagnostics } from "./CaptureDiagnostics";
import { TemporalContextDiagnostics } from "./TemporalContextDiagnostics";
import { VisualRoutingDiagnostics } from "./VisualRoutingSettings";
export function DeveloperTools({
  capture,
  live,
  visual,
}: {
  capture: ReturnType<typeof useSession>;
  live: ReturnType<typeof useRealtimeVoice>;
  visual: ReturnType<typeof useVisualTools>;
}) {
  const { t } = useTranslation();
  const observer = useObserver(capture.active && !capture.transitioning);
  return (
    <section className="developer-tools" aria-label={t("developer.title")}>
      <h3>{t("developer.title")}</h3>
      <p className="help-text">{t("developer.legacyPanels")}</p>
      <CaptureDiagnostics
        active={visual.allowed && capture.active}
        locked={live.manager.locked || capture.testing || capture.transitioning}
      />
      <VoiceDiagnostics controls={live} />
      <VisualRoutingDiagnostics live={live} />
      <VisualDiagnostics visual={visual} />
      <TemporalContextDiagnostics />
      <button
        disabled={
          visual.turn.state !== "USER_SPEAKING" &&
          live.voice.conversation !== "User Speaking"
        }
        onClick={visual.finishVoiceTurn}
      >
        {t("developer.finishTurn")}
      </button>
      <details className="voice-debug">
        <summary>{t("developer.capture")}</summary>
        <p>{t("developer.captureNote")}</p>
        <div className="controls">
          <button
            disabled={
              capture.testing ||
              capture.transitioning ||
              capture.capturing ||
              live.session.state === "Connecting" ||
              !!live.session.freshBusy
            }
            onClick={() => void capture.testCapture("context")}
          >
            {t("developer.captureScreen")}
          </button>
          <button
            disabled={
              capture.testing ||
              capture.transitioning ||
              capture.capturing ||
              live.session.state === "Connecting" ||
              !!live.session.freshBusy
            }
            onClick={() => void capture.testCapture("detail")}
          >
            {t("developer.captureDetail")}
          </button>
        </div>
        {capture.error && <p role="alert">{capture.error}</p>}
        <ScreenshotPreview
          frame={capture.frame}
          capturing={capture.capturing}
          observation={observer.snapshot}
        />
        <DebugPanel frame={capture.frame} />
        <ChangeDetectionPanel frame={capture.frame} />
        <ObserverPanel
          active={capture.active}
          snapshot={observer.snapshot}
          error={observer.error}
          frame={capture.frame}
        />
      </details>
    </section>
  );
}
