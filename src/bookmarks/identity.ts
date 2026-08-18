// Content-based node identity, shared by the three-way merge and the metadata sidecar.
//
// The sync format reassigns IDs on every upload, so nothing in a bookmark tree is a
// stable handle: a node has to be recognised by what it is. Identity is therefore
// content-based and scoped to a sibling list — folders are matched by title, bookmarks
// by URL, separators by position — with repeats inside one folder disambiguated by
// occurrence order.
//
// Merging and metadata lookup must agree on this, or the two disagree about which node
// is which: a merge would carry a description onto the node the sidecar thinks is a
// different bookmark. Hence one implementation, used by both.

import { type Bookmark, BookmarkType, getBookmarkType } from './bookmark.js';

/** A node paired with its occurrence-disambiguated key within its sibling list. */
export interface KeyedBookmark {
  key: string;
  node: Bookmark;
}

/**
 * The match key for a node, ignoring per-occurrence disambiguation.
 *
 * Containers key like folders: they *are* folders as far as matching is concerned, and
 * their titles ('[xbs] Toolbar' and friends) are reserved, so they cannot collide with a
 * user's own folder at the same level.
 */
export function bookmarkMatchKey(node: Bookmark): string {
  switch (getBookmarkType(node)) {
    case BookmarkType.Separator:
      return 'sep';
    case BookmarkType.Folder:
    case BookmarkType.Container:
      return `f:${node.title ?? ''}`;
    default:
      return `b:${node.url ?? ''}`;
  }
}

/**
 * Keys a sibling list, disambiguating repeats by occurrence so duplicate titles/URLs in
 * the same folder match by position across the trees being compared.
 *
 * Counting is per match key rather than per absolute position, which is what keeps the
 * keys stable when a sibling is missing on one side — a Chromium build drops the
 * separators it cannot represent, and the bookmarks around them keep their numbering.
 */
export function keyBookmarkSiblings(nodes: readonly Bookmark[]): KeyedBookmark[] {
  const counts = new Map<string, number>();
  return nodes.map((node) => {
    const matchKey = bookmarkMatchKey(node);
    const seen = counts.get(matchKey) ?? 0;
    counts.set(matchKey, seen + 1);
    return { key: `${matchKey}#${seen}`, node };
  });
}
