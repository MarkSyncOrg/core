// Putting back what a browser cannot hold.
//
// No browser can store the whole xBrowserSync model. Chromium has no bookmarks menu and
// no separators; a device with the toolbar setting off has nowhere to put `[xbs] Toolbar`
// either. Whatever a browser cannot hold is missing from the tree it hands back, and the
// sync engine reads that tree twice: once to decide whether there are local edits to
// push, and once to build the payload it uploads.
//
// Left alone, both readings are wrong in the same way. The device looks edited when
// nobody edited anything, and its next upload deletes from the sync — for every other
// device — something it merely could not represent. Two browsers of different families
// then never stop overwriting each other: one drops the node, the other reads it back
// from its own storage and puts it straight back (app-next#22).
//
// So a node that only the reference tree has — the tree the sync last held — is carried
// through the round trip untouched. This is the same bargain `reinstateRemovedBookmarks`
// makes for the bookmarklets sanitisation drops: excluding something from what this
// device can speak about is not the same as deleting it.
//
// Only nodes whose absence is unambiguous qualify. A missing container always means the
// browser has no root for it, never that the user deleted it — container titles are
// reserved and the user cannot remove one. A missing separator is ambiguous, so the
// provider says whether this browser can hold separators at all, and the restore happens
// only where it cannot.

import { type Bookmark, BookmarkType, getBookmarkType } from './bookmark.js';
import { keyBookmarkSiblings } from './identity.js';

/**
 * Puts back the top-level containers the local tree has no root for, at the position
 * they hold in `reference`.
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

/**
 * Puts back the separators of `reference` throughout a tree that came from a browser with
 * nowhere to keep them.
 *
 * Call this only for such a browser — see `BookmarkProvider.holdsSeparators`. On one
 * that does hold separators, the tree it returns is the truth, and restoring into it would
 * make deleting a separator impossible: it would simply reappear from the reference on the
 * next read.
 *
 * Folders are paired with their counterpart by the content-based identity the merge and
 * the metadata sidecar share, and each separator goes back at the index it held among its
 * siblings. Placement is best-effort, exactly as it is in `reinstateRemovedBookmarks`: the
 * tree being written into is not the tree the separators came out of, so a bookmark added
 * or removed around one shifts it. It lands next to different neighbours in that case,
 * which is the price of not dropping it.
 */
export function restoreMissingSeparators(
  bookmarks: Bookmark[],
  reference: readonly Bookmark[],
): Bookmark[] {
  const isSeparator = (node: Bookmark) => getBookmarkType(node) === BookmarkType.Separator;

  const walk = (local: readonly Bookmark[], from: readonly Bookmark[]): Bookmark[] => {
    const fromByKey = new Map(keyBookmarkSiblings(from).map(({ key, node }) => [key, node]));
    const present = new Set<string>();
    // Recurse first: the keys of this level are computed from the tree as the browser
    // returned it, and inserting into it below would renumber the separators.
    const result = keyBookmarkSiblings(local).map(({ key, node }) => {
      present.add(key);
      const counterpart = fromByKey.get(key);
      if (!node.children || !counterpart?.children) {
        return node;
      }
      return { ...node, children: walk(node.children, counterpart.children) };
    });

    keyBookmarkSiblings(from).forEach(({ key, node }, index) => {
      if (isSeparator(node) && !present.has(key)) {
        result.splice(Math.min(index, result.length), 0, node);
      }
    });
    return result;
  };

  return walk(bookmarks, reference);
}
