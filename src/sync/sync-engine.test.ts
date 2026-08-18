import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assignIds,
  type Bookmark,
  BookmarkContainer,
  canonicalizeBookmarks,
  deserializeBookmarks,
  serializeBookmarks,
  stripIds,
} from '../bookmarks/bookmark';
import { encryptData, getPasswordHash } from '../crypto/crypto';
import {
  InvalidCredentialsError,
  SyncConflictError,
  SyncDirectionError,
  SyncNotEnabledError,
} from '../errors';
import { MemoryStorageArea } from '../storage/storage-area';
import { type SyncDirection, SyncStore } from '../storage/sync-store';
import type { BookmarkProvider } from './bookmark-provider';
import { type ApiClient, SyncEngine } from './sync-engine';

const APP_VERSION = '1.1.13';
const SERVICE_URL = 'https://api.example.org';
const SYNC_ID = '52758cb942814faa9ab255208025ae65';

class FakeProvider implements BookmarkProvider {
  bookmarks: Bookmark[] = [];
  getBookmarks = vi.fn(async (): Promise<Bookmark[]> => structuredClone(this.bookmarks));
  setBookmarks = vi.fn(async (bookmarks: Bookmark[]): Promise<void> => {
    this.bookmarks = bookmarks;
  });
}

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getInfo: vi.fn(async () => ({
      status: 1 as const,
      version: APP_VERSION,
      location: 'GB',
      maxSyncSize: 1048576,
      message: '',
    })),
    createSync: vi.fn(async () => ({ id: SYNC_ID, lastUpdated: 'T0', version: APP_VERSION })),
    getSync: vi.fn(async () => ({ bookmarks: '', version: APP_VERSION, lastUpdated: 'T0' })),
    getLastUpdated: vi.fn(async () => 'T0'),
    updateSync: vi.fn(async () => 'T1'),
    ...overrides,
  };
}

const sampleBookmarks: Bookmark[] = [
  { title: BookmarkContainer.Toolbar, children: [{ title: 'X', url: 'https://x.org' }] },
];

function buildEngine(api: ApiClient) {
  const store = new SyncStore(new MemoryStorageArea());
  const provider = new FakeProvider();
  const engine = new SyncEngine({ store, provider, appVersion: APP_VERSION, createApi: () => api });
  return { store, provider, engine };
}

describe('SyncEngine.enableNewSync', () => {
  it('creates a sync, uploads encrypted local bookmarks and persists state', async () => {
    const api = fakeApi({ updateSync: vi.fn(async () => 'T1') });
    const { store, provider, engine } = buildEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);

    const syncId = await engine.enableNewSync(SERVICE_URL, 'pw');

    expect(syncId).toBe(SYNC_ID);
    const expectedHash = await getPasswordHash('pw', SYNC_ID);
    expect(await store.getSyncInfo()).toEqual({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: expectedHash,
    });
    expect(await store.getLastUpdated()).toBe('T1');
    expect(await store.isSyncEnabled()).toBe(true);

    // The uploaded payload decrypts to the local bookmarks with IDs assigned.
    const [, payload, lastUpdated, version] = (api.updateSync as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(lastUpdated).toBe('T0');
    expect(version).toBe(APP_VERSION);
    const { decryptData } = await import('../crypto/crypto');
    const decrypted = deserializeBookmarks(await decryptData(payload as string, expectedHash));
    expect(decrypted).toEqual(assignIds(sampleBookmarks));
  });
});

