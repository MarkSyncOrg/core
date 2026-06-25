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
    this.serviceUrl = stripTrailingSlash(serviceUrl);
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
