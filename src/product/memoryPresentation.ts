import type { MemoryRecord } from "./memoryApi";

export function memoryEventKey(record: MemoryRecord): string {
  if (record.eventKind === "meaningful_stable_state")
    return "memory.stableEvent";
  if (record.eventKind === "important_transient")
    return "memory.transientEvent";
  return record.hasVisual || record.hasThumbnail
    ? "memory.manualEvent"
    : "memory.metadataEvent";
}
export function memoryUserLabel(record: MemoryRecord): string | null {
  // System metadata is a presentation label, not extracted screen content.
  // User-authored labels keep their original language and wording.
  return record.summarySource === "system_metadata"
    ? null
    : record.summary || null;
}
