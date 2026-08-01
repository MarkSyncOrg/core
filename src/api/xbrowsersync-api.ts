import type { components } from '../types/api.js';
import {
  DailyNewSyncLimitReachedError,
  InvalidServiceError,
  NetworkError,
  NotAcceptingNewSyncsError,
  RequestEntityTooLargeError,
  ServiceOfflineError,
  SyncConflictError,
  SyncNotFoundError,
  TooManyRequestsError,
  UnexpectedResponseError,
  UnsupportedApiVersionError,
} from '../errors.js';
import { isVersionAtLeast } from '../version.js';
import { createApiClient } from './client.js';

export type ServiceInfo = components['schemas']['ServiceInfo'];
export type CreateSyncResponse = components['schemas']['CreateSyncResponse'];
export type GetSyncResponse = components['schemas']['GetSyncResponse'];
type ApiErrorBody = components['schemas']['ApiError'];

/**
 * Minimum xBrowserSync API version this client supports. Older services lack the
 * sync-version endpoints and conflict detection the client relies on.
 */
export const MIN_API_VERSION = '1.1.9';

/** Result of a single openapi-fetch call. */
interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Maps an HTTP error response to a typed error, mirroring the backend exceptions. */
function mapHttpError(status: number, body: ApiErrorBody | undefined): Error {
  const message = body?.message;
  switch (true) {
    case status === 401:
      return new SyncNotFoundError(message);
    case status === 404:
      return new InvalidServiceError(message);
    case status === 405:
      return new NotAcceptingNewSyncsError(message);
    case status === 406:
      return new DailyNewSyncLimitReachedError(message);
    case status === 409:
      return new SyncConflictError(message);
    case status === 412:
      return new UnsupportedApiVersionError(message);
    case status === 413:
      return new RequestEntityTooLargeError(message);
    case status === 429:
      return new TooManyRequestsError(message);
    case status >= 500:
      return new ServiceOfflineError(message);
    default:
      return new UnexpectedResponseError(message);
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Hosts for which plain HTTP is tolerated, so a self-hosted service can be run locally. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Sync IDs are UUID v4s with the hyphens removed, per the OpenAPI contract's `SyncId`
 * schema. openapi-fetch is types-only and performs no runtime checking, so the pattern
 * is enforced here.
 */
const SYNC_ID_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Parses and validates a service URL, returning it normalised without a trailing slash.
 *
 * The base URL is concatenated with each endpoint path, so an unvalidated value does
 * more than pick a host:
 *   - a non-HTTPS scheme exposes the sync ID (and the request pattern) to the network,
 *     and hands an active attacker control of every response;
 *   - a query string or fragment swallows the endpoint path, collapsing `/info`,
 *     `/bookmarks/{id}` and `/lastUpdated` onto one URL — which would let a single
 *     crafted response satisfy the `getInfo` check on behalf of all of them;
 *   - embedded credentials would be sent to the service and logged with the URL.
 *
 * @throws {InvalidServiceError} if the URL is unusable as an xBrowserSync service base.
 */
export function normalizeServiceUrl(serviceUrl: string): string {
  const trimmed = serviceUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidServiceError('Service URL is not a valid absolute URL');
  }
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new InvalidServiceError(
      'Service URL must use https (http is allowed only for loopback addresses)',
    );
  }
  // Tested on the raw input, not on `parsed`: a bare trailing `?` or `#` parses to an
  // empty search/hash but still survives into `href`, and would then swallow every
  // endpoint path appended to it.
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new InvalidServiceError('Service URL must not contain a query string or fragment');
  }
  if (parsed.username || parsed.password) {
    throw new InvalidServiceError('Service URL must not contain embedded credentials');
  }
  // Rebuilt from origin + path so nothing but the base survives normalisation.
  return stripTrailingSlash(`${parsed.origin}${parsed.pathname}`);
}

/** Whether a string is a well-formed xBrowserSync sync ID. */
export function isValidSyncId(syncId: string): boolean {
  return SYNC_ID_PATTERN.test(syncId);
}

function assertValidSyncId(syncId: string): void {
  if (!isValidSyncId(syncId)) {
    throw new SyncNotFoundError('Sync ID must be 32 lowercase hexadecimal characters');
  }
}

