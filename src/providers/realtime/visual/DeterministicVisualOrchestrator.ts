import {
  releaseContext,
  type TemporalContextClient,
  type ContextEnvelope,
} from "./TemporalContext.js";
import type { VisualContext, VisualRequest } from "./types.js";
import type {
  VisualInspectionRequest,
  VisualInspectionResult,
} from "./VisualInspection.js";

type Capture = (
  max: number,
  request: VisualRequest,
  signal?: AbortSignal,
) => Promise<VisualContext>;
const fatal = new Set([
  "cancelled",
  "permission_denied",
  "generation_changed",
  "visual_session_inactive",
]);
const knownErrors = new Set([
  ...fatal,
  "snapshot_expired",
  "snapshot_required",
  "current_unavailable",
  "history_unavailable",
  "invalid_region",
  "invalid_arguments",
  "visual_limit_reached",
  "visual_busy",
  "image_too_large",
  "readback_failed",
  "encoding_failed",
  "capture_failed",
]);
function code(error: unknown): string {
  const value =
    error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof value === "string" && knownErrors.has(value)
    ? value
    : "capture_failed";
}

// Composes native primitives only. No provider protocol, language routing, polling,
// image cache, or independent snapshot ownership belongs here.
export class DeterministicVisualOrchestrator {
  constructor(
    private capture: Capture,
    private temporal?: TemporalContextClient,
  ) {}
  async inspect(
    request: VisualInspectionRequest,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<VisualContext> {
    const started = performance.now();
    const owned: VisualContext[] = [];
    const output: VisualContext[] = [];
    const validators: (() => Promise<void>)[] = [];
    let base: ContextEnvelope | undefined;
    const result: VisualInspectionResult = {
      intent: request.mode,
      status: "Complete",
      turnId: "",
      referenceTimeUnixMs: 0,
      snapshots: [],
      events: [],
      warnings: [],
      operations: [],
      timings: {},
      work: { imagesPrepared: 0, imagesReused: 0, encodedBytesPrepared: 0 },
    };
    const check = () => {
      if (signal.aborted) throw { code: "cancelled" };
    };
    const run = async (operation: string, primitive: VisualRequest) => {
      check();
      result.operations.push(operation);
      const at = performance.now();
      try {
        const context = await this.capture(maxBytes, primitive, signal);
        owned.push(context);
        result.work.imagesPrepared +=
          context.frames?.length ?? Number(!!context.base64);
        result.work.encodedBytesPrepared += context.metadata.encodedSizeBytes;
        for (const [stage, duration] of Object.entries(
          context.context?.timings ?? {},
        )) {
          result.timings[`${operation}.${stage}`] =
            (result.timings[`${operation}.${stage}`] ?? 0) + duration;
        }
        check();
        if (context.context) base ??= context.context;
        return context;
      } finally {
        result.timings[operation] =
          (result.timings[operation] ?? 0) + performance.now() - at;
      }
    };
    const accept = (
      context: VisualContext,
      role: "Current" | "Historical" | "FollowUpHistorical",
      exact = false,
    ) => {
      output.push(context);
      if (context.validate) validators.push(context.validate);
      for (const { base64: _, ...frame } of context.frames ?? [])
        result.snapshots.push({
          ...frame,
          temporalRole: role,
          quality: exact ? "Exact" : role === "Current" ? "Context" : "Recent",
          reused: false,
        });
    };
    const failure = (error: unknown) => {
      const reason = code(error);
      if (fatal.has(reason)) throw error;
      result.warnings.push(reason);
    };
    const current = async (exact: boolean) => {
      const delivered = this.temporal?.deliveredCurrent();
      if (delivered) {
        base ??= delivered;
        result.operations.push("current_reused");
        if (exact) {
          accept(
            await run("exact_preparation", {
              kind: "detail",
              snapshotId: delivered.frames[0].snapshotId,
              region: request.region,
            }),
            "Current",
            true,
          );
        } else {
          result.work.imagesReused += delivered.frames.length;
          validators.push(() =>
            this.temporal!.validateDeliveredCurrent(signal),
          );
          result.snapshots.push(
            ...delivered.frames.map((f) => ({
              ...f,
              temporalRole: "Current" as const,
              quality: "Context" as const,
              reused: true,
            })),
          );
        }
        return;
      }
      const c = await run("current_resolution", { kind: "current" });
      if (exact && !c.frames?.[0]) throw { code: "snapshot_required" };
      if (exact && c.frames?.[0]) {
        // Escalate the owned source, never the overview delivery bytes.
        accept(
          await run("exact_preparation", {
            kind: "detail",
            snapshotId: c.frames[0].snapshotId,
            region: request.region,
          }),
          "Current",
          true,
        );
      } else accept(c, "Current", exact);
    };
    const recent = async (exact: boolean, compare: boolean) => {
      const history = await run("recent_query", {
        kind: "recent",
        lookbackMs: request.lookbackMs,
        maxKeyframes: exact || compare ? 2 : 3,
      });
      result.events = history.context?.events ?? [];
      result.warnings.push(...(history.context?.warnings ?? []));
      if (
        history.context?.completeness === "Partial" &&
        result.status === "Complete"
      )
        result.status = "Partial";
      const frames = history.frames ?? [];
      if (!frames.length) {
        result.warnings.push("history_unavailable");
        return;
      }
      // Preserve native ranking: transient evidence precedes stable background.
      // Multiple snapshots of that same priority are explicitly ambiguous.
      const transient = frames.filter((f) => f.origin === "RecentTransient");
      const candidates = transient.length ? transient : frames;
      const ambiguous = candidates.length > 1;
      if (ambiguous && (exact || compare)) result.status = "Ambiguous";
      if (!ambiguous) result.followUpSnapshotId = candidates[0].snapshotId;
      if (exact) {
        for (const frame of candidates.slice(0, 2)) {
          try {
            accept(
              await run("exact_preparation", {
                kind: "detail",
                snapshotId: frame.snapshotId,
                region: request.region,
              }),
              "Historical",
              true,
            );
          } catch (error) {
            failure(error);
          }
        }
      } else if (compare) {
        // One historical attachment. Other candidates remain explicit metadata.
        const frame = candidates[0];
        accept(
          {
            ...history,
            frames: [frame],
            context: history.context && {
              ...history.context,
              frames: history.context.frames.filter(
                (f) => f.snapshotId === frame.snapshotId,
              ),
            },
          },
          "Historical",
        );
        if (ambiguous)
          result.warnings.push(
            "Historical focus is ambiguous; other candidate snapshots: " +
              candidates
                .slice(1)
                .map((f) => f.snapshotId)
                .join(", "),
          );
      } else accept(history, "Historical");
    };
    try {
      switch (request.mode) {
        case "current":
          await current(false);
          break;
        case "current_exact":
          await current(true);
          break;
        case "recent":
          await recent(false, false);
          break;
        case "recent_exact":
          await recent(true, false);
          break;
        case "compare_recent_current":
          // Secure turn Current before historical preparation can consume its age budget.
          result.operations.push("compare");
          try {
            await current(false);
          } catch (error) {
            failure(error);
          }
          try {
            await recent(false, true);
          } catch (error) {
            failure(error);
          }
          break;
        case "follow_up_exact": {
          result.operations.push("follow_up_resolution");
          const at = performance.now();
          const reference = await this.temporal?.followUp(signal);
          result.timings.follow_up_resolution = performance.now() - at;
          check();
          if (!reference) {
            result.status = "Expired";
            result.warnings.push("follow_up_expired");
            break;
          }
          result.followUpReference = reference;
          accept(
            await run("exact_preparation", {
              kind: "detail",
              snapshotId: reference.snapshotId,
              region: request.region,
            }),
            "FollowUpHistorical",
            true,
          );
          break;
        }
      }
    } catch (error) {
      try {
        failure(error);
      } catch (fatalError) {
        owned.forEach(releaseContext);
        throw fatalError;
      }
      if (
        request.mode === "follow_up_exact" &&
        code(error) === "snapshot_expired"
      )
        result.status = "Expired";
    }
    try {
      check();
      result.turnId = base?.turnId ?? this.temporal?.turnId() ?? "";
      result.referenceTimeUnixMs = base?.referenceTimeUnixMs ?? 0;
      const hasCurrent = result.snapshots.some(
        (f) => f.temporalRole === "Current",
      );
      const hasHistorical = result.snapshots.some(
        (f) => f.temporalRole !== "Current",
      );
      if (
        !result.snapshots.length &&
        !output.some((c) => c.base64) &&
        result.status !== "Expired"
      )
        result.status = "Unavailable";
      else if (
        result.status === "Complete" &&
        ((request.mode === "compare_recent_current" &&
          (!hasCurrent || !hasHistorical)) ||
          result.warnings.length)
      )
        result.status = "Partial";
      if (
        !result.snapshots.some(
          (f) => f.snapshotId === result.followUpSnapshotId,
        )
      )
        result.followUpSnapshotId = undefined;
      const frames = output
        .flatMap((c) => c.frames ?? [])
        .map((f) => ({ ...f }));
      const legacy = output.find((c) => !c.context);
      const validate = async () => {
        check();
        for (const v of validators) {
          await v();
          check();
        }
      };
      const context: ContextEnvelope | undefined = base && {
        ...base,
        kind:
          request.mode === "compare_recent_current"
            ? "recent"
            : (output[0]?.context?.kind ?? base.kind),
        frames: frames.map(({ base64: _, ...f }) => f),
        events: result.events,
        completeness:
          result.status === "Complete"
            ? "Complete"
            : result.status === "Unavailable" || result.status === "Expired"
              ? "Empty"
              : "Partial",
        warnings: result.warnings,
      };
      result.timings.totalMs = performance.now() - started;
      const assembled: VisualContext = {
        ...(legacy ?? output[0]),
        preparation: {
          requestedAt: started,
          startedAt: started,
          readyAt: performance.now(),
        },
        inspection: result,
        context,
        frames,
        kind: context?.kind ?? "current",
        base64: frames[0]?.base64 ?? legacy?.base64 ?? "",
        mimeType: frames[0]?.mimeType ?? legacy?.mimeType ?? "image/jpeg",
        width: frames[0]?.width ?? legacy?.width ?? 0,
        height: frames[0]?.height ?? legacy?.height ?? 0,
        timestampUnixMs:
          frames[0]?.timestampUnixMs ?? legacy?.timestampUnixMs ?? Date.now(),
        source: "PrimaryDisplay",
        metadata: legacy?.metadata ?? {
          captureDurationMs: 0,
          encodingDurationMs: owned.reduce(
            (n, c) => n + c.metadata.encodingDurationMs,
            0,
          ),
          encodedSizeBytes: frames.reduce((n, f) => n + f.encodedSizeBytes, 0),
          changeScore: null,
          threshold: 0,
        },
        validate,
      };
      // Prepared overview bytes never survive exact escalation. No encoded cache.
      owned.filter((c) => c !== legacy).forEach(releaseContext);
      return assembled;
    } catch (error) {
      owned.forEach(releaseContext);
      throw error;
    }
  }
}
