import type { VisualContext } from "./types.js";
import {
  visualIntents,
  type VisualInspectionIntent,
} from "./VisualInspection.js";
type Counts = { submissions: number; images: number; encodedBytes: number };
const empty = (): Counts => ({ submissions: 0, images: 0, encodedBytes: 0 });
const counters = {
  openai: { current: empty(), detail: empty(), recent: empty() },
  gemini: { current: empty(), detail: empty(), recent: empty() },
};
const intents = () =>
  Object.fromEntries(visualIntents.map((mode) => [mode, empty()])) as Record<
    VisualInspectionIntent,
    Counts
  >;
const intentCounters = { openai: intents(), gemini: intents() };
// Volatile aggregate counts only. Never retain images, identifiers, or text here.
export function noteVisualEnqueue(
  provider: keyof typeof counters,
  context: VisualContext,
  images: number,
  encodedBytes: number,
  first = true,
) {
  if (!context.context) return;
  const row = counters[provider][context.context.kind];
  row.submissions += Number(first);
  row.images += images;
  row.encodedBytes += encodedBytes;
  if (context.inspection) {
    const intent = intentCounters[provider][context.inspection.intent];
    intent.submissions += Number(first);
    intent.images += images;
    intent.encodedBytes += encodedBytes;
  }
}
export const visualDeliveryCounters = () => structuredClone(counters);
export const visualIntentDeliveryCounters = () =>
  structuredClone(intentCounters);