/**
 * Typed client for a single xBrowserSync service. All bookmark payloads are opaque
 * ciphertext — encryption/decryption is the caller's responsibility (see crypto).
 *
 * The API version is intentionally not pinned via the `Accept-Version` header; the
 * service selects its configured default (the current `^1.1.3` behaviour), matching
 * the legacy client.
 */
export class XbrowsersyncApi {
  readonly serviceUrl: string;
  private readonly client: ReturnType<typeof createApiClient>;

  constructor(serviceUrl: string) {
    this.serviceUrl = normalizeServiceUrl(serviceUrl);
    this.client = createApiClient(this.serviceUrl);
  }

  /** Fetches service info, validating it is a supported xBrowserSync service. */
  async getInfo(): Promise<ServiceInfo> {
    const info = await this.send<ServiceInfo>(() => this.client.GET('/info'));
    if (info.status == null || !info.version) {
      throw new InvalidServiceError();
    }
    if (!isVersionAtLeast(info.version, MIN_API_VERSION)) {
      throw new UnsupportedApiVersionError();
    }
    return info;
  }

  /** Creates a new, empty sync and returns its ID, version and timestamp. */
  async createSync(version: string): Promise<CreateSyncResponse> {
    const data = await this.send<CreateSyncResponse>(() =>
      this.client.POST('/bookmarks', { body: { version } }),
    );
    if (!data.id || !data.lastUpdated || !data.version) {
      throw new UnexpectedResponseError();
    }
    return data;
  }

  /** Retrieves a sync's encrypted bookmarks, version and last-updated timestamp. */
  async getSync(id: string): Promise<GetSyncResponse> {
    assertValidSyncId(id);
    const data = await this.send<GetSyncResponse>(() =>
      this.client.GET('/bookmarks/{id}', { params: { path: { id } } }),
    );
    if (!data.lastUpdated) {
      throw new UnexpectedResponseError();
    }
    return { ...data, bookmarks: data.bookmarks ?? '' };
  }

  /** Returns the sync's last-updated timestamp (used for change detection). */
  async getLastUpdated(id: string): Promise<string> {
    assertValidSyncId(id);
    const data = await this.send<components['schemas']['LastUpdatedResponse']>(() =>
      this.client.GET('/bookmarks/{id}/lastUpdated', { params: { path: { id } } }),
    );
    if (!data.lastUpdated) {
      throw new UnexpectedResponseError();
    }
    return data.lastUpdated;
  }

  /** Returns the sync data format version stored for a sync. */
  async getSyncVersion(id: string): Promise<string> {
    assertValidSyncId(id);
    const data = await this.send<components['schemas']['VersionResponse']>(() =>
      this.client.GET('/bookmarks/{id}/version', { params: { path: { id } } }),
    );
    if (!data.version) {
      throw new UnexpectedResponseError();
    }
    return data.version;
  }

  /**
   * Uploads encrypted bookmarks for an existing sync, returning the new timestamp.
   *
   * @param lastUpdated The timestamp the client last observed, for conflict detection.
   *                    A mismatch makes the service respond 409 (SyncConflictError).
   * @param version     When provided, also updates the stored sync data format version.
   */
  async updateSync(
    id: string,
    bookmarks: string,
    lastUpdated?: string,
    version?: string,
  ): Promise<string> {
    assertValidSyncId(id);
    const data = await this.send<components['schemas']['UpdateSyncResponse']>(() =>
      this.client.PUT('/bookmarks/{id}', {
        params: { path: { id } },
        body: {
          bookmarks,
          ...(lastUpdated ? { lastUpdated } : {}),
          ...(version ? { version } : {}),
        },
      }),
    );
    if (!data.lastUpdated) {
      throw new UnexpectedResponseError();
    }
    return data.lastUpdated;
  }

  /** Runs an openapi-fetch call, mapping network failures and HTTP errors to typed errors. */
  private async send<T>(call: () => Promise<FetchResult<T>>): Promise<T> {
    let result: FetchResult<T>;
    try {
      result = await call();
    } catch {
      // fetch rejects on connectivity failures (DNS, offline, CORS, abort).
      throw new NetworkError();
    }
    if (!result.response.ok) {
      throw mapHttpError(result.response.status, result.error as ApiErrorBody | undefined);
    }
    if (result.data === undefined) {
      throw new UnexpectedResponseError();
    }
    return result.data;
  }
}