describe('SyncEngine.enableExistingSync', () => {
  it('downloads, decrypts and applies remote bookmarks', async () => {
    const hash = await getPasswordHash('pw', SYNC_ID);
    const encrypted = await encryptData(serializeBookmarks(sampleBookmarks), hash);
    const api = fakeApi({
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T9',
      })),
    });
    const { store, provider, engine } = buildEngine(api);

    await engine.enableExistingSync(SERVICE_URL, SYNC_ID, 'pw');

    expect(provider.setBookmarks).toHaveBeenCalledOnce();
    expect(provider.bookmarks).toEqual(deserializeBookmarks(serializeBookmarks(sampleBookmarks)));
    expect(await store.getLastUpdated()).toBe('T9');
    expect(await store.isSyncEnabled()).toBe(true);
  });

  it('throws InvalidCredentialsError for a wrong password', async () => {
    const hash = await getPasswordHash('pw', SYNC_ID);
    const encrypted = await encryptData(serializeBookmarks(sampleBookmarks), hash);
    const api = fakeApi({
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T9',
      })),
    });
    const { engine } = buildEngine(api);

    await expect(engine.enableExistingSync(SERVICE_URL, SYNC_ID, 'wrong')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('applies an empty tree for an empty sync', async () => {
    const api = fakeApi({
      getSync: vi.fn(async () => ({ bookmarks: '', version: APP_VERSION, lastUpdated: 'T9' })),
    });
    const { provider, engine } = buildEngine(api);
    await engine.enableExistingSync(SERVICE_URL, SYNC_ID, 'pw');
    expect(provider.bookmarks).toEqual([]);
  });
});

describe('SyncEngine.pull', () => {
  async function enabledEngine(api: ApiClient) {
    const built = buildEngine(api);
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: await getPasswordHash('pw', SYNC_ID),
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
    return built;
  }

  it('does nothing when the remote timestamp is unchanged', async () => {
    const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
    const { provider, engine } = await enabledEngine(api);
    expect(await engine.pull()).toBe(false);
    expect(provider.setBookmarks).not.toHaveBeenCalled();
  });

  it('downloads and applies bookmarks when the remote changed', async () => {
    const hash = await getPasswordHash('pw', SYNC_ID);
    const encrypted = await encryptData(serializeBookmarks(sampleBookmarks), hash);
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
    });
    const { store, provider, engine } = await enabledEngine(api);

    expect(await engine.pull()).toBe(true);
    expect(provider.bookmarks).toEqual(deserializeBookmarks(serializeBookmarks(sampleBookmarks)));
    expect(await store.getLastUpdated()).toBe('T2');
  });

  it('throws SyncNotEnabledError when sync is disabled', async () => {
    const { engine } = buildEngine(fakeApi());
    await expect(engine.pull()).rejects.toBeInstanceOf(SyncNotEnabledError);
  });
});

describe('SyncEngine.push', () => {
  async function enabledEngine(api: ApiClient) {
    const built = buildEngine(api);
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: await getPasswordHash('pw', SYNC_ID),
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
    return built;
  }

  it('uploads encrypted bookmarks with the conflict timestamp and stores the new one', async () => {
    const api = fakeApi({ updateSync: vi.fn(async () => 'T2') });
    const { store, provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);

    await engine.push();

    const [id, payload, lastUpdated] = (api.updateSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(id).toBe(SYNC_ID);
    expect(lastUpdated).toBe('T1');
    const { decryptData } = await import('../crypto/crypto');
    const hash = await getPasswordHash('pw', SYNC_ID);
    expect(deserializeBookmarks(await decryptData(payload as string, hash))).toEqual(
      assignIds(sampleBookmarks),
    );
    expect(await store.getLastUpdated()).toBe('T2');
  });

  it('propagates a SyncConflictError from the service', async () => {
    const api = fakeApi({
      updateSync: vi.fn(async () => {
        throw new SyncConflictError();
      }),
    });
    const { engine } = await enabledEngine(api);
    await expect(engine.push()).rejects.toBeInstanceOf(SyncConflictError);
  });
});

describe('SyncEngine.isDirty', () => {
  it('is false before any sync (no cache yet)', async () => {
    const { provider, engine } = buildEngine(fakeApi());
    provider.bookmarks = structuredClone(sampleBookmarks);
    expect(await engine.isDirty()).toBe(false);
  });

  it('is false right after enabling a new sync', async () => {
    const { provider, engine } = buildEngine(fakeApi());
    provider.bookmarks = structuredClone(sampleBookmarks);
    await engine.enableNewSync(SERVICE_URL, 'pw');
    expect(await engine.isDirty()).toBe(false);
  });

  it('becomes true after local bookmarks change', async () => {
    const { provider, engine } = buildEngine(fakeApi());
    provider.bookmarks = structuredClone(sampleBookmarks);
    await engine.enableNewSync(SERVICE_URL, 'pw');

    provider.bookmarks[0]!.children!.push({ title: 'New', url: 'https://new.org' });
    expect(await engine.isDirty()).toBe(true);
  });

  it('is false again after a pull applies remote bookmarks', async () => {
    const hash = await getPasswordHash('pw', SYNC_ID);
    const encrypted = await encryptData(serializeBookmarks(sampleBookmarks), hash);
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
    });
    const { store, provider, engine } = buildEngine(api);
    provider.bookmarks = [{ title: 'stale', url: 'https://stale.org' }];
    await store.setSyncInfo({ serviceUrl: SERVICE_URL, syncId: SYNC_ID, passwordHash: hash });
    await store.setSyncEnabled(true);
    await store.setLastUpdated('T1');

    expect(await engine.pull()).toBe(true);
    expect(await engine.isDirty()).toBe(false);
  });
});

