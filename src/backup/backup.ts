import type { Bookmark } from '../bookmarks/bookmark';

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

/** Extracts bookmarks from a backup (current or legacy shape). */
export function extractBookmarks(backup: Backup): Bookmark[] {
  const current = backup.xbrowsersync?.data?.bookmarks;
  if (current) {
    return current;
  }
  const legacy = backup.xBrowserSync?.bookmarks;
  if (legacy) {
    return legacy;
  }
  throw new Error('Unrecognised backup file');
}

/** Parses backup JSON text into a Backup, validating the shape. */
export function parseBackup(json: string): Backup {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Unrecognised backup file');
  }
  const backup = parsed as Backup;
  // Validate by attempting extraction (throws on unknown shapes).
  extractBookmarks(backup);
  return backup;
}

/** Default backup file name, e.g. `xbs_backup_20260622153000.txt`. */
export function backupFilename(date = new Date()): string {
  return `xbs_backup_${dateStamp(date)}.txt`;
}
