export type ScreenContextMode = "current" | "semantic";

export const screenContextModeStorageKey = "companion.screen-context.mode.v1";

/** Sharing mode is independent of optional semantic engine preferences. */
export function parseScreenContextMode(
  serialized: string | null,
): ScreenContextMode {
  try {
    if (!serialized || serialized.length > 4096) return "current";
    const value = JSON.parse(serialized);
    return value?.version === 1 && value.mode === "semantic"
      ? "semantic"
      : "current";
  } catch {
    return "current";
  }
}

export function serializeScreenContextMode(mode: ScreenContextMode): string {
  return JSON.stringify({ version: 1, mode });
}
