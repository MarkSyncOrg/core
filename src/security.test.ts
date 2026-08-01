// Regression tests for the findings in SECURITY-REVIEW.md. Each block names the finding
// it pins, so a future change that reopens one fails here with the reason attached.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidSyncId, normalizeServiceUrl, XbrowsersyncApi } from './api/xbrowsersync-api';
import { extractBookmarks, parseBackup } from './backup/backup';
import {
  type Bookmark,
  BookmarkContainer,
  deserializeBookmarks,
  trimToNearestWord,
} from './bookmarks/bookmark';
import {
  acceptBookmarkTree,
  isSafeBookmarkUrl,
  MAX_BOOKMARK_DEPTH,
  sanitizeBookmarkTree,
  validateBookmarkTree,
} from './bookmarks/validate';
import { encryptData, getPasswordHash } from './crypto/crypto';
import { InvalidBookmarkDataError, InvalidServiceError, SyncNotFoundError } from './errors';
import { Logger, redactSensitive } from './log/logger';
import { MemoryStorageArea } from './storage/storage-area';
import { SyncStore } from './storage/sync-store';
import type { BookmarkProvider } from './sync/bookmark-provider';
import { type ApiClient, SyncEngine } from './sync/sync-engine';

/** Wraps a bookmark tree in the current backup-file shape. */
function backupJson(bookmarks: unknown): string {
  return JSON.stringify({ xbrowsersync: { data: { bookmarks }, date: '2026-01-01' } });
}

/** Builds a tree nested `depth` levels deep. */
function nested(depth: number): Bookmark[] {
  let node: Bookmark = { title: 'leaf', children: [] };
  for (let i = 0; i < depth; i += 1) {
    node = { title: `f${i}`, children: [node] };
  }
  return [node];
}

describe('finding 1 — unsafe bookmark URL schemes', () => {
  it.each([
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects %j', (url) => {
    expect(isSafeBookmarkUrl(url)).toBe(false);
  });

  it.each([
    'https://example.org',
    'http://example.org',
    'ftp://files.example.org',
    'mailto:someone@example.org',
    'xbs:separator',
  ])('accepts %j', (url) => {
    expect(isSafeBookmarkUrl(url)).toBe(true);
  });

  it('treats a folder (no URL) as safe', () => {
    expect(isSafeBookmarkUrl(undefined)).toBe(true);
  });

  it('drops an unsafe node together with its subtree', () => {
    const tree: Bookmark[] = [
      { title: 'ok', url: 'https://good.org' },
      { title: 'bad', url: 'javascript:alert(1)', children: [{ title: 'hidden' }] },
      { title: 'folder', children: [{ title: 'nested bad', url: 'data:text/html,x' }] },
    ];
    expect(sanitizeBookmarkTree(tree)).toEqual([
      { title: 'ok', url: 'https://good.org' },
      { title: 'folder', children: [] },
    ]);
  });
});

describe('finding 2 — backup files are validated', () => {
  it.each([['a string', '"pwned"'], ['a number', '42'], ['an object', '{"a":1}']])(
    'rejects bookmarks that are %s',
    (_label, literal) => {
      expect(() => parseBackup(backupJson(JSON.parse(literal)))).toThrow(InvalidBookmarkDataError);
    },
  );

  it('rejects a node whose fields have the wrong types', () => {
    expect(() => parseBackup(backupJson([{ title: 42 }]))).toThrow(InvalidBookmarkDataError);
    expect(() => parseBackup(backupJson([{ tags: 'not-an-array' }]))).toThrow(
      InvalidBookmarkDataError,
    );
    expect(() => parseBackup(backupJson([{ children: 'nope' }]))).toThrow(InvalidBookmarkDataError);
  });

  it('still accepts a well-formed backup, and sanitises it on extraction', () => {
    const json = backupJson([
      { title: 'keep', url: 'https://good.org' },
      { title: 'drop', url: 'javascript:alert(1)' },
    ]);
    expect(extractBookmarks(parseBackup(json))).toEqual([{ title: 'keep', url: 'https://good.org' }]);
  });

  it('still accepts the legacy backup shape', () => {
    const json = JSON.stringify({ xBrowserSync: { bookmarks: [{ title: 'x', url: 'https://x.org' }] } });
    expect(extractBookmarks(parseBackup(json))).toEqual([{ title: 'x', url: 'https://x.org' }]);
  });

  it('tolerates unknown properties so a newer client stays readable', () => {
    const tree = extractBookmarks(parseBackup(backupJson([{ title: 'x', futureField: true }])));
    expect(tree).toHaveLength(1);
  });
});

