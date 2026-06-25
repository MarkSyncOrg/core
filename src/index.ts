// Public entry point for @xbrowsersync/core.
//
// Platform-agnostic: no DOM or browser-extension APIs. Consumers (the PWA, the
// web-extension rewrite) provide their own StorageArea and BookmarkProvider
// implementations and wire them into the SyncEngine.

// Crypto
export { CRYPTO_PARAMS, getPasswordHash, encryptData, decryptData } from './crypto/crypto';
export { bytesToBase64, base64ToBytes } from './crypto/base64';

// Bookmark model
export {
  BookmarkContainer,
  BookmarkType,
  SEPARATOR_URL,
  DESCRIPTION_MAX_LENGTH,
  type Bookmark,
  type NativeBookmarkNode,
  trimToNearestWord,
  getBookmarkType,
  cleanBookmark,
  cleanAllBookmarks,
  eachBookmark,
  newBookmark,
  nativeToBookmarks,
  assignIds,
  getContainer,
  stripIds,
  canonicalizeBookmarks,
  serializeBookmarks,
  deserializeBookmarks,
} from './bookmarks/bookmark';

// API
export {
  XbrowsersyncApi,
  MIN_API_VERSION,
  type ServiceInfo,
  type CreateSyncResponse,
  type GetSyncResponse,
} from './api/xbrowsersync-api';
export { createApiClient } from './api/client';

// Sync engine + ports
export {
  SyncEngine,
  type ApiClient,
  type ApiFactory,
  type SyncEngineOptions,
  type SyncStatus,
  type SyncOutcome,
} from './sync/sync-engine';
export { type BookmarkProvider } from './sync/bookmark-provider';
export { threeWayMerge } from './sync/merge';
export { Mutex } from './sync/mutex';

// Storage port
export { type StorageArea, MemoryStorageArea } from './storage/storage-area';
export {
  SyncStore,
  DEFAULT_SETTINGS,
  type SyncInfo,
  type BookmarkIdMapping,
  type Settings,
  type Theme,
} from './storage/sync-store';

// Backup
export {
  buildBackup,
  extractBookmarks,
  parseBackup,
  backupFilename,
  type Backup,
  type BackupSyncInfo,
} from './backup/backup';

// Logging
export { Logger, formatLog, type LogLevel, type LogEntry } from './log/logger';

// QR (sync ID transfer)
export { renderSyncIdQrSvg } from './qr';

// Version helpers
export { compareSemver, isVersionAtLeast } from './version';

// Errors
export {
  XbsError,
  NetworkError,
  ServiceOfflineError,
  InvalidServiceError,
  UnsupportedApiVersionError,
  SyncNotFoundError,
  NotAcceptingNewSyncsError,
  DailyNewSyncLimitReachedError,
  SyncConflictError,
  RequestEntityTooLargeError,
  TooManyRequestsError,
  UnexpectedResponseError,
  InvalidCredentialsError,
  SyncNotEnabledError,
} from './errors';
