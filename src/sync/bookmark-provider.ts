import type { Bookmark } from '../bookmarks/bookmark';

/**
 * Reads and writes the browser's bookmarks as an xBrowserSync container tree. This is
 * the single browser-specific seam of the sync engine; the engine itself stays
 * platform-agnostic and unit-testable against a fake provider.
 */
export interface BookmarkProvider {
  /** Returns the current bookmarks as xBrowserSync containers (IDs are not required). */
  getBookmarks(): Promise<Bookmark[]>;
  /** Replaces all browser bookmarks with the given xBrowserSync tree. */
  setBookmarks(bookmarks: Bookmark[]): Promise<void>;
}
