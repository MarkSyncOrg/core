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
//
// Two questions are asked of a URL here, and they have different answers:
//   - may it be stored, synced and written back to the browser? `isSyncableBookmarkUrl`
//   - may it become an <a href> or a navigation?              `isSafeBookmarkUrl`
// Conflating them is what made `chrome://`, `file://` and friends disappear from the
// sync (MarkSyncOrg/app-next#37): they are unrenderable, not unsafe.

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
 * URL schemes safe to hand to a renderer or a navigation.
 *
 * Deliberately excludes `javascript:` and `data:`, which execute in the opening context:
 * a consumer rendering an untrusted bookmark as `<a href>` would otherwise hand script
 * execution to whoever wrote it. It also excludes the local and browser-internal schemes
 * in {@link LOCAL_URL_SCHEMES}: those carry no execution risk, but a page cannot usefully
 * link to them, so a consumer asking "can I turn this into a link?" wants them out too.
 *
 * This is the *render* policy. What a bookmark may be stored and synced as is a wider
 * question with a different answer: see {@link SYNCABLE_URL_SCHEMES}.
 */
export const SAFE_URL_SCHEMES: readonly string[] = [
  'http:',
  'https:',
  'ftp:',
  'ftps:',
  'mailto:',
];

/**
 * Local and browser-internal schemes: syncable, but not renderable as a link.
 *
 * `chrome://`, `edge://`, `about:` and friends address pages inside the browser, and
 * `file://` addresses the user's disk. None of them executes script in the origin that
 * renders them, and browsers already refuse to navigate to them from an ordinary page,
 * so excluding them from the sync protected nobody: it just silently dropped bookmarks
 * the user had, which xBrowserSync carried (MarkSyncOrg/app-next#37).
 *
 * `chrome-extension:` / `moz-extension:` URLs address a specific extension in a specific
 * profile, so they rarely resolve on the device that receives them. They are carried
 * anyway: a bookmark that does not resolve is the user's business, losing it is ours.
 */
export const LOCAL_URL_SCHEMES: readonly string[] = [
  'about:',
  'file:',
  'chrome:',
  'chrome-extension:',
  'edge:',
  'brave:',
  'vivaldi:',
  'opera:',
  'moz-extension:',
  'safari-web-extension:',
];

/**
 * Schemes that execute whatever the URL carries, in the context that opens it.
 *
 * `javascript:` is how every browser stores a bookmarklet, and `data:text/html` is the
 * same class of problem in a different costume. They are excluded from the sync unless
 * the user opts in (`allowBookmarklets`), because a tree arriving from a backup file or
 * from anyone sharing the sync would otherwise be able to plant one in the bookmark bar.
 * They are never safe to render: {@link isSafeBookmarkUrl} keeps rejecting them whatever
 * the policy says.
 */
export const EXECUTABLE_URL_SCHEMES: readonly string[] = ['javascript:', 'data:'];

/** Schemes a bookmark may be stored and synced as, before any opt-in is applied. */
export const SYNCABLE_URL_SCHEMES: readonly string[] = [
  ...SAFE_URL_SCHEMES,
  ...LOCAL_URL_SCHEMES,
];

/** What the user has allowed into the sync beyond the default set. */
export interface BookmarkUrlPolicy {
  /**
   * Carry bookmarklets (`javascript:`) and `data:` entries as well. Off by default: it
   * lets anyone who can write the sync, or hand over a backup file, put an executable
   * URL into the browser's bookmark bar. Consumers that turn it on must keep using
   * {@link isSafeBookmarkUrl} before rendering or opening a bookmark.
   */
  allowBookmarklets?: boolean;
}

/** Parses `url` and returns its lowercased scheme, or undefined if it is not absolute. */
function schemeOf(url: string): string | undefined {
  try {
    // Parsing via `URL` rather than a regex is what makes obfuscation (`JAVASCRIPT:`,
    // leading whitespace, embedded newlines) a non-issue: the parser normalises first.
    return new URL(url).protocol.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether a bookmark URL is safe to render as an `<a href>` or to navigate to.
 *
 * Folders (no URL) and the separator sentinel are safe by definition; everything else
 * must parse as an absolute URL whose scheme is in {@link SAFE_URL_SCHEMES}. This is the
 * render-time guard `SECURITY.md` asks consumers for, and it is deliberately narrower
 * than what the sync carries: a synced `chrome://` bookmark is real data, but a page
 * still cannot link to it.
 */
export function isSafeBookmarkUrl(url: string | undefined): boolean {
  if (url === undefined || url === SEPARATOR_URL) {
    return true;
  }
  const scheme = schemeOf(url);
  return scheme !== undefined && SAFE_URL_SCHEMES.includes(scheme);
}

/**
 * Whether a bookmark URL may be stored, synced and written back to the browser.
 *
 * Wider than {@link isSafeBookmarkUrl}: the sync's job is to carry what the user has,
 * and the local and browser-internal schemes are not an execution risk. Only the schemes
 * that execute ({@link EXECUTABLE_URL_SCHEMES}) are held back, and only until the user
 * opts in via `policy.allowBookmarklets`.
 *
 * Anything that is not an absolute URL is still refused: a relative or malformed URL has
 * no scheme to reason about, and no browser produces one.
 */
export function isSyncableBookmarkUrl(
  url: string | undefined,
  policy: BookmarkUrlPolicy = {},
): boolean {
  if (url === undefined || url === SEPARATOR_URL) {
    return true;
  }
  const scheme = schemeOf(url);
  if (scheme === undefined) {
    return false;
  }
  return (
    SYNCABLE_URL_SCHEMES.includes(scheme) ||
    (policy.allowBookmarklets === true && EXECUTABLE_URL_SCHEMES.includes(scheme))
  );
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
 * Returns a copy of the tree with non-syncable nodes removed (with their subtrees).
 *
 * What counts as syncable is {@link isSyncableBookmarkUrl}, so the same `policy` must be
 * passed everywhere a tree is sanitised. Applied symmetrically to both local and remote
 * trees by the sync engine: filtering only one side would leave the two permanently
 * unequal, and dirty-detection compares them — the tree would look edited on every check
 * and sync in a loop.
 *
 * Expects a tree that already passed {@link validateBookmarkTree}; it recurses, relying
 * on that depth cap.
 */
export function sanitizeBookmarkTree(
  bookmarks: Bookmark[],
  policy: BookmarkUrlPolicy = {},
): Bookmark[] {
  return sanitizeBookmarkTreeWithReport(bookmarks, policy).bookmarks;
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
export function sanitizeBookmarkTreeWithReport(
  bookmarks: Bookmark[],
  policy: BookmarkUrlPolicy = {},
): SanitizeResult {
  const removed: RemovedBookmark[] = [];

  const walk = (nodes: Bookmark[], path: readonly string[]): Bookmark[] => {
    const result: Bookmark[] = [];
    nodes.forEach((node, index) => {
      if (!isSyncableBookmarkUrl(node.url, policy)) {
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
export function acceptBookmarkTree(value: unknown, policy: BookmarkUrlPolicy = {}): Bookmark[] {
  return sanitizeBookmarkTree(validateBookmarkTree(value), policy);
}

/** {@link acceptBookmarkTree}, but also returning what sanitisation dropped. */
export function acceptBookmarkTreeWithReport(
  value: unknown,
  policy: BookmarkUrlPolicy = {},
): SanitizeResult {
  return sanitizeBookmarkTreeWithReport(validateBookmarkTree(value), policy);
}
