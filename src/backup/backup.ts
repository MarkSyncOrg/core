import type { Bookmark } from '../bookmarks/bookmark.js';
import { acceptBookmarkTreeWithReport, type SanitizeResult } from '../bookmarks/validate.js';

// Backup file format, compatible with the xBrowserSync ecosystem. The current shape
// nests bookmarks under `xbrowsersync.data`; the legacy `xBrowserSync` shape is read
// for restores. Credentials are never written to a backup.

export interface BackupSyncInfo {
  id?: string;
  type?: string;
  url?: string;
  version?: string;
}

export interface Backup {
  xbrowsersync?: {
    data: { bookmarks: Bookmark[] };
    date: string;
    sync?: BackupSyncInfo;
  };
  /** @deprecated Legacy backup shape, accepted on restore. */
  xBrowserSync?: {
    bookmarks?: Bookmark[];
    id?: string;
  };
}

function dateStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Builds a backup object from bookmarks and (optional, password-free) sync info. */
export function buildBackup(
  bookmarks: Bookmark[],
  sync?: BackupSyncInfo,
  date = new Date(),
): Backup {
  return {
    xbrowsersync: {
      data: { bookmarks },
      date: date.toISOString(),
      ...(sync ? { sync } : {}),
    },
  };
}

/**
 * Extracts bookmarks from a backup (current or legacy shape).
 *
 * A backup file is the least trusted input in the system — unauthenticated, unencrypted
 * and picked from disk — so the extracted tree is fully validated and sanitised before
 * it is handed back. Previously this tested only that the field was truthy, which let a
 * string or a number through as a `Bookmark[]` and crashed later inside the tree walks.
 *
 * @throws {InvalidBookmarkDataError} if the bookmarks are not a well-formed tree.
 */
export function extractBookmarks(backup: Backup): Bookmark[] {
  return extractBookmarksWithReport(backup).bookmarks;
}

/**
 * {@link extractBookmarks}, but also returning the nodes sanitisation dropped.
 *
 * A restore is destructive, and the dropped entries are not recoverable from the returned
 * tree — read them here to tell the user what the file contained that will not come back.
 *
 * @throws {InvalidBookmarkDataError} if the bookmarks are not a well-formed tree.
 */
export function extractBookmarksWithReport(backup: Backup): SanitizeResult {
  const current = backup.xbrowsersync?.data?.bookmarks;
  if (current !== undefined) {
    return acceptBookmarkTreeWithReport(current);
  }
  const legacy = backup.xBrowserSync?.bookmarks;
  if (legacy !== undefined) {
    return acceptBookmarkTreeWithReport(legacy);
  }
  throw new Error('Unrecognised backup file');
}

/**
 * Parses backup JSON text into a Backup, validating the shape.
 *
 * Note this returns the parsed container as-is; use {@link extractBookmarks} to obtain
 * the validated, sanitised bookmark tree.
 */
export function parseBackup(json: string): Backup {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Unrecognised backup file');
  }
  const backup = parsed as Backup;
  // Validate by attempting extraction (throws on unknown or malformed shapes).
  extractBookmarks(backup);
  return backup;
}

/** Default backup file name, e.g. `xbs_backup_20260622153000.txt`. */
export function backupFilename(date = new Date()): string {
  return `xbs_backup_${dateStamp(date)}.txt`;
}