describe('SyncEngine.sync', () => {
  async function enabledEngine(api: ApiClient) {
    const built = buildEngine(api);
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: await getPasswordHash('pw', SYNC_ID),
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
    return built;
  }

  /** Seeds the cached base tree so isDirty/merge have a known ancestor. */
  async function seedBase(store: SyncStore, base: Bookmark[]) {
    const { canonicalizeBookmarks } = await import('../bookmarks/bookmark');
    await store.setCachedBookmarks(canonicalizeBookmarks(base));
  }

  it('is idle when neither side changed', async () => {
    const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
    const { store, provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);
    await seedBase(store, sampleBookmarks);

    expect(await engine.sync()).toBe('idle');
    expect(api.updateSync).not.toHaveBeenCalled();
    expect(provider.setBookmarks).not.toHaveBeenCalled();
  });

  it('pushes when only local changed', async () => {
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T1'),
      updateSync: vi.fn(async () => 'T2'),
    });
    const { store, provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);
    await seedBase(store, sampleBookmarks);
    provider.bookmarks[0]!.children!.push({ title: 'New', url: 'https://new.org' });

    expect(await engine.sync()).toBe('pushed');
    expect(api.updateSync).toHaveBeenCalledOnce();
    expect(await store.getLastUpdated()).toBe('T2');
  });

  it('pulls when only remote changed', async () => {
    const hash = await getPasswordHash('pw', SYNC_ID);
    const remoteTree: Bookmark[] = [
      { title: BookmarkContainer.Toolbar, children: [{ title: 'R', url: 'https://r.org' }] },
    ];
    const encrypted = await encryptData(serializeBookmarks(remoteTree), hash);
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
    });
    const { store, provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);
    await seedBase(store, sampleBookmarks);

    expect(await engine.sync()).toBe('pulled');
    expect(provider.bookmarks).toEqual(deserializeBookmarks(serializeBookmarks(remoteTree)));
    expect(await store.getLastUpdated()).toBe('T2');
  });

  it('three-way merges when both sides changed, keeping both additions', async () => {
    const hash = await getPasswordHash('pw', SYNC_ID);
    // Remote added a bookmark; local (below) adds a different one.
    const remoteTree: Bookmark[] = [
      {
        title: BookmarkContainer.Toolbar,
        children: [
          { title: 'X', url: 'https://x.org' },
          { title: 'Remote', url: 'https://remote.org' },
        ],
      },
    ];
    const encrypted = await encryptData(serializeBookmarks(remoteTree), hash);
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
      updateSync: vi.fn(async () => 'T3'),
    });
    const { store, provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);
    await seedBase(store, sampleBookmarks);
    provider.bookmarks[0]!.children!.push({ title: 'Local', url: 'https://local.org' });

    expect(await engine.sync()).toBe('merged');

    const urls = provider.bookmarks[0]!.children!.map((n) => n.url);
    expect(urls).toEqual(
      expect.arrayContaining(['https://x.org', 'https://remote.org', 'https://local.org']),
    );
    // Merge was uploaded against the server timestamp and the new one stored.
    const [, , sentLastUpdated] = (api.updateSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sentLastUpdated).toBe('T2');
    expect(await store.getLastUpdated()).toBe('T3');
  });

  it('throws when sync is not enabled', async () => {
    const { engine } = buildEngine(fakeApi());
    await expect(engine.sync()).rejects.toBeInstanceOf(SyncNotEnabledError);
  });
});

