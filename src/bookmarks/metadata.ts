// Local storage for the bookmark metadata a browser cannot hold.
//
// `description` and `tags` are part of the xBrowserSync bookmark model, but no browser's
// native bookmark node has anywhere to put them: the WebExtension bookmarks API stores a
// title, a URL and nothing else. The local tree is rebuilt from that native tree on every
// read, so metadata written by any client — this one, or xBrowserSync itself — survives
// only as long as it stays in the sync payload.
//
// That is not merely a missing feature, it is lossy. A pull writes the remote tree to the
// browser, which drops the metadata; the next dirty check then compares a local tree
// without it against a cached tree with it, concludes the user made an edit, and pushes
// the stripped tree back — silently erasing every description and tag in the sync for
// every device.
//
// So the metadata is kept beside the browser's bookmarks in a sidecar map, written
// whenever a tree is applied to the browser and laid back over the native tree whenever
// it is read. The sync engine and the wire format are untouched: everything above the
// provider keeps seeing whole `Bookmark` nodes with their metadata attached.
//
// Entries are keyed by the same content-based identity the three-way merge uses (see
// ./identity.js) — the path of match keys from the container down to the bookmark — so
// the sidecar and the merge always agree on which node is which.

import {
  type Bookmark,
  BookmarkType,
  DESCRIPTION_MAX_LENGTH,
  getBookmarkType,
  trimToNearestWord,
} from './bookmark.js';
import { keyBookmarkSiblings } from './identity.js';

/** The metadata a bookmark carries beyond its title and URL. */
export interface BookmarkMetadata {
  description?: string;
  tags?: string[];
}

/**
 * A sidecar entry. The URL is stored alongside the metadata rather than parsed back out
 * of the key, so a moved or reparented bookmark can still be recognised (see
 * {@link applyBookmarkMetadata}).
 */
export interface StoredBookmarkMetadata extends BookmarkMetadata {
  url: string;
}

/** The sidecar: bookmark identity path → metadata. */
export type BookmarkMetadataMap = Record<string, StoredBookmarkMetadata>;

/** Maximum number of tags kept on one bookmark. */
export const MAX_TAGS = 100;

/** Maximum length of a single tag. */
export const TAG_MAX_LENGTH = 50;

/**
 * The sidecar key for a bookmark, from its path of match keys (outermost first).
 *
 * JSON rather than a joined string: titles and URLs may contain any character, so no
 * separator is safe to split on, and two different paths must never produce one key.
 */
export function bookmarkMetadataKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/** The path a {@link bookmarkMetadataKey} was built from. */
export function bookmarkMetadataPath(key: string): string[] {
  return JSON.parse(key) as string[];
}

/** Whether a node is a leaf bookmark, the only kind of node that carries metadata. */
function carriesMetadata(node: Bookmark): boolean {
  return getBookmarkType(node) === BookmarkType.Bookmark;
}

/** The metadata actually worth storing for a node, or undefined when it has none. */
function metadataOf(node: Bookmark): BookmarkMetadata | undefined {
  const description = node.description?.trim() ? node.description : undefined;
  const tags = node.tags?.length ? node.tags : undefined;
  if (description === undefined && tags === undefined) {
    return undefined;
  }
  return { ...(description !== undefined && { description }), ...(tags !== undefined && { tags }) };
}

/** Visits every leaf bookmark in a tree, with its identity path. */
function eachKeyedBookmark(
  bookmarks: readonly Bookmark[],
  visit: (node: Bookmark, path: string[]) => void,
  parentPath: readonly string[] = [],
): void {
  for (const { key, node } of keyBookmarkSiblings(bookmarks)) {
    const path = [...parentPath, key];
    if (carriesMetadata(node)) {
      visit(node, path);
    } else if (node.children?.length) {
      eachKeyedBookmark(node.children, visit, path);
    }
  }
}

/** Extracts a sidecar map from a tree, keeping only the nodes that carry metadata. */
export function collectBookmarkMetadata(bookmarks: readonly Bookmark[]): BookmarkMetadataMap {
  const collected: BookmarkMetadataMap = {};
  eachKeyedBookmark(bookmarks, (node, path) => {
    const metadata = metadataOf(node);
    if (metadata) {
      collected[bookmarkMetadataKey(path)] = { url: node.url ?? '', ...metadata };
    }
  });
  return collected;
}

/** The top-level (container) match keys present in a tree. */
function containerKeysOf(bookmarks: readonly Bookmark[]): Set<string> {
  return new Set(keyBookmarkSiblings(bookmarks).map(({ key }) => key));
}

/**
 * Folds the metadata of a tree that is about to be written to the browser into the
 * existing sidecar.
 *
 * A write replaces a container's contents wholesale, so the entries under every container
 * it touches are replaced wholesale too — that is what makes a description deleted on
 * another device actually disappear here, instead of being laid back over the tree on the
 * next read and pushed out again.
 *
 * Containers the write does not touch keep their entries: the bookmarks toolbar is
 * excluded from the sync while that setting is off, and its metadata must still be there
 * when the setting is turned back on.
 */
export function captureBookmarkMetadata(
  existing: BookmarkMetadataMap,
  written: readonly Bookmark[],
): BookmarkMetadataMap {
  const replaced = containerKeysOf(written);
  const kept: BookmarkMetadataMap = {};
  for (const [key, value] of Object.entries(existing)) {
    const [container] = bookmarkMetadataPath(key);
    if (container === undefined || !replaced.has(container)) {
      kept[key] = value;
    }
  }
  return { ...kept, ...collectBookmarkMetadata(written) };
}

