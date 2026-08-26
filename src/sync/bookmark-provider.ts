import type { Bookmark } from '../bookmarks/bookmark.js';

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
  /**
   * Whether this browser has anything to store a separator in. Only Firefox does;
   * Chromium has no equivalent, so a tree written there comes back without them.
   *
   * The engine needs to be told rather than to guess, because the two cases look
   * identical from the outside: a tree that has lost its separators to the browser and
   * one whose separators the user deleted read exactly the same. Assumed true when a
   * provider says nothing, since that is the plain reading of the tree it hands over.
   */
  readonly holdsSeparators?: boolean;
}