describe('SyncEngine status and disable', () => {
  let built: ReturnType<typeof buildEngine>;

  beforeEach(async () => {
    built = buildEngine(fakeApi());
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: 'hash',
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
  });

  it('reports status', async () => {
    expect(await built.engine.getStatus()).toEqual({
      enabled: true,
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      lastUpdated: 'T1',
      direction: 'two-way',
    });
  });

  it('clears all state on disable', async () => {
    await built.engine.disable();
    expect(await built.engine.getStatus()).toEqual({
      enabled: false,
      serviceUrl: undefined,
      syncId: undefined,
      lastUpdated: undefined,
      // Settings survive a disable, so the direction is still the configured one.
      direction: 'two-way',
    });
  });
});

describe('SyncEngine.restore', () => {
  const restored: Bookmark[] = [
    { title: BookmarkContainer.Toolbar, children: [{ title: 'Restored', url: 'https://r.org' }] },
  ];

  async function enabledEngine(api: ApiClient) {
    const built = buildEngine(api);
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: await getPasswordHash('pw', SYNC_ID),
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
    return built;
  }

  it('applies the tree locally and uploads it when sync is enabled', async () => {
    const api = fakeApi({ updateSync: vi.fn(async () => 'T2') });
    const { store, provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);

    await engine.restore(restored);

    expect(provider.bookmarks).toEqual(restored);
    expect(api.updateSync).toHaveBeenCalledTimes(1);
    expect(await store.getLastUpdated()).toBe('T2');
    // Cache reflects the restored tree, so a later pull does not see it as a local edit.
    expect(await engine.isDirty()).toBe(false);
  });

  it('only replaces local bookmarks when sync is disabled', async () => {
    const api = fakeApi();
    const { provider, engine } = buildEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);

    await engine.restore(restored);

    expect(provider.bookmarks).toEqual(restored);
    expect(api.updateSync).not.toHaveBeenCalled();
  });
});

describe('SyncEngine.forcePull / forcePush', () => {
  async function enabledEngine(api: ApiClient) {
    const built = buildEngine(api);
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: await getPasswordHash('pw', SYNC_ID),
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
    return built;
  }

  it('forcePull applies the server tree even when timestamps match', async () => {
    const hash = await getPasswordHash('pw', SYNC_ID);
    const remoteTree: Bookmark[] = [
      { title: BookmarkContainer.Toolbar, children: [{ title: 'Remote', url: 'https://s.org' }] },
    ];
    const encrypted = await encryptData(serializeBookmarks(remoteTree), hash);
    // Same lastUpdated as local: a normal pull would short-circuit and do nothing.
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T1'),
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T1',
      })),
    });
    const { provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);

    await engine.forcePull();

    expect(provider.bookmarks).toEqual(remoteTree);
  });

  it('forcePush uploads against the server timestamp, bypassing conflict detection', async () => {
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T9'),
      updateSync: vi.fn(async () => 'T10'),
    });
    const { store, provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(sampleBookmarks);

    await engine.forcePush();

    const [, , sentLastUpdated] = (api.updateSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sentLastUpdated).toBe('T9');
    expect(await store.getLastUpdated()).toBe('T10');
  });

  it('throws when sync is not enabled', async () => {
    const { engine } = buildEngine(fakeApi());
    await expect(engine.forcePull()).rejects.toBeInstanceOf(SyncNotEnabledError);
    await expect(engine.forcePush()).rejects.toBeInstanceOf(SyncNotEnabledError);
  });
});

