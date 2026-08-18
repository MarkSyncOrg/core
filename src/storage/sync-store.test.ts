import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea } from './storage-area';
import { SyncStore, type SyncInfo } from './sync-store';

const syncInfo: SyncInfo = {
  serviceUrl: 'https://api.example.org',
  syncId: '52758cb942814faa9ab255208025ae65',
  passwordHash: 'SF+0IQyILGs7QS7bg2PxEa/MT+RnI/6YgWRZ6H5Fgxc=',
};

describe('SyncStore', () => {
  let store: SyncStore;

  beforeEach(() => {
    store = new SyncStore(new MemoryStorageArea());
  });

  it('round-trips sync info', async () => {
    await store.setSyncInfo(syncInfo);
    expect(await store.getSyncInfo()).toEqual(syncInfo);
  });

  it('returns undefined for unset values', async () => {
    expect(await store.getSyncInfo()).toBeUndefined();
    expect(await store.getSyncVersion()).toBeUndefined();
    expect(await store.getLastUpdated()).toBeUndefined();
  });

  it('defaults syncEnabled to false and bookmark mappings to an empty array', async () => {
    expect(await store.isSyncEnabled()).toBe(false);
    expect(await store.getBookmarkIdMappings()).toEqual([]);
  });

  it('persists version, lastUpdated, enabled flag and mappings', async () => {
    await store.setSyncVersion('1.1.13');
    await store.setLastUpdated('2026-01-01T00:00:00.000Z');
    await store.setSyncEnabled(true);
    await store.setBookmarkIdMappings([{ nativeId: '5', syncedId: 0 }]);

    expect(await store.getSyncVersion()).toBe('1.1.13');
    expect(await store.getLastUpdated()).toBe('2026-01-01T00:00:00.000Z');
    expect(await store.isSyncEnabled()).toBe(true);
    expect(await store.getBookmarkIdMappings()).toEqual([{ nativeId: '5', syncedId: 0 }]);
  });

  it('clear removes all sync state', async () => {
    await store.setSyncInfo(syncInfo);
    await store.setSyncVersion('1.1.13');
    await store.setSyncEnabled(true);

    await store.clear();

    expect(await store.getSyncInfo()).toBeUndefined();
    expect(await store.getSyncVersion()).toBeUndefined();
    expect(await store.isSyncEnabled()).toBe(false);
  });

  it('returns default settings when none are stored', async () => {
    expect(await store.getSettings()).toEqual({
      theme: 'system',
      syncIntervalMinutes: 15,
      syncBookmarksToolbar: true,
      syncOnChange: true,
      syncDirection: 'two-way',
    });
  });

  it('merges partial settings over existing values', async () => {
    await store.setSettings({ theme: 'dark' });
    const merged = await store.setSettings({ syncIntervalMinutes: 30 });
    expect(merged.theme).toBe('dark');
    expect(merged.syncIntervalMinutes).toBe(30);
    expect(merged.syncBookmarksToolbar).toBe(true);
  });

  it('preserves settings across clear()', async () => {
    await store.setSettings({ theme: 'light', syncOnChange: false, syncDirection: 'pull-only' });
    await store.setSyncInfo(syncInfo);
    await store.clear();

    const settings = await store.getSettings();
    expect(settings.theme).toBe('light');
    expect(settings.syncOnChange).toBe(false);
    expect(settings.syncDirection).toBe('pull-only');
  });
});
