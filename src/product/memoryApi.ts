import { invoke } from "@tauri-apps/api/core";
export interface MemorySettings {
  mode: "off" | "manual";
  paused: boolean;
  automaticMemoryEnabled: boolean;
  storageMode: "metadata" | "thumbnail" | "visual";
  retentionDays: number;
  storageLimitMb: number;
}
export interface MemoryRecord {
  id: string;
  observedAt: number;
  persistedAt: number;
  sessionId: string;
  eventKind: string;
  summary: string;
  summarySource: string;
  sourceApplication?: string | null;
  windowTitle?: string | null;
  saveReason: string;
  bookmarked: boolean;
  hasVisual: boolean;
  hasThumbnail: boolean;
  width?: number | null;
  height?: number | null;
  expiresAt?: number | null;
}
export interface MemoryCursor {
  observedAt: number;
  id: string;
}
export interface MemoryQuery {
  text?: string;
  from?: number;
  to?: number;
  bookmarkedOnly?: boolean;
  sourceApplication?: string;
  cursor?: MemoryCursor;
  limit?: number;
}
export interface MemoryPage {
  items: MemoryRecord[];
  nextCursor?: MemoryCursor | null;
}
export interface MemoryStatus {
  settings: MemorySettings;
  health: "ready" | "unavailable" | "starting";
  errorCode?: string | null;
  savedCount: number;
  storageBytes: number;
  queueDepth: number;
  screenAwareness: boolean;
  encrypted: false;
  semanticSearch: false;
  storageLocation?: string | null;
}
export const memoryApi = {
  status: () => invoke<MemoryStatus>("memory_status"),
  configure: (settings: MemorySettings) =>
    invoke<MemoryStatus>("memory_configure", { settings }),
  search: (query: MemoryQuery) =>
    invoke<MemoryPage>("memory_search", { query }),
  get: (id: string) => invoke<MemoryRecord>("memory_get", { id }),
  asset: (id: string, thumbnail: boolean) =>
    invoke<ArrayBuffer>("memory_asset", { id, thumbnail }),
  remember: (label: string | null) =>
    invoke<MemoryRecord>("memory_remember", { label }),
  bookmark: (id: string, bookmarked: boolean) =>
    invoke<MemoryRecord>("memory_bookmark", { id, bookmarked }),
  delete: (id: string) => invoke<void>("memory_delete", { id }),
  clear: () => invoke<void>("memory_clear", { confirmed: true }),
};
export function memoryErrorKey(error: unknown): string {
  const value =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : typeof error === "string"
        ? error
        : "";
  const codes: Record<string, string> = {
    MEMORY_DISABLED: "MemoryDisabled",
    MEMORY_AUTOMATIC_DISABLED: "MemoryDisabled",
    MEMORY_PAUSED: "MemoryPaused",
    MEMORY_SCREEN_AWARENESS_OFF: "ScreenAwarenessRequired",
    MEMORY_UNAVAILABLE: "MemoryUnavailable",
    MEMORY_CANCELLED: "MemoryWriteFailed",
    MEMORY_QUEUE_FULL: "MemoryWriteFailed",
    MEMORY_INVALID_REQUEST: "MemoryInvalidInput",
    MEMORY_SCREEN_UNAVAILABLE: "ScreenAwarenessRequired",
    MEMORY_CAPTURE_UNAVAILABLE: "ScreenAwarenessRequired",
    MEMORY_IMAGE_TOO_LARGE: "MemoryWriteFailed",
    MEMORY_DISK_FULL: "MemoryDiskFull",
    MEMORY_PERMISSION_DENIED: "MemoryPermissionDenied",
    MEMORY_WRITE_FAILED: "MemoryWriteFailed",
    MEMORY_DATABASE_UNAVAILABLE: "MemoryDatabaseUnavailable",
    MEMORY_BUSY: "MemoryUnavailable",
    MEMORY_ASSET_MISSING: "MemoryAssetMissing",
    MEMORY_ASSET_CORRUPT: "MemoryAssetMissing",
    MEMORY_NOT_FOUND: "MemoryNotFound",
    MEMORY_STORAGE_FULL: "MemoryStorageLimit",
    MEMORY_CLEANUP_INCOMPLETE: "MemoryDeleteFailed",
    MEMORY_SCHEMA_TOO_NEW: "MemoryMigrationFailed",
    MEMORY_MIGRATION_FAILED: "MemoryMigrationFailed",
    MEMORY_SETTINGS_INVALID: "MemoryInvalidInput",
    MEMORY_CONFIRMATION_REQUIRED: "MemoryInvalidInput",
  };
  const code = value.split(":", 1)[0];
  return codes[code] ? `memory.${codes[code]}` : "memory.error";
}