/**
 * Indexes entries by URL, keeping only URLs a single entry claims.
 *
 * This backs the fallback in {@link applyBookmarkMetadata}: renaming a folder or dragging
 * a bookmark into another one changes its identity path, and matching the leftover entry
 * by URL is what keeps the description attached to the bookmark the user moved. Ambiguous
 * URLs are left out — with two candidates there is no way to tell which one moved.
 */
function uniqueByUrl(map: BookmarkMetadataMap): Map<string, StoredBookmarkMetadata> {
  const byUrl = new Map<string, StoredBookmarkMetadata>();
  const ambiguous = new Set<string>();
  for (const entry of Object.values(map)) {
    if (byUrl.has(entry.url)) {
      ambiguous.add(entry.url);
      continue;
    }
    byUrl.set(entry.url, entry);
  }
  for (const url of ambiguous) {
    byUrl.delete(url);
  }
  return byUrl;
}

/** Counts how many leaf bookmarks in a tree carry each URL. */
function urlCounts(bookmarks: readonly Bookmark[]): Map<string, number> {
  const counts = new Map<string, number>();
  eachKeyedBookmark(bookmarks, (node) => {
    const url = node.url ?? '';
    counts.set(url, (counts.get(url) ?? 0) + 1);
  });
  return counts;
}

/**
 * Returns a copy of the tree with the sidecar's metadata laid over its leaf bookmarks.
 *
 * A node is matched on its identity path first. When that misses, it falls back to a
 * URL that is unambiguous on both sides — one entry in the sidecar, one bookmark in the
 * tree — so metadata follows a bookmark that was moved or whose folder was renamed. The
 * next write re-keys it under the path it now holds.
 *
 * Nodes with no entry are left exactly as they are; the sidecar adds metadata, it never
 * clears it. Removing metadata is a write of a tree without it (see
 * {@link captureBookmarkMetadata}).
 */
export function applyBookmarkMetadata(
  bookmarks: readonly Bookmark[],
  map: BookmarkMetadataMap,
): Bookmark[] {
  if (Object.keys(map).length === 0) {
    return bookmarks as Bookmark[];
  }
  const byUrl = uniqueByUrl(map);
  const counts = urlCounts(bookmarks);

  const walk = (nodes: readonly Bookmark[], parentPath: readonly string[]): Bookmark[] =>
    keyBookmarkSiblings(nodes).map(({ key, node }) => {
      const path = [...parentPath, key];
      const copy: Bookmark = { ...node };
      if (carriesMetadata(node)) {
        const entry =
          map[bookmarkMetadataKey(path)] ??
          (counts.get(node.url ?? '') === 1 ? byUrl.get(node.url ?? '') : undefined);
        if (entry?.description !== undefined) {
          copy.description = entry.description;
        }
        if (entry?.tags !== undefined) {
          copy.tags = entry.tags;
        }
      } else if (node.children) {
        copy.children = walk(node.children, path);
      }
      return copy;
    });

  return walk(bookmarks, []);
}

/** The sidecar keys of every leaf bookmark in a tree with the given URL. */
export function bookmarkMetadataKeysForUrl(bookmarks: readonly Bookmark[], url: string): string[] {
  const keys: string[] = [];
  eachKeyedBookmark(bookmarks, (node, path) => {
    if (node.url === url) {
      keys.push(bookmarkMetadataKey(path));
    }
  });
  return keys;
}

/**
 * Returns a copy of the sidecar with `metadata` set on every entry in `keys`, dropping
 * the entries that would be left empty so a cleared description does not linger as a
 * blank one.
 */
export function setBookmarkMetadata(
  map: BookmarkMetadataMap,
  keys: readonly string[],
  url: string,
  metadata: BookmarkMetadata,
): BookmarkMetadataMap {
  const updated = { ...map };
  const entry = metadataOf({ url, ...metadata });
  for (const key of keys) {
    if (entry) {
      updated[key] = { url, ...entry };
    } else {
      delete updated[key];
    }
  }
  return updated;
}

/**
 * Normalises tags entered by a user: trimmed, whitespace-collapsed, de-duplicated
 * case-insensitively and sorted, then bounded in length and count.
 *
 * Sorting is what makes the result canonical. Tags reach the sync as a JSON array, and
 * both dirty detection and the merge compare that array by value — without a stable
 * order, re-entering the same tags in a different order would read as an edit and push a
 * tree that differs from the remote one in nothing but ordering. The comparison is on the
 * lower-cased form and locale-independent on purpose, so every device sorts identically.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim().replace(/\s+/g, ' ').slice(0, TAG_MAX_LENGTH);
    const key = clean.toLowerCase();
    if (clean === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(clean);
  }
  normalized.sort((a, b) => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    if (x === y) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return x < y ? -1 : 1;
  });
  return normalized.slice(0, MAX_TAGS);
}

/** Splits a comma-separated tag entry field into normalised tags. */
export function parseTags(text: string): string[] {
  return normalizeTags(text.split(','));
}

/** Formats tags back into the comma-separated form the entry field shows. */
export function formatTags(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(', ');
}

/**
 * Normalises a description entered by a user, trimming it to the model's limit at a word
 * boundary — the same bound `newBookmark` applies, so a description set through the
 * editor and one set when the bookmark is created are bounded identically.
 */
export function normalizeDescription(text: string | undefined): string {
  return trimToNearestWord(text, DESCRIPTION_MAX_LENGTH);
}
