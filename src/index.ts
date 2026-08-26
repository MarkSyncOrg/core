// Public entry point for @marksyncorg/core.
//
// Platform-agnostic: no DOM or browser-extension APIs. Consumers (the PWA, the
// web-extension rewrite) provide their own StorageArea and BookmarkProvider
// implementations and wire them into the SyncEngine.

// Crypto
export { CRYPTO_PARAMS, getPasswordHash, encryptData, decryptData } from './crypto/crypto.js';
export { bytesToBase64, base64ToBytes } from './crypto/base64.js';

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
  restoreMissingContainers,
  stripIds,
  canonicalizeBookmarks,
  serializeBookmarks,
  deserializeBookmarks,
} from './bookmarks/bookmark.js';

// Bookmark identity (content-based node matching, shared by the merge and the sidecar)
export { type KeyedBookmark, bookmarkMatchKey, keyBookmarkSiblings } from './bookmarks/identity.js';

// Bookmark metadata sidecar (description/tags, which no browser stores natively)
export {
  MAX_TAGS,
  TAG_MAX_LENGTH,
  type BookmarkMetadata,
  type BookmarkMetadataMap,
  type StoredBookmarkMetadata,
  bookmarkMetadataKey,
  bookmarkMetadataPath,
  bookmarkMetadataKeysForUrl,
  collectBookmarkMetadata,
  captureBookmarkMetadata,
  applyBookmarkMetadata,
  setBookmarkMetadata,
  normalizeTags,
  normalizeDescription,
  parseTags,
  formatTags,
} from './bookmarks/metadata.js';

// Bookmark validation / sanitisation (trust-boundary helpers).
// `isSafeBookmarkUrl` is also the render-time guard consumers should use before turning
// a bookmark into an <a href> or navigating to it.
export {
  MAX_BOOKMARK_DEPTH,
  SAFE_URL_SCHEMES,
  type RemovedBookmark,
  type SanitizeResult,
  isSafeBookmarkUrl,
  validateBookmarkTree,
  sanitizeBookmarkTree,
  sanitizeBookmarkTreeWithReport,
  reinstateRemovedBookmarks,
  acceptBookmarkTree,
  acceptBookmarkTreeWithReport,
} from './bookmarks/validate.js';

// API
export {
  XbrowsersyncApi,
  MIN_API_VERSION,
  normalizeServiceUrl,
  isValidSyncId,
  type ServiceInfo,
  type CreateSyncResponse,
  type GetSyncResponse,
} from './api/xbrowsersync-api.js';
export { createApiClient } from './api/client.js';

// Sync engine + ports
export {
  SyncEngine,
  type ApiClient,
  type ApiFactory,
  type SyncEngineOptions,
  type SyncStatus,
  type SyncOutcome,
} from './sync/sync-engine.js';
export { type BookmarkProvider } from './sync/bookmark-provider.js';
export { threeWayMerge } from './sync/merge.js';
export { Mutex } from './sync/mutex.js';

// Storage port
export { type StorageArea, MemoryStorageArea } from './storage/storage-area.js';
export { BookmarkMetadataStore } from './storage/bookmark-metadata-store.js';
export {
  SyncStore,
  DEFAULT_SETTINGS,
  type SyncInfo,
  type BookmarkIdMapping,
  type Settings,
  type SyncDirection,
  type Theme,
} from './storage/sync-store.js';

// Backup
export {
  buildBackup,
  extractBookmarks,
  extractBookmarksWithReport,
  parseBackup,
  backupFilename,
  type Backup,
  type BackupSyncInfo,
} from './backup/backup.js';

// Logging
export { Logger, formatLog, redactSensitive, type LogLevel, type LogEntry } from './log/logger.js';

// QR (sync ID transfer)
export { renderSyncIdQrSvg } from './qr.js';

// Version helpers
export { compareSemver, isVersionAtLeast } from './version.js';

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
  SyncDirectionError,
  InvalidBookmarkDataError,
} from './errors.js';
