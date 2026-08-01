// Validation and sanitisation for bookmark trees crossing a trust boundary.
//
// Three sources feed `Bookmark[]` into this package, none of them trustworthy:
//   - a backup file (unauthenticated, unencrypted, chosen from disk by the user)
//   - a sync payload (authenticated, but writable by anyone sharing the sync)
//   - the browser's own native tree (shaped by whatever the platform hands us)
//
// Everything entering from those sources goes through here first, so the guarantees
// hold in one place instead of being re-implemented by each consumer.
//
// This constrains only what the client *accepts*. The wire format is unchanged, so the
// xBrowserSync compatibility contract documented in bookmark.ts and crypto.ts is intact.

import { InvalidBookmarkDataError } from '../errors.js';
import { type Bookmark, SEPARATOR_URL } from './bookmark.js';

/**
 * Maximum nesting depth accepted in a bookmark tree.
 *
 * The tree transforms (`cleanAllBookmarks`, `stripIds`, `assignIds`, `mergeLevel`) all
 * recurse on `children`, and V8's stack overflows a little under 4,000 frames. Real
 * bookmark hierarchies are nowhere near this, so capping the input is both sufficient
 * and cheaper than making five separate walkers iterative.
 */
export const MAX_BOOKMARK_DEPTH = 200;

/**
 * URL schemes a synced bookmark may carry. Deliberately excludes `javascript:` and
 * `data:`, which execute in the opening context: a consumer rendering an untrusted
 * bookmark as `<a href>` would otherwise hand script execution to whoever wrote it.
 */
export const SAFE_URL_SCHEMES: readonly string[] = [
  'http:',
  'https:',
  'ftp:',
  'ftps:',
  'mailto:',
];

/**
 * Whether a bookmark URL is safe to store, sync and render.
 *
 * Folders (no URL) and the separator sentinel are safe by definition. Everything else
 * must parse as an absolute URL with an allowed scheme. Parsing via `URL` rather than a
 * regex is what makes obfuscation (`JAVASCRIPT:`, leading whitespace, embedded newlines)
 * a non-issue — the parser normalises before the scheme is compared.
 */
export function isSafeBookmarkUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return true;
  }
  if (url === SEPARATOR_URL) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return SAFE_URL_SCHEMES.includes(parsed.protocol.toLowerCase());
}

function assertNodeShape(node: unknown): asserts node is Bookmark {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new InvalidBookmarkDataError('Bookmark node is not an object');
  }
  const { id, title, url, description, tags, children } = node as Record<string, unknown>;

  if (id !== undefined && (typeof id !== 'number' || !Number.isFinite(id))) {
    throw new InvalidBookmarkDataError('Bookmark id is not a number');
  }
  for (const [name, value] of [
    ['title', title],
    ['url', url],
    ['description', description],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') {
      throw new InvalidBookmarkDataError(`Bookmark ${name} is not a string`);
    }
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
      throw new InvalidBookmarkDataError('Bookmark tags is not an array of strings');
    }
  }
  if (children !== undefined && !Array.isArray(children)) {
    throw new InvalidBookmarkDataError('Bookmark children is not an array');
  }
}

/**
 * Validates an untrusted value as a bookmark tree, returning it typed.
 *
 * Checks that the value is an array, that every node has the expected shape, and that
 * nesting stays within {@link MAX_BOOKMARK_DEPTH}. Unknown properties are tolerated —
 * `cleanBookmark` drops them on serialisation — so a newer client's extra fields do not
 * make a tree unreadable.
 *
 * The walk is iterative on purpose: a recursive validator would overflow the stack on
 * exactly the deeply-nested input it exists to reject.
 *
 * @throws {InvalidBookmarkDataError} if the value is not a well-formed bookmark tree.
 */
export function validateBookmarkTree(value: unknown): Bookmark[] {
  if (!Array.isArray(value)) {
    throw new InvalidBookmarkDataError('Bookmark data is not an array');
  }

  const stack: { nodes: unknown[]; depth: number }[] = [{ nodes: value, depth: 1 }];
  while (stack.length > 0) {
    const { nodes, depth } = stack.pop()!;
    if (depth > MAX_BOOKMARK_DEPTH) {
      throw new InvalidBookmarkDataError(
        `Bookmark tree is nested deeper than ${MAX_BOOKMARK_DEPTH} levels`,
      );
    }
    for (const node of nodes) {
      assertNodeShape(node);
      // An empty `children: []` is how a folder with no contents is represented; it adds
      // no nesting, so it must not consume a level of the budget.
      if (node.children !== undefined && node.children.length > 0) {
        stack.push({ nodes: node.children, depth: depth + 1 });
      }
    }
  }
  return value as Bookmark[];
}

