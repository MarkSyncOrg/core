import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  DailyNewSyncLimitReachedError,
  InvalidServiceError,
  NetworkError,
  NotAcceptingNewSyncsError,
  RequestEntityTooLargeError,
  SyncConflictError,
  SyncNotFoundError,
  UnsupportedApiVersionError,
} from '../errors';
import { XbrowsersyncApi } from './xbrowsersync-api';

const SERVICE_URL = 'https://api.example.org';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchMock = Mock<(input: Request | string, init?: RequestInit) => Promise<Response>>;

/** Installs a fetch mock and returns it for assertions. */
function mockFetch(impl: () => Response | Promise<Response>): FetchMock {
  const fetchMock = vi.fn(async () => impl()) as unknown as FetchMock;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Normalises the request from a fetch mock call (openapi-fetch passes a Request). */
async function readCall(
  fetchMock: FetchMock,
  index = 0,
): Promise<{ url: string; method: string; body: string }> {
  const [input, init] = fetchMock.mock.calls[index]!;
  if (input instanceof Request) {
    return { url: input.url, method: input.method, body: await input.clone().text() };
  }
  return {
    url: String(input),
    method: String((init as RequestInit | undefined)?.method ?? 'GET'),
    body: String((init as RequestInit | undefined)?.body ?? ''),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('XbrowsersyncApi.getInfo', () => {
  it('returns service info for a supported version', async () => {
    mockFetch(() =>
      jsonResponse({
        status: 1,
        version: '1.1.13',
        location: 'GB',
        maxSyncSize: 1048576,
        message: '',
      }),
    );
    const info = await new XbrowsersyncApi(SERVICE_URL).getInfo();
    expect(info.version).toBe('1.1.13');
    expect(info.maxSyncSize).toBe(1048576);
  });

  it('rejects an unsupported (too old) API version', async () => {
    mockFetch(() => jsonResponse({ status: 1, version: '1.0.0', maxSyncSize: 1, message: '' }));
    await expect(new XbrowsersyncApi(SERVICE_URL).getInfo()).rejects.toBeInstanceOf(
      UnsupportedApiVersionError,
    );
  });

  it('rejects a response missing status/version as an invalid service', async () => {
    mockFetch(() => jsonResponse({ maxSyncSize: 1, message: '' }));
    await expect(new XbrowsersyncApi(SERVICE_URL).getInfo()).rejects.toBeInstanceOf(
      InvalidServiceError,
    );
  });

  it('maps a connectivity failure to NetworkError', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(new XbrowsersyncApi(SERVICE_URL).getInfo()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('XbrowsersyncApi.createSync', () => {
  it('posts the version and returns the created sync', async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ id: 'abc', lastUpdated: '2026-01-01T00:00:00.000Z', version: '1.1.13' }),
    );
    const result = await new XbrowsersyncApi(SERVICE_URL).createSync('1.1.13');

    expect(result.id).toBe('abc');
    const call = await readCall(fetchMock);
    expect(call.url).toBe(`${SERVICE_URL}/bookmarks`);
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ version: '1.1.13' });
  });

  it('maps 405 to NotAcceptingNewSyncsError', async () => {
    mockFetch(() => jsonResponse({ code: 'NewSyncsForbiddenException', message: 'no' }, 405));
    await expect(new XbrowsersyncApi(SERVICE_URL).createSync('1.1.13')).rejects.toBeInstanceOf(
      NotAcceptingNewSyncsError,
    );
  });

  it('maps 406 to DailyNewSyncLimitReachedError', async () => {
    mockFetch(() => jsonResponse({ code: 'NewSyncsLimitExceededException', message: 'no' }, 406));
    await expect(new XbrowsersyncApi(SERVICE_URL).createSync('1.1.13')).rejects.toBeInstanceOf(
      DailyNewSyncLimitReachedError,
    );
  });
});

describe('XbrowsersyncApi.getSync', () => {
  it('returns the sync data', async () => {
    mockFetch(() =>
      jsonResponse({
        bookmarks: 'cipher',
        version: '1.1.13',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      }),
    );
    const data = await new XbrowsersyncApi(SERVICE_URL).getSync('id1');
    expect(data.bookmarks).toBe('cipher');
  });

  it('defaults missing bookmarks to an empty string', async () => {
    mockFetch(() => jsonResponse({ version: '1.1.13', lastUpdated: '2026-01-01T00:00:00.000Z' }));
    const data = await new XbrowsersyncApi(SERVICE_URL).getSync('id1');
    expect(data.bookmarks).toBe('');
  });

  it('maps 401 to SyncNotFoundError', async () => {
    mockFetch(() => jsonResponse({ code: 'SyncNotFoundException', message: 'gone' }, 401));
    await expect(new XbrowsersyncApi(SERVICE_URL).getSync('id1')).rejects.toBeInstanceOf(
      SyncNotFoundError,
    );
  });
});

describe('XbrowsersyncApi.updateSync', () => {
  it('sends bookmarks plus the conflict-detection timestamp', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ lastUpdated: '2026-02-02T00:00:00.000Z' }));
    const lastUpdated = await new XbrowsersyncApi(SERVICE_URL).updateSync(
      'id1',
      'cipher',
      '2026-01-01T00:00:00.000Z',
    );

    expect(lastUpdated).toBe('2026-02-02T00:00:00.000Z');
    const call = await readCall(fetchMock);
    expect(call.url).toBe(`${SERVICE_URL}/bookmarks/id1`);
    expect(call.method).toBe('PUT');
    expect(JSON.parse(call.body)).toEqual({
      bookmarks: 'cipher',
      lastUpdated: '2026-01-01T00:00:00.000Z',
    });
  });

  it('maps 409 to SyncConflictError', async () => {
    mockFetch(() => jsonResponse({ code: 'SyncConflictException', message: 'conflict' }, 409));
    await expect(
      new XbrowsersyncApi(SERVICE_URL).updateSync('id1', 'cipher', 'ts'),
    ).rejects.toBeInstanceOf(SyncConflictError);
  });

  it('maps 413 to RequestEntityTooLargeError', async () => {
    mockFetch(() => jsonResponse({ code: 'SyncDataLimitExceededException', message: 'big' }, 413));
    await expect(
      new XbrowsersyncApi(SERVICE_URL).updateSync('id1', 'cipher'),
    ).rejects.toBeInstanceOf(RequestEntityTooLargeError);
  });
});

describe('XbrowsersyncApi polling endpoints', () => {
  it('getLastUpdated returns the timestamp', async () => {
    mockFetch(() => jsonResponse({ lastUpdated: '2026-03-03T00:00:00.000Z' }));
    expect(await new XbrowsersyncApi(SERVICE_URL).getLastUpdated('id1')).toBe(
      '2026-03-03T00:00:00.000Z',
    );
  });

  it('getSyncVersion returns the version', async () => {
    mockFetch(() => jsonResponse({ version: '1.1.13' }));
    expect(await new XbrowsersyncApi(SERVICE_URL).getSyncVersion('id1')).toBe('1.1.13');
  });
});

describe('XbrowsersyncApi URL handling', () => {
  it('strips a trailing slash from the service URL', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ lastUpdated: 'ts' }));
    await new XbrowsersyncApi(`${SERVICE_URL}/`).getLastUpdated('id1');
    expect((await readCall(fetchMock)).url).toBe(`${SERVICE_URL}/bookmarks/id1/lastUpdated`);
  });
});
