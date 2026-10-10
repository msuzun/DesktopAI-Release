import type {
  PreflightInput,
  VisualIntentPreflight,
  VisualPreflightDecision,
} from "./VisualIntentPreflight.js";

/** An explicit sharing policy: supply the current screen for every user turn. */
export class CurrentScreenPreflight implements VisualIntentPreflight {
  readonly selectionTiming = "before_response" as const;
  constructor(private permitted: () => boolean) {}

  async route(
    input: PreflightInput,
    signal: AbortSignal,
  ): Promise<VisualPreflightDecision> {
    if (signal.aborted) throw "cancelled";
    const availability = input.visual_availability;
    if (!this.permitted() || availability?.screen_awareness_enabled !== true)
      throw "privacy";
    if (
      typeof input.turn_id !== "string" ||
      !input.turn_id ||
      input.turn_id.length > 96 ||
      typeof input.user_utterance !== "string" ||
      !input.user_utterance.trim() ||
      new TextEncoder().encode(input.user_utterance).length > 8192 ||
      ![
        availability.current_available,
        availability.recent_available,
        availability.previous_reference_available,
      ].every((value) => typeof value === "boolean") ||
      (input.previous_turn_context !== undefined &&
        (typeof input.previous_turn_context !== "string" ||
          new TextEncoder().encode(input.previous_turn_context).length > 1024))
    )
      throw "invalid_input";

    // This is not a semantic classification or a fallback. Historical wording
    // never changes the selected source; capture must still validate evidence.
    return {
      route: "current",
      turnId: input.turn_id,
      availabilityCompatible: availability.current_available,
      timings: { totalMs: 0 },
    };
  }
}