// Regression tests for issue #3: a bookmarklet is excluded from the sync, which is not
// the same as being deleted from the browser. Applying a remote tree is a destructive
// full-tree write, so it has to put back what it filtered out on the way up.
describe('SyncEngine local bookmarklets', () => {
  const BOOKMARKLET = 'javascript:void(0)';

  /** Local tree with a bookmarklet sitting between two ordinary bookmarks. */
  const localWithBookmarklet: Bookmark[] = [
    {
      title: BookmarkContainer.Toolbar,
      children: [
        { title: 'X', url: 'https://x.org' },
        { title: 'Let', url: BOOKMARKLET },
      ],
    },
  ];

  async function enabledEngine(api: ApiClient) {
    const built = buildEngine(api);
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: await getPasswordHash('pw', SYNC_ID),
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
    return built;
  }

  async function encryptedTree(bookmarks: Bookmark[]): Promise<string> {
    return encryptData(serializeBookmarks(bookmarks), await getPasswordHash('pw', SYNC_ID));
  }

  it('keeps a local bookmarklet when a pull overwrites the tree', async () => {
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: await encryptedTree(sampleBookmarks),
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
    });
    const { provider, engine } = await enabledEngine(api);
    provider.bookmarks = structuredClone(localWithBookmarklet);

    expect(await engine.pull()).toBe(true);

    expect(provider.bookmarks).toEqual(localWithBookmarklet);
  });

  it('keeps it out of the upload but in the browser across enable + force pull', async () => {
    // The reproduction from the issue: enable a new sync, then pull the tree back down.
    const uploaded: string[] = [];
    const api = fakeApi({
      updateSync: vi.fn(async (_syncId: string, bookmarks: string) => {
        uploaded.push(bookmarks);
        return 'T1';
      }),
      getSync: vi.fn(async () => ({
        bookmarks: uploaded[uploaded.length - 1] ?? '',
        version: APP_VERSION,
        lastUpdated: 'T1',
      })),
    });

    const { provider, engine } = buildEngine(api);
    provider.bookmarks = structuredClone(localWithBookmarklet);

    await engine.enableNewSync(SERVICE_URL, 'pw');
    await engine.forcePull();

    // IDs are assigned on upload, so compare the shape rather than the exact nodes.
    expect(stripIds(provider.bookmarks)).toEqual(localWithBookmarklet);
    // The service never saw it.
    const hash = await getPasswordHash('pw', SYNC_ID);
    const { decryptData } = await import('../crypto/crypto');
    const sent = deserializeBookmarks(await decryptData(uploaded[0]!, hash));
    expect(JSON.stringify(sent)).not.toContain('javascript:');
  });

  it('does not report the preserved bookmarklet as a local edit', async () => {
    // The cache holds the sanitised tree, so dirty detection still compares like with
    // like — otherwise the engine would push in a loop.
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: await encryptedTree(sampleBookmarks),
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
    });
    const { engine, provider } = await enabledEngine(api);
    provider.bookmarks = structuredClone(localWithBookmarklet);

    await engine.pull();

    expect(await engine.isDirty()).toBe(false);
  });

  it('keeps it through a three-way merge', async () => {
    const remoteTree: Bookmark[] = [
      {
        title: BookmarkContainer.Toolbar,
        children: [
          { title: 'X', url: 'https://x.org' },
          { title: 'Remote', url: 'https://remote.org' },
        ],
      },
    ];
    const api = fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: await encryptedTree(remoteTree),
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
      updateSync: vi.fn(async () => 'T3'),
    });
    const { store, provider, engine } = await enabledEngine(api);
    // Base: just X. Locally the user added Local (and keeps a bookmarklet), remotely
    // someone added Remote — both sides changed, so this goes down the merge path.
    await store.setCachedBookmarks(
      canonicalizeBookmarks([
        { title: BookmarkContainer.Toolbar, children: [{ title: 'X', url: 'https://x.org' }] },
      ]),
    );
    provider.bookmarks = [
      {
        title: BookmarkContainer.Toolbar,
        children: [
          { title: 'X', url: 'https://x.org' },
          { title: 'Let', url: BOOKMARKLET },
          { title: 'Local', url: 'https://local.org' },
        ],
      },
    ];

    expect(await engine.sync()).toBe('merged');

    const urls = provider.bookmarks[0]!.children!.map((node) => node.url);
    expect(urls).toContain(BOOKMARKLET);
    expect(urls).toContain('https://remote.org');
    expect(urls).toContain('https://local.org');
  });

  it('replaces it on restore, which is an explicit whole-tree replacement', async () => {
    const api = fakeApi();
    const { provider, engine } = buildEngine(api);
    provider.bookmarks = structuredClone(localWithBookmarklet);

    await engine.restore(sampleBookmarks);

    expect(provider.bookmarks).toEqual(sampleBookmarks);
  });
});

