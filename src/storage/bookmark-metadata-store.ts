import type { BookmarkMetadataMap } from '../bookmarks/metadata.js';
import type { StorageArea } from './storage-area.js';

/**
 * Storage key for the metadata sidecar. Deliberately outside {@link SyncStore}'s keys:
 * the sidecar describes the browser's bookmarks, which survive `disable()`, so it must
 * not be swept away with the sync credentials — a user who turns sync off and back on
 * would otherwise find every description and tag gone.
 */
const METADATA_KEY = 'bookmarkMetadata';

/**
 * Persistence for the bookmark metadata a browser cannot store natively (see
 * ../bookmarks/metadata.ts). Deliberately a plain get/set pair over the whole map: it is
 * read and rewritten as a unit on every bookmark read and write, and the callers that
 * change individual entries already hold the bookmark lock.
 */
export class BookmarkMetadataStore {
  constructor(private readonly area: StorageArea) {}

  async getAll(): Promise<BookmarkMetadataMap> {
    return (await this.area.get<BookmarkMetadataMap>(METADATA_KEY)) ?? {};
  }

  setAll(map: BookmarkMetadataMap): Promise<void> {
    return this.area.set(METADATA_KEY, map);
  }

  clear(): Promise<void> {
    return this.area.remove(METADATA_KEY);
  }
}