/** A node sanitisation took out of a tree, with enough context to report or replace it. */
export interface RemovedBookmark {
  /** The removed node, subtree intact. Not a copy — it is the node from the source tree. */
  bookmark: Bookmark;
  /** Titles of the folders that contained it, outermost first; empty at the top level. */
  path: readonly string[];
  /** The index it occupied among its parent's children in the source tree. */
  index: number;
}

/** A sanitised tree together with everything sanitisation dropped from it. */
export interface SanitizeResult {
  bookmarks: Bookmark[];
  removed: RemovedBookmark[];
}

/**
 * Returns a copy of the tree with unsafe-URL nodes removed (with their subtrees).
 *
 * Applied symmetrically to both local and remote trees by the sync engine. Filtering
 * only one side would leave the two permanently unequal, and dirty-detection compares
 * them — the tree would look edited on every check and sync in a loop.
 *
 * Expects a tree that already passed {@link validateBookmarkTree}; it recurses, relying
 * on that depth cap.
 */
export function sanitizeBookmarkTree(bookmarks: Bookmark[]): Bookmark[] {
  return sanitizeBookmarkTreeWithReport(bookmarks).bookmarks;
}

/**
 * {@link sanitizeBookmarkTree}, but also returning what was dropped.
 *
 * The removals are not recoverable from the sanitised tree, so anything that needs to
 * tell the user ("12 entries were skipped") or to keep the nodes — see
 * {@link reinstateRemovedBookmarks} — has to read them here.
 *
 * Removals are reported in document order, and within one parent in ascending index
 * order, which is what makes the indices usable for re-insertion.
 */
export function sanitizeBookmarkTreeWithReport(bookmarks: Bookmark[]): SanitizeResult {
  const removed: RemovedBookmark[] = [];

  const walk = (nodes: Bookmark[], path: readonly string[]): Bookmark[] => {
    const result: Bookmark[] = [];
    nodes.forEach((node, index) => {
      if (!isSafeBookmarkUrl(node.url)) {
        removed.push({ bookmark: node, path, index });
        return;
      }
      const copy: Bookmark = { ...node };
      if (node.children) {
        copy.children = walk(node.children, [...path, node.title ?? '']);
      }
      result.push(copy);
    });
    return result;
  };

  return { bookmarks: walk(bookmarks, []), removed };
}

/** Copies a tree deeply enough that its arrays can be spliced without touching the input. */
function copyTree(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks.map((node) => {
    const copy: Bookmark = { ...node };
    if (node.children) {
      copy.children = copyTree(node.children);
    }
    return copy;
  });
}

/**
 * Puts nodes reported by {@link sanitizeBookmarkTreeWithReport} back into a tree.
 *
 * This exists because writing a sanitised tree over the browser's bookmarks is
 * destructive: the write would delete the user's own `javascript:` bookmarklets, which
 * are excluded from the sync but are not the sync's to remove. Sanitising a tree, sending
 * it somewhere, and reinstating the removals on the way back keeps the exclusion without
 * turning it into a deletion.
 *
 * Placement is best-effort, because the tree being written to is not the tree the nodes
 * came out of: each node goes back into the folder whose title path it was under, at the
 * index it held. If a folder along that path no longer exists, the node lands at the end
 * of the deepest folder that does — data is kept even when its surroundings have changed.
 *
 * Returns a new tree; the input is not modified.
 */
export function reinstateRemovedBookmarks(
  bookmarks: Bookmark[],
  removed: readonly RemovedBookmark[],
): Bookmark[] {
  if (removed.length === 0) {
    return bookmarks;
  }
  const result = copyTree(bookmarks);

  for (const { bookmark, path, index } of removed) {
    let siblings = result;
    let exact = true;
    for (const title of path) {
      // Only a folder can hold children; a leaf that happens to share the title is not
      // the folder we are looking for.
      const folder = siblings.find((node) => node.title === title && node.url === undefined);
      if (!folder) {
        exact = false;
        break;
      }
      folder.children ??= [];
      siblings = folder.children;
    }
    siblings.splice(exact ? Math.min(index, siblings.length) : siblings.length, 0, bookmark);
  }

  return result;
}

/** Validates then sanitises an untrusted tree — the standard trust-boundary entry point. */
export function acceptBookmarkTree(value: unknown): Bookmark[] {
  return sanitizeBookmarkTree(validateBookmarkTree(value));
}

/** {@link acceptBookmarkTree}, but also returning what sanitisation dropped. */
export function acceptBookmarkTreeWithReport(value: unknown): SanitizeResult {
  return sanitizeBookmarkTreeWithReport(validateBookmarkTree(value));
}
