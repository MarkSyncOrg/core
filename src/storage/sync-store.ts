import type { StorageArea } from './storage-area.js';

/** Credentials and endpoint for the active sync. */
export interface SyncInfo {
  /** Base URL of the xBrowserSync service. */
  serviceUrl: string;
  /** The sync ID (UUID, hyphens stripped). */
  syncId: string;
  /**
   * Base64 PBKDF2-derived AES key (the "password hash"). The raw password is never
   * stored — only this derived key, matching the legacy client.
   */
  passwordHash: string;
}

/** Maps a local browser bookmark node ID to its position in the synced tree. */
export interface BookmarkIdMapping {
  nativeId: string;
  syncedId: number;
}

// State cleared when sync is disabled.
const SYNC_KEYS = {
  syncInfo: 'syncInfo',
  syncVersion: 'syncVersion',
  lastUpdated: 'lastUpdated',
  syncEnabled: 'syncEnabled',
  bookmarkIdMappings: 'bookmarkIdMappings',
  cachedBookmarks: 'cachedBookmarks',
} as const;

// User preferences, persisted across enable/disable.
const SETTINGS_KEY = 'settings';

/** How the popup is themed. */
export type Theme = 'system' | 'light' | 'dark';

/**
 * Which way this device lets bookmarks flow.
 *
 * - `two-way` — the default: push, pull and three-way merge as needed.
 * - `push-only` — the device is a source. It uploads its own tree and never applies the
 *   service's, so nothing another browser does can reach its bookmarks.
 * - `pull-only` — the device is a mirror. It applies the service's tree and never
 *   uploads, so nothing it does locally can reach the sync.
 *
 * A one-way sync is the pair: `push-only` on the browser that owns the bookmarks,
 * `pull-only` on every browser that should only receive them.
 */
export type SyncDirection = 'two-way' | 'push-only' | 'pull-only';

/** User-configurable options (ported from the legacy client's settings). */
export interface Settings {
  /** Popup colour theme. */
  theme: Theme;
  /** Background auto-sync interval in minutes; 0 disables periodic sync. */
  syncIntervalMinutes: number;
  /** Include the browser's bookmarks toolbar/bar in the sync. */
  syncBookmarksToolbar: boolean;
  /** Push local bookmark edits automatically when they happen. */
  syncOnChange: boolean;
  /** Which way bookmarks are allowed to flow on this device. */
  syncDirection: SyncDirection;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  syncIntervalMinutes: 15,
  syncBookmarksToolbar: true,
  syncOnChange: true,
  syncDirection: 'two-way',
};

/**
 * Typed accessor for all persisted sync state. Thin wrapper over a {@link StorageArea}
 * so the durable contract is explicit and easy to test.
 */
export class SyncStore {
  constructor(private readonly area: StorageArea) {}

  getSyncInfo(): Promise<SyncInfo | undefined> {
    return this.area.get<SyncInfo>(SYNC_KEYS.syncInfo);
  }

  setSyncInfo(info: SyncInfo): Promise<void> {
    return this.area.set(SYNC_KEYS.syncInfo, info);
  }

  getSyncVersion(): Promise<string | undefined> {
    return this.area.get<string>(SYNC_KEYS.syncVersion);
  }

  setSyncVersion(version: string): Promise<void> {
    return this.area.set(SYNC_KEYS.syncVersion, version);
  }

  getLastUpdated(): Promise<string | undefined> {
    return this.area.get<string>(SYNC_KEYS.lastUpdated);
  }

  setLastUpdated(timestamp: string): Promise<void> {
    return this.area.set(SYNC_KEYS.lastUpdated, timestamp);
  }

  async isSyncEnabled(): Promise<boolean> {
    return (await this.area.get<boolean>(SYNC_KEYS.syncEnabled)) ?? false;
  }

  setSyncEnabled(enabled: boolean): Promise<void> {
    return this.area.set(SYNC_KEYS.syncEnabled, enabled);
  }

  async getBookmarkIdMappings(): Promise<BookmarkIdMapping[]> {
    return (await this.area.get<BookmarkIdMapping[]>(SYNC_KEYS.bookmarkIdMappings)) ?? [];
  }

  setBookmarkIdMappings(mappings: BookmarkIdMapping[]): Promise<void> {
    return this.area.set(SYNC_KEYS.bookmarkIdMappings, mappings);
  }

  /** Canonical serialisation of the last-synced tree, for local-change detection. */
  getCachedBookmarks(): Promise<string | undefined> {
    return this.area.get<string>(SYNC_KEYS.cachedBookmarks);
  }

  setCachedBookmarks(canonical: string): Promise<void> {
    return this.area.set(SYNC_KEYS.cachedBookmarks, canonical);
  }

  /** User settings, merged over defaults (so new options always have a value). */
  async getSettings(): Promise<Settings> {
    const stored = await this.area.get<Partial<Settings>>(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  /** Merges and persists settings, returning the new full settings. */
  async setSettings(update: Partial<Settings>): Promise<Settings> {
    const merged = { ...(await this.getSettings()), ...update };
    await this.area.set(SETTINGS_KEY, merged);
    return merged;
  }

  /** Clears sync state (on disable). User settings are preserved. */
  async clear(): Promise<void> {
    await Promise.all(Object.values(SYNC_KEYS).map((key) => this.area.remove(key)));
  }
}
