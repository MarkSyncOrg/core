import { validateBookmarkTree } from './validate.js';

// The xBrowserSync bookmark data model and the pure transforms used to convert a
// browser's native bookmark tree to/from it. This format is a compatibility contract:
// the encrypted sync payload is exactly `JSON.stringify(Bookmark[])`, and other
// xBrowserSync clients must be able to read what we write.

/** Top-level container folders. They mirror the browser's bookmark roots. */
export enum BookmarkContainer {
  Menu = '[xbs] Menu',
  Other = '[xbs] Other',
  Toolbar = '[xbs] Toolbar',
}

export enum BookmarkType {
  Bookmark = 'bookmark',
  Container = 'container',
  Folder = 'folder',
  Separator = 'separator',
}

/** Sentinel URL used to represent a separator in the synced data. */
export const SEPARATOR_URL = 'xbs:separator';

/** Maximum stored description length (longer text is trimmed to a word boundary). */
export const DESCRIPTION_MAX_LENGTH = 300;

const CONTAINER_NAMES: string[] = Object.values(BookmarkContainer);

/** A node in the xBrowserSync bookmark tree. */
export interface Bookmark {
  id?: number;
  title?: string;
  url?: string;
  description?: string;
  tags?: string[];
  children?: Bookmark[];
}

/** A browser-agnostic native bookmark node (the SW adapter maps real nodes to this). */
export interface NativeBookmarkNode {
  title?: string;
  url?: string;
  /** Native node type; 'separator' on browsers that support separators (Firefox). */
  type?: string;
  children?: NativeBookmarkNode[];
}

const VALID_KEYS: (keyof Bookmark)[] = ['children', 'description', 'id', 'tags', 'title', 'url'];

/** Trims text to a limit at the nearest preceding word boundary, adding an ellipsis. */
export function trimToNearestWord(text: string | undefined, limit: number): string {
  if (!text) {
    return '';
  }
  const trimmed = text.trim();
  if (limit >= trimmed.length) {
    return trimmed;
  }
  // lastIndexOf returns -1 when no space precedes the limit (a single long token).
  // Falling back to a hard cut keeps the text; substring(0, -1) would discard all of it.
  const boundary = trimmed.lastIndexOf(' ', limit);
  return `${trimmed.substring(0, boundary === -1 ? limit : boundary)}…`;
}

/** Classifies a bookmark by its shape. */
export function getBookmarkType(bookmark: Bookmark): BookmarkType {
  if (bookmark.url === SEPARATOR_URL) {
    return BookmarkType.Separator;
  }
  if (!bookmark.url && bookmark.title !== undefined && CONTAINER_NAMES.includes(bookmark.title)) {
    return BookmarkType.Container;
  }
  if (bookmark.url) {
    return BookmarkType.Bookmark;
  }
  return BookmarkType.Folder;
}

/** Removes invalid and empty properties, keeping the canonical shape. */
export function cleanBookmark(bookmark: Bookmark): Bookmark {
  const cleaned: Bookmark = {};
  for (const key of VALID_KEYS) {
    const value = bookmark[key];
    if (value === undefined) {
      continue;
    }
    if (key === 'description' && String(value).trim() === '') {
      continue;
    }
    if (key === 'tags' && (value as string[]).length === 0) {
      continue;
    }
    Object.assign(cleaned, { [key]: value });
  }
  return cleaned;
}

/** Recursively cleans a bookmark tree. */
export function cleanAllBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks.map((bookmark) => {
    const cleaned = cleanBookmark(bookmark);
    if (Array.isArray(cleaned.children)) {
      cleaned.children = cleanAllBookmarks(cleaned.children);
    }
    return cleaned;
  });
}

/** Visits every bookmark in a tree (pre-order). */
export function eachBookmark(bookmarks: Bookmark[], iteratee: (bookmark: Bookmark) => void): void {
  for (const bookmark of bookmarks) {
    iteratee(bookmark);
    if (bookmark.children?.length) {
      eachBookmark(bookmark.children, iteratee);
    }
  }
}

/**
 * Creates a canonical bookmark. A URL makes it a leaf bookmark; otherwise it is a
 * folder (with an empty children array). Separators keep only their sentinel URL.
 *
 * Deliberately does not filter URL schemes — it is a model constructor, and the browser's
 * own tree may legitimately contain bookmarklets. Trees built from untrusted input must
 * go through `acceptBookmarkTree`, and anything about to be rendered as a link or
 * navigated to should be checked with `isSafeBookmarkUrl` (see ./validate.ts).
 */
export function newBookmark(
  title?: string,
  url?: string,
  description?: string,
  tags?: string[],
): Bookmark {
  const bookmark: Bookmark = {};
  const trimmedUrl = url?.trim();
  const trimmedTitle = title?.trim();

  if (trimmedUrl) {
    bookmark.url = trimmedUrl;
  } else {
    bookmark.children = [];
  }
  if (trimmedTitle) {
    bookmark.title = trimmedTitle;
  }
  const trimmedDescription = trimToNearestWord(description, DESCRIPTION_MAX_LENGTH);
  if (trimmedDescription) {
    bookmark.description = trimmedDescription;
  }
  if (tags?.length) {
    bookmark.tags = tags;
  }

  // A separator carries no metadata other than its sentinel URL.
  if (getBookmarkType(bookmark) === BookmarkType.Separator) {
    return { url: SEPARATOR_URL };
  }

  return cleanBookmark(bookmark);
}