describe('SyncEngine one-way sync direction', () => {
  const remoteTree: Bookmark[] = [
    { title: BookmarkContainer.Toolbar, children: [{ title: 'R', url: 'https://r.org' }] },
  ];

  async function enabledEngine(api: ApiClient, direction: SyncDirection) {
    const built = buildEngine(api);
    await built.store.setSyncInfo({
      serviceUrl: SERVICE_URL,
      syncId: SYNC_ID,
      passwordHash: await getPasswordHash('pw', SYNC_ID),
    });
    await built.store.setSyncEnabled(true);
    await built.store.setLastUpdated('T1');
    await built.store.setSettings({ syncDirection: direction });
    built.provider.bookmarks = structuredClone(sampleBookmarks);
    await built.store.setCachedBookmarks(canonicalizeBookmarks(sampleBookmarks));
    return built;
  }

  /** An API whose sync holds `remoteTree` at timestamp `T2`. */
  async function changedRemoteApi(overrides: Partial<ApiClient> = {}): Promise<ApiClient> {
    const hash = await getPasswordHash('pw', SYNC_ID);
    const encrypted = await encryptData(serializeBookmarks(remoteTree), hash);
    return fakeApi({
      getLastUpdated: vi.fn(async () => 'T2'),
      getSync: vi.fn(async () => ({
        bookmarks: encrypted,
        version: APP_VERSION,
        lastUpdated: 'T2',
      })),
      ...overrides,
    });
  }

  describe('push-only', () => {
    it('uploads local edits over a remote that also changed', async () => {
      const api = await changedRemoteApi({ updateSync: vi.fn(async () => 'T3') });
      const { store, provider, engine } = await enabledEngine(api, 'push-only');
      provider.bookmarks[0]!.children!.push({ title: 'Local', url: 'https://local.org' });
      const local = structuredClone(provider.bookmarks);

      expect(await engine.sync()).toBe('pushed');

      // The remote tree never reaches the browser, and the upload is made against the
      // service's current timestamp so it wins instead of conflicting.
      expect(provider.setBookmarks).not.toHaveBeenCalled();
      expect(provider.bookmarks).toEqual(local);
      expect((api.updateSync as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBe('T2');
      expect(await store.getLastUpdated()).toBe('T3');
    });

    it('leaves a remote change alone without pretending to have applied it', async () => {
      const api = await changedRemoteApi();
      const { store, provider, engine } = await enabledEngine(api, 'push-only');

      expect(await engine.sync()).toBe('skipped');

      expect(provider.setBookmarks).not.toHaveBeenCalled();
      expect(provider.bookmarks).toEqual(sampleBookmarks);
      expect(api.updateSync).not.toHaveBeenCalled();
      // The stored timestamp stays behind the service's: advancing it would record a
      // revision this device never took, and the next sync would report `idle`.
      expect(await store.getLastUpdated()).toBe('T1');
    });

    it('pushes a local edit over a service that moved on, without conflicting', async () => {
      // The stored timestamp is stale by design after a skip, so `push` uploads against
      // the service's current one — this device cannot resolve a conflict by pulling.
      const api = await changedRemoteApi({ updateSync: vi.fn(async () => 'T3') });
      const { store, provider, engine } = await enabledEngine(api, 'push-only');
      provider.bookmarks[0]!.children!.push({ title: 'Local', url: 'https://local.org' });

      await engine.push();

      expect((api.updateSync as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBe('T2');
      expect(await store.getLastUpdated()).toBe('T3');
    });

    it('is idle when neither side changed', async () => {
      const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
      const { engine, provider } = await enabledEngine(api, 'push-only');

      expect(await engine.sync()).toBe('idle');
      expect(provider.setBookmarks).not.toHaveBeenCalled();
      expect(api.updateSync).not.toHaveBeenCalled();
    });

    it('refuses to pull', async () => {
      const api = await changedRemoteApi();
      const { engine, provider } = await enabledEngine(api, 'push-only');

      await expect(engine.pull()).rejects.toBeInstanceOf(SyncDirectionError);
      await expect(engine.forcePull()).rejects.toBeInstanceOf(SyncDirectionError);
      expect(provider.setBookmarks).not.toHaveBeenCalled();
    });

    it('still allows an explicit force push', async () => {
      const api = await changedRemoteApi({ updateSync: vi.fn(async () => 'T3') });
      const { engine } = await enabledEngine(api, 'push-only');

      await engine.forcePush();
      expect(api.updateSync).toHaveBeenCalledOnce();
    });
  });

  describe('pull-only', () => {
    it('applies remote changes even when there are local edits', async () => {
      const api = await changedRemoteApi();
      const { store, provider, engine } = await enabledEngine(api, 'pull-only');
      provider.bookmarks[0]!.children!.push({ title: 'Local', url: 'https://local.org' });

      expect(await engine.sync()).toBe('pulled');

      // No merge: the local edit is discarded rather than fed back into the sync.
      expect(provider.bookmarks).toEqual(deserializeBookmarks(serializeBookmarks(remoteTree)));
      expect(api.updateSync).not.toHaveBeenCalled();
      expect(await store.getLastUpdated()).toBe('T2');
    });

    it('reverts local edits when the remote has not changed', async () => {
      const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
      const { engine, provider } = await enabledEngine(api, 'pull-only');
      provider.bookmarks[0]!.children!.push({ title: 'Local', url: 'https://local.org' });

      expect(await engine.sync()).toBe('reverted');

      expect(provider.bookmarks).toEqual(deserializeBookmarks(serializeBookmarks(sampleBookmarks)));
      expect(api.updateSync).not.toHaveBeenCalled();
      expect(await engine.isDirty()).toBe(false);
    });

    it('is idle when neither side changed', async () => {
      const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
      const { engine, provider } = await enabledEngine(api, 'pull-only');

      expect(await engine.sync()).toBe('idle');
      expect(provider.setBookmarks).not.toHaveBeenCalled();
      expect(api.updateSync).not.toHaveBeenCalled();
    });

    it('refuses to push', async () => {
      const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
      const { engine } = await enabledEngine(api, 'pull-only');

      await expect(engine.push()).rejects.toBeInstanceOf(SyncDirectionError);
      await expect(engine.forcePush()).rejects.toBeInstanceOf(SyncDirectionError);
      expect(api.updateSync).not.toHaveBeenCalled();
    });

    it('restores a backup locally without uploading it', async () => {
      const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
      const { engine, provider } = await enabledEngine(api, 'pull-only');

      await engine.restore(remoteTree);

      expect(provider.bookmarks).toEqual(remoteTree);
      expect(api.updateSync).not.toHaveBeenCalled();
      // Cached with the restored tree, so the next sync does not read it as drift.
      expect(await engine.isDirty()).toBe(false);
    });
  });

  describe('joining an existing sync', () => {
    /** A store/provider pair with a direction set but no sync enabled yet. */
    async function pendingEngine(api: ApiClient, direction: SyncDirection) {
      const built = buildEngine(api);
      await built.store.setSettings({ syncDirection: direction });
      built.provider.bookmarks = structuredClone(sampleBookmarks);
      return built;
    }

    it('uploads instead of applying when the device only sends', async () => {
      const api = await changedRemoteApi({ updateSync: vi.fn(async () => 'T3') });
      const { store, provider, engine } = await pendingEngine(api, 'push-only');

      await engine.enableExistingSync(SERVICE_URL, SYNC_ID, 'pw');

      // The remote tree never lands in the browser — joining is not an exception to
      // "this device never receives".
      expect(provider.setBookmarks).not.toHaveBeenCalled();
      expect(provider.bookmarks).toEqual(sampleBookmarks);
      // ...and the service is left holding this device's tree instead.
      const [, , against] = (api.updateSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(against).toBe('T2');
      expect(await store.getLastUpdated()).toBe('T3');
      expect(await store.isSyncEnabled()).toBe(true);
      expect(await engine.isDirty()).toBe(false);
    });

    it('still rejects a wrong password before uploading anything', async () => {
      // Credentials are proven by decrypting the existing payload. Skipping that check
      // for a send-only device would re-encrypt the sync under a key nobody else holds.
      const api = await changedRemoteApi();
      const { store, engine } = await pendingEngine(api, 'push-only');

      await expect(engine.enableExistingSync(SERVICE_URL, SYNC_ID, 'wrong')).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      expect(api.updateSync).not.toHaveBeenCalled();
      expect(await store.isSyncEnabled()).toBe(false);
    });

    it('applies the remote tree when the device only receives', async () => {
      const api = await changedRemoteApi();
      const { store, provider, engine } = await pendingEngine(api, 'pull-only');

      await engine.enableExistingSync(SERVICE_URL, SYNC_ID, 'pw');

      expect(provider.bookmarks).toEqual(deserializeBookmarks(serializeBookmarks(remoteTree)));
      expect(api.updateSync).not.toHaveBeenCalled();
      expect(await store.getLastUpdated()).toBe('T2');
    });

    it('seeds a new sync from local bookmarks whatever the direction', async () => {
      // A new sync has to come from somewhere, so this upload happens even on a
      // receive-only device; it is the last thing that device ever sends.
      const api = fakeApi({ updateSync: vi.fn(async () => 'T1') });
      const { store, provider, engine } = await pendingEngine(api, 'pull-only');

      await engine.enableNewSync(SERVICE_URL, 'pw');

      expect(api.updateSync).toHaveBeenCalledOnce();
      expect(provider.setBookmarks).not.toHaveBeenCalled();
      expect(await store.isSyncEnabled()).toBe(true);
    });
  });

  describe('changing direction afterwards', () => {
    it('pulls what it skipped once a send-only device is switched back to two-way', async () => {
      // The case a user actually hits: set up one-way, change your mind in the settings.
      // The device must reconcile from the last state both sides shared, not report
      // `idle` against a sync whose current contents it has never seen.
      const api = await changedRemoteApi();
      const { store, provider, engine } = await enabledEngine(api, 'push-only');

      expect(await engine.sync()).toBe('skipped');

      await store.setSettings({ syncDirection: 'two-way' });
      expect(await engine.sync()).toBe('pulled');
      expect(provider.bookmarks).toEqual(deserializeBookmarks(serializeBookmarks(remoteTree)));
      expect(await store.getLastUpdated()).toBe('T2');
    });

    it('merges rather than overwrites when the switched device also has local edits', async () => {
      const api = await changedRemoteApi({ updateSync: vi.fn(async () => 'T3') });
      const { store, provider, engine } = await enabledEngine(api, 'push-only');
      expect(await engine.sync()).toBe('skipped');

      provider.bookmarks[0]!.children!.push({ title: 'Local', url: 'https://local.org' });
      await store.setSettings({ syncDirection: 'two-way' });

      expect(await engine.sync()).toBe('merged');
      // Neither side's addition is lost: the cached tree is still a valid merge base,
      // because a send-only device only ever advances it by uploading.
      const titles = provider.bookmarks[0]!.children!.map((child) => child.title);
      expect(titles).toContain('Local');
      expect(titles).toContain('R');
    });

    it('starts mirroring when a receive-only device is switched to two-way', async () => {
      // The reverse switch needs no repair: a receive-only device only ever advances the
      // timestamp by applying the tree that came with it.
      const api = fakeApi({ getLastUpdated: vi.fn(async () => 'T1') });
      const { store, provider, engine } = await enabledEngine(api, 'pull-only');
      provider.bookmarks[0]!.children!.push({ title: 'Local', url: 'https://local.org' });

      await store.setSettings({ syncDirection: 'two-way' });

      // The local edit is now legitimate and gets pushed instead of undone.
      expect(await engine.sync()).toBe('pushed');
      expect(api.updateSync).toHaveBeenCalledOnce();
    });
  });

  it('reports the configured direction in the status', async () => {
    const { engine } = await enabledEngine(fakeApi(), 'pull-only');
    expect((await engine.getStatus()).direction).toBe('pull-only');
  });
});
