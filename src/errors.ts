// Typed error hierarchy for the xBrowserSync core. Ported from the legacy client's
// error taxonomy so callers can branch on failure cause without parsing messages.

/** Base class for all xBrowserSync errors. */
export class XbsError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The device is offline or the service could not be reached. */
export class NetworkError extends XbsError {}

/** The service is offline or returned a 5xx response. */
export class ServiceOfflineError extends XbsError {}

/** The target URL is not a valid xBrowserSync service (e.g. 404 or malformed info). */
export class InvalidServiceError extends XbsError {}

/** The service runs an API version older than this client supports. */
export class UnsupportedApiVersionError extends XbsError {}

/** The requested sync does not exist, or the sync ID is invalid (HTTP 401). */
export class SyncNotFoundError extends XbsError {}

/** The service is not accepting new syncs (HTTP 405). */
export class NotAcceptingNewSyncsError extends XbsError {}

/** The daily new-sync limit for this client has been reached (HTTP 406). */
export class DailyNewSyncLimitReachedError extends XbsError {}

/**
 * The local sync is out of date relative to the server (HTTP 409). The client must
 * pull the latest data before pushing again.
 */
export class SyncConflictError extends XbsError {}

/** The sync payload exceeds the service size limit (HTTP 413). */
export class RequestEntityTooLargeError extends XbsError {}

/** The client is being throttled (HTTP 429). */
export class TooManyRequestsError extends XbsError {}

/** The response was missing data the client requires, or an unexpected status. */
export class UnexpectedResponseError extends XbsError {}

/** The password/credentials are wrong, so decryption failed. */
export class InvalidCredentialsError extends XbsError {}

/** An operation requiring an active sync was attempted while sync is disabled. */
export class SyncNotEnabledError extends XbsError {}

/**
 * An operation was attempted in a direction this device's `syncDirection` setting
 * forbids — uploading from a receive-only device, or downloading onto a send-only one.
 */
export class SyncDirectionError extends XbsError {}

/**
 * Bookmark data from an untrusted source (a backup file, a sync payload) is not a
 * well-formed bookmark tree — wrong shape, wrong field types, or nested too deeply.
 */
export class InvalidBookmarkDataError extends XbsError {}
