import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { useSession } from "../useSession";
import type { useRealtimeVoice } from "../hooks/useRealtimeVoice";
import type { useVisualTools } from "../hooks/useVisualTools";
import { VisualRoutingSettings } from "./VisualRoutingSettings";
const DeveloperTools = lazy(() =>
  import("./DeveloperTools").then((module) => ({
    default: module.DeveloperTools,
  })),
);
export function AdvancedOptions({
  capture,
  live,
  visual,
}: {
  capture: ReturnType<typeof useSession>;
  live: ReturnType<typeof useRealtimeVoice>;
  visual: ReturnType<typeof useVisualTools>;
}) {
  const { t } = useTranslation();
  return (
    <div className="advanced-content">
      <details>
        <summary>{t("settings.routing")}</summary>
        <VisualRoutingSettings live={live} developer />
      </details>
      <details>
        <summary>{t("settings.tools")}</summary>
        <Suspense fallback={<p>{t("settings.loadingTools")}</p>}>
          <DeveloperTools capture={capture} live={live} visual={visual} />
        </Suspense>
      </details>
    </div>
  );
}