describe('finding 3 — deep nesting cannot overflow the stack', () => {
  it('accepts a tree at the depth limit', () => {
    expect(() => validateBookmarkTree(nested(MAX_BOOKMARK_DEPTH - 1))).not.toThrow();
  });

  it('rejects a tree past the depth limit', () => {
    expect(() => validateBookmarkTree(nested(MAX_BOOKMARK_DEPTH + 5))).toThrow(
      InvalidBookmarkDataError,
    );
  });

  it('rejects a tree deep enough to have crashed the old walkers, without itself crashing', () => {
    // 10,000 levels overflowed cleanAllBookmarks/stripIds before the cap existed. Built
    // as text because JSON.stringify recurses and would overflow before the validator
    // ever saw it — which is also why the validator itself has to be iterative.
    const depth = 10_000;
    const deep = `${'{"children":['.repeat(depth)}{"title":"leaf"}${']}'.repeat(depth)}`;
    const json = `{"xbrowsersync":{"data":{"bookmarks":[${deep}]},"date":"2026-01-01"}}`;
    expect(() => parseBackup(json)).toThrow(InvalidBookmarkDataError);
  });
});

describe('finding 4 — service URL validation', () => {
  it.each([
    ['plain http to a remote host', 'http://sync.example.org'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a relative URL', 'not-a-url-at-all'],
    ['a query string that would swallow the path', 'https://evil.example.org/x?injected='],
    ['a fragment that would swallow the path', 'https://evil.example.org/#'],
    ['embedded credentials', 'https://user:pass@sync.example.org'],
  ])('rejects %s', (_label, url) => {
    expect(() => normalizeServiceUrl(url)).toThrow(InvalidServiceError);
  });

  it.each([
    ['https://sync.example.org', 'https://sync.example.org'],
    ['https://sync.example.org/', 'https://sync.example.org'],
    ['https://sync.example.org/xbs//', 'https://sync.example.org/xbs'],
    ['  https://sync.example.org  ', 'https://sync.example.org'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeServiceUrl(input)).toBe(expected);
  });

  it('rejects an unusable URL at construction, before any request is made', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => new XbrowsersyncApi('http://sync.example.org')).toThrow(InvalidServiceError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('finding 9 — sync ID format is enforced', () => {
  it.each(['52758cb942814faa9ab255208025ae65', '0'.repeat(32)])('accepts %j', (id) => {
    expect(isValidSyncId(id)).toBe(true);
  });

  it.each([
    ['too short', 'abc'],
    ['uppercase hex', '52758CB942814FAA9AB255208025AE65'],
    ['a traversal attempt', '../../admin'],
    ['hyphenated UUID', '52758cb9-4281-4faa-9ab2-55208025ae65'],
    ['empty', ''],
  ])('rejects %s', (_label, id) => {
    expect(isValidSyncId(id)).toBe(false);
  });

  it('rejects a malformed ID before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new XbrowsersyncApi('https://sync.example.org').getSync('../../admin')).rejects.toBeInstanceOf(
      SyncNotFoundError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('finding 10 — trimToNearestWord keeps text with no word boundary', () => {
  it('hard-cuts a single long token instead of discarding it', () => {
    const trimmed = trimToNearestWord('a'.repeat(400), 300);
    expect(trimmed).toBe(`${'a'.repeat(300)}…`);
  });

  it('still trims at a word boundary when one exists', () => {
    expect(trimToNearestWord('one two three', 8)).toBe('one two…');
  });
});

describe('finding 11 — trace log redaction', () => {
  it('redacts sync IDs, keys and URL credentials', () => {
    expect(redactSensitive('sync 52758cb942814faa9ab255208025ae65 failed')).toBe(
      'sync [redacted-sync-id] failed',
    );
    expect(redactSensitive(`key ${'A'.repeat(43)}=`)).toBe('key [redacted-key]');
    expect(redactSensitive('GET https://user:hunter2@sync.example.org/x')).toBe(
      'GET https://[redacted-credentials]@sync.example.org/x',
    );
  });

  it('leaves ordinary messages alone', () => {
    expect(redactSensitive('pull complete: 12 bookmarks')).toBe('pull complete: 12 bookmarks');
  });

  it('redacts on the way into storage', async () => {
    const logger = new Logger(new MemoryStorageArea());
    await logger.info('enabled sync 52758cb942814faa9ab255208025ae65');
    expect((await logger.getEntries())[0]?.message).toBe('enabled sync [redacted-sync-id]');
  });
});

describe('unsafe URLs are filtered symmetrically across a sync', () => {
  const APP_VERSION = '1.1.13';
  const SYNC_ID = '52758cb942814faa9ab255208025ae65';
  const PASSWORD = 'pw';

  class FakeProvider implements BookmarkProvider {
    bookmarks: Bookmark[] = [];
    getBookmarks = vi.fn(async (): Promise<Bookmark[]> => structuredClone(this.bookmarks));
    setBookmarks = vi.fn(async (bookmarks: Bookmark[]): Promise<void> => {
      this.bookmarks = bookmarks;
    });
  }

  let store: SyncStore;
  let provider: FakeProvider;
  let uploaded: string[];
  let clock: string;
  let api: ApiClient;
  let engine: SyncEngine;

  beforeEach(() => {
    uploaded = [];
    clock = 'T0';
    store = new SyncStore(new MemoryStorageArea());
    provider = new FakeProvider();
    api = {
      getInfo: vi.fn(async () => ({
        status: 1 as const,
        version: APP_VERSION,
        location: 'GB',
        maxSyncSize: 1048576,
        message: '',
      })),
      createSync: vi.fn(async () => ({ id: SYNC_ID, lastUpdated: 'T0', version: APP_VERSION })),
      getSync: vi.fn(async () => ({ bookmarks: '', version: APP_VERSION, lastUpdated: clock })),
      getLastUpdated: vi.fn(async () => clock),
      updateSync: vi.fn(async (_id: string, bookmarks: string) => {
        uploaded.push(bookmarks);
        clock = `T${uploaded.length}`;
        return clock;
      }),
    };
    engine = new SyncEngine({ store, provider, appVersion: APP_VERSION, createApi: () => api });
  });

  it('never uploads a local javascript: bookmark', async () => {
    provider.bookmarks = [
      {
        title: BookmarkContainer.Toolbar,
        children: [
          { title: 'good', url: 'https://good.org' },
          { title: 'evil', url: 'javascript:alert(1)' },
        ],
      },
    ];
    await engine.enableNewSync('https://sync.example.org', PASSWORD);

    const hash = await getPasswordHash(PASSWORD, SYNC_ID);
    const { decryptData } = await import('./crypto/crypto');
    const sent = deserializeBookmarks(await decryptData(uploaded[0]!, hash));
    const urls: string[] = [];
    JSON.stringify(sent, (_k, v) => ((v as Bookmark)?.url && urls.push((v as Bookmark).url!), v));
    expect(urls).toContain('https://good.org');
    expect(urls).not.toContain('javascript:alert(1)');
  });

  it('strips an unsafe bookmark injected by whoever shares the sync', async () => {
    const hash = await getPasswordHash(PASSWORD, SYNC_ID);
    const malicious = JSON.stringify([
      { title: BookmarkContainer.Toolbar, children: [{ title: 'evil', url: 'javascript:alert(1)' }] },
    ]);
    api.getSync = vi.fn(async () => ({
      bookmarks: await encryptData(malicious, hash),
      version: APP_VERSION,
      lastUpdated: 'T0',
    }));

    await engine.enableExistingSync('https://sync.example.org', SYNC_ID, PASSWORD);
    expect(JSON.stringify(provider.bookmarks)).not.toContain('javascript:');
  });

  it('does not report a device as permanently dirty because of a filtered bookmark', async () => {
    // Regression guard: filtering only the remote side would leave local and cached
    // unequal forever, and sync() would push on every single run.
    provider.bookmarks = [
      { title: BookmarkContainer.Toolbar, children: [{ title: 'evil', url: 'javascript:alert(1)' }] },
    ];
    await engine.enableNewSync('https://sync.example.org', PASSWORD);
    expect(await engine.isDirty()).toBe(false);
    expect(await engine.sync()).toBe('idle');
  });
});

describe('trees from an untrusted source go through one entry point', () => {
  it('acceptBookmarkTree validates and sanitises in a single call', () => {
    expect(() => acceptBookmarkTree('nope')).toThrow(InvalidBookmarkDataError);
    expect(acceptBookmarkTree([{ title: 'a', url: 'javascript:alert(1)' }])).toEqual([]);
  });

  it('deserializeBookmarks rejects a malformed decrypted payload', () => {
    expect(() => deserializeBookmarks('{"not":"array"}')).toThrow(InvalidBookmarkDataError);
    expect(() => deserializeBookmarks('[{"title":42}]')).toThrow(InvalidBookmarkDataError);
  });
});
