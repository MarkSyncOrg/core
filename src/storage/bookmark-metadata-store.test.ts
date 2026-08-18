import { describe, expect, it } from 'vitest';
import { BookmarkMetadataStore } from './bookmark-metadata-store';
import { MemoryStorageArea } from './storage-area';
import { SyncStore } from './sync-store';

describe('BookmarkMetadataStore', () => {
  it('starts empty and round-trips a map', async () => {
    const store = new BookmarkMetadataStore(new MemoryStorageArea());
    expect(await store.getAll()).toEqual({});

    const map = { k: { url: 'https://x.org/', description: 'A site', tags: ['news'] } };
    await store.setAll(map);
    expect(await store.getAll()).toEqual(map);

    await store.clear();
    expect(await store.getAll()).toEqual({});
  });

  it('survives disabling sync, because the bookmarks it describes do', async () => {
    const area = new MemoryStorageArea();
    const metadata = new BookmarkMetadataStore(area);
    await metadata.setAll({ k: { url: 'https://x.org/', tags: ['news'] } });

    await new SyncStore(area).clear();

    expect(await metadata.getAll()).toEqual({ k: { url: 'https://x.org/', tags: ['news'] } });
  });
});