/**
 * Converts a native bookmark tree into xBrowserSync bookmarks (without IDs).
 *
 * Preserves URLs verbatim, including bookmarklets. The sync engine sanitises the local
 * tree before it is uploaded or compared, so unsafe URLs never reach the service; a
 * consumer calling this directly is responsible for the same check.
 */
export function nativeToBookmarks(nodes: NativeBookmarkNode[] = []): Bookmark[] {
  return nodes.map((node) => {
    if (node.type === 'separator' || node.url === SEPARATOR_URL) {
      return newBookmark(undefined, SEPARATOR_URL);
    }
    const bookmark = newBookmark(node.title, node.url);
    if (node.children?.length) {
      bookmark.children = nativeToBookmarks(node.children);
    }
    return bookmark;
  });
}

/**
 * Assigns sequential IDs to every node in pre-order (the xBrowserSync scheme), returning
 * a new tree. IDs are unique within the sync and are what id-mappings reference.
 */
export function assignIds(bookmarks: Bookmark[], startId = 1): Bookmark[] {
  let nextId = startId;
  const walk = (nodes: Bookmark[]): Bookmark[] =>
    nodes.map((node) => {
      const copy: Bookmark = { ...node, id: nextId };
      nextId += 1;
      if (node.children) {
        copy.children = walk(node.children);
      }
      return copy;
    });
  return walk(bookmarks);
}

/** Finds (or optionally creates and appends) a top-level container by name. */
export function getContainer(
  name: BookmarkContainer,
  bookmarks: Bookmark[],
  createIfMissing = false,
): Bookmark | undefined {
  let container = bookmarks.find((bookmark) => bookmark.title === name);
  if (!container && createIfMissing) {
    container = newBookmark(name);
    bookmarks.push(container);
  }
  return container;
}

/**
 * Puts back the top-level containers this device has no room for.
 *
 * No browser has a root for every container: Chromium has no bookmarks menu, and the
 * toolbar is left out entirely while that setting is off. The local tree therefore comes
 * back without them, and uploading it as it stands would delete them from the sync for
 * every other device. Worse, it never settles — the device that dropped a container reads
 * it back from its own roots on the next pass and pushes it again, so two browsers of
 * different families overwrite each other for as long as both are running.
 *
 * A container in `reference` (the tree the sync last held) with no counterpart locally is
 * therefore carried through untouched, at the position it held there. Only containers are
 * treated this way: their titles are reserved, and unlike a folder the user can delete,
 * a missing one always means "this browser cannot hold it", never "it was removed".
 */
export function restoreMissingContainers(
  bookmarks: Bookmark[],
  reference: readonly Bookmark[],
): Bookmark[] {
  const isContainer = (node: Bookmark) => getBookmarkType(node) === BookmarkType.Container;
  const present = new Set(bookmarks.filter(isContainer).map((node) => node.title));
  const result = [...bookmarks];
  reference.forEach((node, index) => {
    if (isContainer(node) && !present.has(node.title)) {
      result.splice(Math.min(index, result.length), 0, node);
    }
  });
  return result;
}

/** Returns a copy of the tree with all IDs removed (recursively). */
export function stripIds(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks.map(({ id, ...rest }) => {
    const copy: Bookmark = { ...rest };
    if (rest.children) {
      copy.children = stripIds(rest.children);
    }
    return copy;
  });
}

/**
 * Returns a canonical, ID-independent serialisation used to compare two trees for
 * equality (e.g. dirty detection). IDs are excluded because they differ between a
 * locally rebuilt tree and the one stored remotely.
 *
 * Recurses, so it expects a tree already accepted by `validateBookmarkTree` — that is
 * what bounds the depth. This is the hot path for dirty detection, so the check is not
 * repeated here; callers handling untrusted input must validate first.
 */
export function canonicalizeBookmarks(bookmarks: Bookmark[]): string {
  return serializeBookmarks(stripIds(bookmarks));
}

/** Serialises bookmarks to the JSON string that is encrypted and synced. */
export function serializeBookmarks(bookmarks: Bookmark[]): string {
  return JSON.stringify(cleanAllBookmarks(bookmarks));
}

/**
 * Parses the decrypted sync payload back into bookmarks.
 *
 * The payload is authenticated by AES-GCM, but anyone sharing the sync can write it, so
 * it is validated like any other untrusted input.
 *
 * @throws {InvalidBookmarkDataError} if the payload is not a well-formed bookmark tree.
 */
export function deserializeBookmarks(json: string): Bookmark[] {
  return validateBookmarkTree(JSON.parse(json));
}
