import type { NativeInvoke } from "../visual/TemporalContext.js";
import {
  safePreflightFailure,
  type PreflightInput,
  type VisualIntentPreflight,
  type VisualPreflightDecision,
} from "./VisualIntentPreflight.js";

export class NativeDecisionTransport implements VisualIntentPreflight {
  private pendingIpc = 0;
  private active = false;
  constructor(
    private invoke: NativeInvoke,
    private prefix: string,
    private parse: (value: unknown) => VisualPreflightDecision,
  ) {}
  private async call<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    this.pendingIpc++;
    try {
      return await this.invoke<T>(command, args);
    } finally {
      this.pendingIpc--;
    }
  }
  async route(
    input: PreflightInput,
    signal: AbortSignal,
  ): Promise<VisualPreflightDecision> {
    if (signal.aborted) throw "cancelled";
    if (!input.visual_availability.screen_awareness_enabled) throw "privacy";
    // Never queue turns behind stalled IPC. At most one operation plus its
    // epoch-specific cancellation can remain outstanding, even after timeout.
    if (this.active || this.pendingIpc) throw "busy";
    this.active = true;
    const a = input.visual_availability;
    // Construct a whitelist instead of forwarding caller-owned objects to IPC.
    const payload: PreflightInput = {
      user_utterance: input.user_utterance,
      ...(input.previous_turn_context
        ? { previous_turn_context: input.previous_turn_context }
        : {}),
      visual_availability: {
        screen_awareness_enabled: a.screen_awareness_enabled,
        current_available: a.current_available,
        recent_available: a.recent_available,
        previous_reference_available: a.previous_reference_available,
      },
    };
    let epoch: number | undefined;
    const cancelEpoch = (value: number) => {
      void this.call(`${this.prefix}_cancel`, { epoch: value }).catch(() => {});
    };
    let cancelled!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      cancelled = () => {
        if (epoch !== undefined) cancelEpoch(epoch);
        reject("cancelled");
      };
    });
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      epoch = await Promise.race([
        this.call<number>(`${this.prefix}_begin`).then((value) => {
          epoch = value;
          if (signal.aborted) {
            cancelEpoch(value);
            throw "cancelled";
          }
          return value;
        }),
        cancellation,
      ]);
      if (signal.aborted) throw "cancelled";
      const result = await Promise.race([
        this.call(`${this.prefix}_decide`, { epoch, input: payload }),
        cancellation,
      ]);
      if (signal.aborted) throw "cancelled";
      return this.parse(result);
    } catch (error) {
      throw safePreflightFailure(error);
    } finally {
      this.active = false;
      signal.removeEventListener("abort", cancelled);
    }
  }
}
