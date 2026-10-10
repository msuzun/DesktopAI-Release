import { DeterministicVisualOrchestrator } from "./DeterministicVisualOrchestrator.js";
import {
  inspectionRequest,
  type VisualInspectionRequest,
  type VisualInspectionResult,
} from "./VisualInspection.js";
import config from "./config.json" with { type: "json" };
import {
  releaseContext,
  type TemporalContextClient,
} from "./TemporalContext.js";
import type { ProviderCapabilities } from "../ProviderRegistry.js";
import type {
  VisualRequest,
  ToolCall,
  ToolResult,
  ToolStatus,
  VisualContext,
  VisualDelivery,
} from "./types.js";
export interface VisualPolicy {
  aiActive: boolean;
  visualActive: boolean;
  allowed: boolean;
  provider: string;
  capabilities: ProviderCapabilities;
}
export interface ToolPort {
  active(): boolean;
  maxImageBytes(): number;
  sendVisual(
    context: VisualContext,
    signal: AbortSignal,
  ): Promise<VisualDelivery>;
  sendResult(call: ToolCall, result: ToolResult): void;
}
export interface VisualDebug {
  inspection?: VisualInspectionResult;
  counts?: Record<string, number>;
  tool: string;
  provider: string;
  reason: string;
  requestedAt: number;
  kind: VisualRequest["kind"];
  capturedAt?: number;
  sentAt?: number;
  status: string;
  result: ToolStatus | null;
  sent: boolean;
  acknowledgment: string;
  metadata: VisualContext["metadata"] | null;
}
const messages: Record<ToolStatus, string> = {
  snapshot_expired:
    "That visual moment expired. No replacement image was supplied.",
  snapshot_required:
    "The required visual source is unavailable. No replacement image was supplied.",
  current_unavailable:
    "No sufficiently recent Current image is available. Do not infer current screen contents.",
  history_unavailable:
    "Recent visual history is unavailable. Do not infer past screen contents.",
  invalid_region: "Detail requires a positive normalized region within [0,1].",
  visual_limit_reached:
    "The visual request limit for this turn was reached. Do not loop.",
  generation_changed: "Visual sources changed; old context is unavailable.",
  readback_failed: "The selected visual moment could not be read.",
  encoding_failed: "The selected visual moment could not be prepared.",
  visual_busy: "Visual preparation is busy. No additional work was queued.",
  unchanged:
    "Image is identical to the last supplied visual frame. Reuse that image; no new image was uploaded.",
  success:
    "Visual context was supplied. Use its roles, timestamps, completeness and snapshot identifiers; historical evidence does not describe the current screen.",
  visual_session_inactive:
    "Screen awareness is off. No new image was supplied. Do not claim to see the current desktop. The user can enable Screen Awareness before starting the companion.",
  permission_denied:
    "Screen awareness is off. No new image was supplied. Do not claim to see the current desktop. The user can enable Screen Awareness before starting the companion.",
  capture_in_progress:
    "Another capture is in progress. No new image was supplied.",
  rate_limited:
    "Visual request rate limit reached. Do not loop; wait for a new user request.",
  capture_failed:
    "Screen capture failed. No new image was supplied. Do not infer what is on screen.",
  provider_visual_input_unsupported:
    "This provider does not support image input.",
  provider_function_calling_unsupported:
    "This provider does not support function calling.",
  ai_session_inactive: "The AI session is inactive.",
  invalid_arguments:
    "Invalid visual inspection arguments. operation, source and precision are required. Supported combinations: inspect/current or recent with overview or exact; inspect/previous_reference/exact; compare/recent/overview. Optional lookback and region must be within bounds.",
  unknown_tool:
    "Unknown tool. Only inspect_visual_context is available; no action was taken.",
  cancelled:
    "The visual request was cancelled. Do not assume new visual context.",
  provider_delivery_failed:
    "Visual delivery was not confirmed. Do not claim to see a new screenshot.",
  image_too_large:
    "The image exceeds this connection's limit. Request a smaller detail region; no new screenshot was supplied.",
};
export class ToolDispatcher {
  private pendingAbort: AbortController | null = null;
  private lastSent: string | null = null;
  private lastDeliveryAt = -Infinity;
  private lastKind: string | null = null;
  private generation = 0;
  private requestSequence = 0;
  private inspections = 0;
  private turnId = "";
  private counts: Record<string, number> = {};
  private inFlight = false;
  private lastCapture = -Infinity;
  private debug: VisualDebug | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private policy: () => VisualPolicy,
    private capture: (
      maxBytes: number,
      request: VisualRequest,
      signal?: AbortSignal,
    ) => Promise<VisualContext>,
    private now = () => Date.now(),
    private temporal?: TemporalContextClient,
  ) {}
  beginTurn(
    id: string,
    completedMonotonicAt?: number,
    conversationId?: string,
  ) {
    if (this.turnId !== id) {
      this.inspections = 0;
      this.turnId = id;
    }
    this.temporal?.beginTurn(id, completedMonotonicAt, conversationId);
  }
  completeTurn() {
    this.temporal?.completeTurn();
  }
  currentTurnId() {
    return this.turnId;
  }
  async visualAvailability() {
    if (!this.permitted() || !this.temporal)
      throw { code: "permission_denied" };
    return this.temporal.availability();
  }
  reserveTurn() {
    this.temporal?.reserveTurn();
  }
  getSnapshot = () => this.debug;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<VisualDebug>) {
    if (this.debug) this.debug = { ...this.debug, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  permitted() {
    const p = this.policy();
    return (
      p.aiActive && p.visualActive && p.allowed && p.capabilities.imageInput
    );
  }
  /** Privacy permission is independent from a reasoning model's capabilities. */
  screenPermitted() {
    const p = this.policy();
    return p.aiActive && p.visualActive && p.allowed;
  }
  async contextAvailability() {
    if (!this.screenPermitted() || !this.temporal)
      throw { code: "permission_denied" };
    return this.temporal.availability();
  }
  /** Prepare through the existing M7 owner; application routing needs no tools API. */
  async prepareContext(
    inspection: VisualInspectionRequest,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<VisualContext> {
    if (!this.screenPermitted()) throw { code: "permission_denied" };
    if (!this.policy().capabilities.imageInput)
      throw { code: "provider_visual_input_unsupported" };
    if (signal.aborted) throw { code: "cancelled" };
    if (this.inFlight) throw { code: "capture_in_progress" };
    if (this.inspections >= config.maxInspectionsPerTurn)
      throw { code: "visual_limit_reached" };
    const generation = this.generation;
    const pending = new AbortController();
    const combined = AbortSignal.any([signal, pending.signal]);
    const valid = () => {
      if (combined.aborted || generation !== this.generation)
        throw { code: "cancelled" };
      if (!this.screenPermitted()) throw { code: "permission_denied" };
      if (!this.policy().capabilities.imageInput)
        throw { code: "provider_visual_input_unsupported" };
    };
    const cancelNative = () => {
      // revoke() already invalidates native ownership before aborting pending.
      if (!pending.signal.aborted && generation === this.generation)
        this.temporal?.cancel(true);
    };
    combined.addEventListener("abort", cancelNative, { once: true });
    this.pendingAbort = pending;
    this.inFlight = true;
    ++this.inspections;
    let context: VisualContext | undefined;
    try {
      context = await new DeterministicVisualOrchestrator(
        (max, request, captureSignal) =>
          this.capture(max, request, captureSignal),
        this.temporal,
      ).inspect(
        inspection,
        Math.min(config.maxEncodedBytes, maxBytes),
        combined,
      );
      valid();
      const validate = context.validate;
      context.validate = async () => {
        valid();
        await validate?.();
        valid();
      };
      await context.validate();
      return context;
    } catch (error) {
      if (context) releaseContext(context);
      throw error;
    } finally {
      combined.removeEventListener("abort", cancelNative);
      if (this.pendingAbort === pending) {
        this.pendingAbort = null;
        this.inFlight = false;
      }
    }
  }
  async captureFresh(turnId: string, maxBytes: number, signal: AbortSignal) {
    if (!this.permitted() || signal.aborted)
      throw { code: "permission_denied" };
    if (this.inFlight) throw { code: "capture_busy" };
    this.inFlight = true;
    try {
      return await this.capture(
        Math.min(config.maxEncodedBytes, maxBytes),
        { kind: "context", turnId },
        signal,
      );
    } finally {
      this.inFlight = false;
    }
  }
  noteDelivery(context?: VisualContext) {
    if (context) this.temporal?.noteDelivery(context);
    this.lastDeliveryAt = this.now();
    this.lastKind = "context";
  }
  async waitForDeliverySlot(signal: AbortSignal) {
    if (signal.aborted) throw new Error("cancelled");
    if (this.temporal) return; // Native per-turn/image limits govern bounded requests.
    const delay = Math.max(
      0,
      config.minimumDeliveryIntervalMs - (this.now() - this.lastDeliveryAt),
    );
    if (!delay) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  cancelPending(preserveFollowUp = false) {
    const deliveryAt = this.lastDeliveryAt;
    this.revoke(preserveFollowUp);
    this.lastDeliveryAt = deliveryAt;
  }
  revoke(preserveFollowUp = false) {
    this.inspections = 0;
    this.turnId = "";
    // Invalidate the client generation before abort listeners fire, so an old
    // preparation cannot undo preservation of a completed conversational reference.
    this.temporal?.cancel(preserveFollowUp);
    this.pendingAbort?.abort();
    ++this.generation;
    this.lastSent = null;
    this.lastDeliveryAt = -Infinity;
    this.lastKind = null;
    if (this.inFlight)
      this.publish({ status: "Cancelled", result: "cancelled" });
  }
  async dispatch(call: ToolCall, port: ToolPort): Promise<void> {
    const originalCall = call;
    const policy = this.policy();
    const generation = this.generation;
    const requestSequence = ++this.requestSequence;
    const args = call.arguments;
    const inspection = inspectionRequest(args);
    const validArgs = inspection !== null;
    const reason = validArgs
      ? "Visual inspection requested"
      : "Invalid visual intent";
    const request: VisualRequest = {
      kind:
        inspection?.mode === "recent" ||
        inspection?.mode === "recent_exact" ||
        inspection?.mode === "compare_recent_current"
          ? "recent"
          : inspection?.mode.endsWith("_exact")
            ? "detail"
            : "current",
    };
    let image: ToolResult["image"];
    let context: VisualContext | undefined;
    const debug: VisualDebug = {
      kind: request.kind,
      tool: call.name === config.tool.name ? call.name : "Unknown tool",
      provider: policy.provider,
      reason,
      requestedAt: this.now(),
      status: "AI requested visual context",
      result: null,
      sent: false,
      acknowledgment: "Not sent",
      metadata: null,
    };
    this.debug = debug;
    this.publish({});
    const current = () =>
      !call.signal.aborted && generation === this.generation && port.active();
    const denied = (): ToolStatus | null => {
      const p = this.policy();
      if (!p.aiActive || !port.active()) return "ai_session_inactive";
      if (!p.visualActive) return "visual_session_inactive";
      if (!p.allowed) return "permission_denied";
      if (!p.capabilities.toolCalling)
        return "provider_function_calling_unsupported";
      if (!p.capabilities.imageInput)
        return "provider_visual_input_unsupported";
      return null;
    };
    const finish = (status: ToolStatus, timestampUnixMs?: number) => {
      if (status === "cancelled")
        this.counts.cancelled = (this.counts.cancelled ?? 0) + 1;
      if (
        [
          "capture_failed",
          "readback_failed",
          "encoding_failed",
          "provider_delivery_failed",
        ].includes(status)
      )
        this.counts.failed = (this.counts.failed ?? 0) + 1;
      // Debug is latest request only: an older completion must not overwrite a newer request.
      if (requestSequence === this.requestSequence)
        this.publish({
          counts: { ...this.counts },
          result: status,
          status:
            status === "success"
              ? "Visual context sent"
              : status === "cancelled"
                ? "Cancelled"
                : `Visual request: ${status}`,
        });
      if (!originalCall.signal.aborted && port.active()) {
        try {
          port.sendResult(originalCall, {
            status,
            inspection: [
              "success",
              "unchanged",
              "history_unavailable",
              "current_unavailable",
              "snapshot_expired",
              "encoding_failed",
            ].includes(status)
              ? context?.inspection
              : undefined,
            success: status === "success" || status === "unchanged",
            image:
              status === "success" || status === "unchanged"
                ? image
                : undefined,
            context:
              status === "success" || status === "unchanged"
                ? context?.context
                : undefined,
            message: messages[status],
            timestampUnixMs:
              status === "success" || status === "unchanged"
                ? timestampUnixMs
                : undefined,
          });
        } catch {
          if (requestSequence === this.requestSequence)
            this.publish({ acknowledgment: "Tool result delivery failed" });
        }
      }
    };
    let blocked: ToolStatus | null =
      call.name !== config.tool.name
        ? "unknown_tool"
        : !validArgs
          ? "invalid_arguments"
          : denied();
    if (!blocked && !current()) blocked = "cancelled";
    if (!blocked && this.inFlight) blocked = "capture_in_progress";
    if (
      !blocked &&
      !this.temporal &&
      !(this.lastKind === "context" && request.kind === "detail") &&
      this.now() - this.lastCapture < config.minimumIntervalMs
    )
      blocked = "rate_limited";
    if (blocked) {
      finish(blocked);
      return;
    }
    if (this.inspections >= config.maxInspectionsPerTurn) {
      finish("visual_limit_reached");
      return;
    }
    this.inspections++;
    this.counts[inspection!.mode] = (this.counts[inspection!.mode] ?? 0) + 1;
    this.inFlight = true;
    this.pendingAbort = new AbortController();
    const originalSignal = call.signal;
    const abortNative = () => this.temporal?.cancel();
    originalSignal.addEventListener("abort", abortNative, { once: true });
    call = {
      ...call,
      signal: AbortSignal.any([originalSignal, this.pendingAbort.signal]),
    };
    this.lastCapture = this.now();
    this.lastKind = null;
    this.publish({ status: "Capturing…" });
    try {
      // A two-stage request may bypass the request cooldown, but never burst
      // images faster than the shared one-frame-per-second transport budget.
      const delay = this.temporal
        ? 0
        : Math.max(
            0,
            config.minimumDeliveryIntervalMs -
              (this.now() - this.lastDeliveryAt),
          );
      if (delay > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (!current()) {
        finish("cancelled");
        return;
      }
      const permission = denied();
      if (permission) {
        finish(permission);
        return;
      }
      context = await new DeterministicVisualOrchestrator(
        (max, primitive, signal) => this.capture(max, primitive, signal),
        this.temporal,
      ).inspect(
        inspection!,
        Math.min(config.maxEncodedBytes, port.maxImageBytes()),
        call.signal,
      );
      if (!current()) {
        finish("cancelled");
        return;
      }
      const afterPreparation = denied();
      if (afterPreparation) {
        finish(afterPreparation);
        return;
      }
      this.counts[context.inspection!.status] =
        (this.counts[context.inspection!.status] ?? 0) + 1;
      for (const operation of context.inspection!.operations)
        this.counts[operation] = (this.counts[operation] ?? 0) + 1;
      this.counts.images_prepared =
        (this.counts.images_prepared ?? 0) +
        context.inspection!.work.imagesPrepared;
      this.counts.images_reused =
        (this.counts.images_reused ?? 0) +
        context.inspection!.work.imagesReused;
      if (requestSequence === this.requestSequence)
        this.publish({
          inspection: context.inspection,
          counts: { ...this.counts },
        });
      if (
        !context.frames?.length &&
        context.inspection?.snapshots.some((f) => f.reused)
      ) {
        await context.validate?.();
        if (!current() || denied()) {
          finish("cancelled");
          return;
        }
        finish("unchanged");
        return;
      }
      if (
        context.inspection?.status === "Unavailable" ||
        context.inspection?.status === "Expired"
      ) {
        const reason = context.inspection.warnings.find((w) =>
          Object.hasOwn(messages, w),
        );
        finish(
          context.inspection.status === "Expired"
            ? "snapshot_expired"
            : reason
              ? (reason as ToolStatus)
              : inspection!.mode.startsWith("current")
                ? "current_unavailable"
                : "history_unavailable",
        );
        return;
      }
      if (!current()) {
        finish("cancelled");
        return;
      }
      const blocked = denied();
      if (blocked) {
        finish(blocked);
        return;
      }
      if (requestSequence === this.requestSequence)
        this.publish({
          metadata: context.metadata,
          status: "Sending visual context…",
        });
      image = {
        role:
          context.kind === "detail"
            ? "HIGH RESOLUTION DETAIL (crop, not entire desktop)"
            : "FULL SCREEN CONTEXT",
        sourceRegion: context.sourceRegion,
        originalWidth: context.originalWidth,
        originalHeight: context.originalHeight,
      };
      const bytes = new TextEncoder().encode(
        context.context ? context.context.requestId : context.base64,
      );
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      bytes.fill(0);
      const fingerprint = JSON.stringify([
        context.kind ?? "context",
        context.sourceRegion,
        context.width,
        context.height,
        context.mimeType,
        digest,
      ]);
      if (!current() || denied()) {
        finish("cancelled");
        return;
      }
      if (requestSequence === this.requestSequence)
        this.publish({ capturedAt: context.timestampUnixMs });
      if (
        !context.context &&
        this.lastSent === fingerprint &&
        !(request.kind === "detail" && request.fresh)
      ) {
        this.lastKind = request.kind;
        finish("unchanged", context.timestampUnixMs);
        return;
      }
      // sendVisual checks signal/current transport immediately before enqueueing image bytes.
      let receipt: VisualDelivery;
      try {
        await context.validate?.();
        if (!current() || denied()) {
          finish("cancelled");
          return;
        }
        if (context.inspection && context.preparation)
          context.inspection.timings.preparedToSubmissionMs =
            performance.now() - context.preparation.readyAt;
        receipt = await port.sendVisual(context, call.signal);
      } catch {
        finish("provider_delivery_failed");
        return;
      }
      if (receipt.sent && receipt.acknowledged !== false && current()) {
        this.temporal?.noteDelivery(context);
        this.lastSent = fingerprint;
        this.lastKind = request.kind;
      }
      if (receipt.sent && current()) {
        this.lastDeliveryAt = this.now();
        this.counts.images_submitted =
          (this.counts.images_submitted ?? 0) + (context.frames?.length ?? 1);
        this.counts.bytes_submitted =
          (this.counts.bytes_submitted ?? 0) +
          context.metadata.encodedSizeBytes;
      }
      if (requestSequence === this.requestSequence)
        this.publish({
          sentAt: receipt.sent ? this.now() : undefined,
          sent: receipt.sent,
          acknowledgment: receipt.acknowledgment,
        });
      if (!current()) {
        finish("cancelled");
        return;
      }
      finish(
        receipt.sent && receipt.acknowledged !== false
          ? "success"
          : "provider_delivery_failed",
        context.timestampUnixMs,
      );
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      finish(
        !current()
          ? "cancelled"
          : typeof code === "string" && Object.hasOwn(messages, code)
            ? (code as ToolStatus)
            : code === "capture_busy"
              ? "capture_in_progress"
              : code === "image_too_large"
                ? "image_too_large"
                : code === "permission_denied"
                  ? "permission_denied"
                  : "capture_failed",
      );
    } finally {
      originalSignal.removeEventListener("abort", abortNative);
      if (context?.context) releaseContext(context);
      this.inFlight = false;
      this.pendingAbort = null;
    }
  }
}
