// Three-way merge for bookmark trees. Lets concurrent edits made on two devices both
// survive a sync, instead of one side overwriting the other. It is a pure, structural
// merge (no per-operation change tracking): given the last-synced tree (`base`), this
// device's current tree (`local`) and the server's current tree (`remote`), it produces
// a single merged tree that incorporates both sides' changes.
//
// Identity is content-based, scoped to a sibling list: folders are matched by title,
// bookmarks by URL, separators by position. Duplicate keys within one folder are matched
// by occurrence order. This needs no stable IDs (the sync format reassigns them on every
// upload) and no native↔synced ID mapping.
//
// Conflict rules (deterministic, so every device converges on the same result):
//   - attribute edited on one side only  → take that side's value
//   - attribute edited on both sides      → remote wins
//   - node deleted on one side, untouched on the other → honour the deletion
//   - node deleted on one side, edited on the other     → keep the edited node
//   - node added on either side            → keep it

import {
  type Bookmark,
  BookmarkType,
  canonicalizeBookmarks,
  cleanAllBookmarks,
  getBookmarkType,
  SEPARATOR_URL,
  stripIds,
} from '../bookmarks/bookmark';

/**
 * Merges `local` and `remote` against their common ancestor `base`, returning a single
 * tree (without IDs) that incorporates both sides' changes. See the file header for the
 * matching and conflict rules.
 */
export function threeWayMerge(
  base: Bookmark[] | undefined,
  local: Bookmark[] | undefined,
  remote: Bookmark[] | undefined,
): Bookmark[] {
  const merged = mergeLevel(base ?? [], local ?? [], remote ?? []);
  // Strip IDs (the engine reassigns them on upload) and drop empty/invalid properties.
  return cleanAllBookmarks(stripIds(merged));
}

interface Keyed {
  key: string;
  node: Bookmark;
}

/** The match key for a node, ignoring per-occurrence disambiguation. */
function baseKey(node: Bookmark): string {
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
 * the same folder match by position across base/local/remote.
 */
function keyed(nodes: Bookmark[]): Keyed[] {
  const counts = new Map<string, number>();
  return nodes.map((node) => {
    const bk = baseKey(node);
    const n = counts.get(bk) ?? 0;
    counts.set(bk, n + 1);
    return { key: `${bk}#${n}`, node };
  });
}

function toMap(keys: Keyed[]): Map<string, Bookmark> {
  return new Map(keys.map(({ key, node }) => [key, node]));
}

/** Whether two subtrees are identical ignoring IDs (used for delete-vs-edit decisions). */
function sameSubtree(a: Bookmark, b: Bookmark): boolean {
  return canonicalizeBookmarks([a]) === canonicalizeBookmarks([b]);
}

/** Merges one sibling list. */
function mergeLevel(base: Bookmark[], local: Bookmark[], remote: Bookmark[]): Bookmark[] {
  const localKeyed = keyed(local);
  const remoteKeyed = keyed(remote);
  const baseMap = toMap(keyed(base));
  const localMap = toMap(localKeyed);
  const remoteMap = toMap(remoteKeyed);

  const result: Bookmark[] = [];
  for (const key of mergeOrder(localKeyed, remoteKeyed)) {
    const node = decide(baseMap.get(key), localMap.get(key), remoteMap.get(key));
    if (node) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Produces the merged child order: remote order as the spine, with local-only keys woven
 * in at their local position. Every key from either side appears exactly once.
 */
function mergeOrder(localKeyed: Keyed[], remoteKeyed: Keyed[]): string[] {
  const remoteKeys = remoteKeyed.map((k) => k.key);
  const remoteSet = new Set(remoteKeys);
  const emitted = new Set<string>();
  const result: string[] = [];
  let ri = 0;

  // Emit pending remote keys up to and including `key`, preserving remote order.
  const flushRemoteThrough = (key: string): void => {
    while (ri < remoteKeys.length) {
      const rkey = remoteKeys[ri]!;
      ri += 1;
      if (!emitted.has(rkey)) {
        emitted.add(rkey);
        result.push(rkey);
      }
      if (rkey === key) {
        break;
      }
    }
  };

  for (const { key } of localKeyed) {
    if (emitted.has(key)) {
      continue;
    }
    if (remoteSet.has(key)) {
      flushRemoteThrough(key);
    } else {
      emitted.add(key);
      result.push(key);
    }
  }
  while (ri < remoteKeys.length) {
    const rkey = remoteKeys[ri]!;
    ri += 1;
    if (!emitted.has(rkey)) {
      emitted.add(rkey);
      result.push(rkey);
    }
  }
  return result;
}

/** Decides the fate of a single matched node, given its base/local/remote versions. */
function decide(
  base: Bookmark | undefined,
  local: Bookmark | undefined,
  remote: Bookmark | undefined,
): Bookmark | undefined {
  if (local && remote) {
    return mergeNode(base, local, remote);
  }
  if (local) {
    // Absent from remote. If it existed in base, remote deleted it: honour the deletion
    // unless this device edited it (then keep the edit). Otherwise it is a local addition.
    if (base) {
      return sameSubtree(base, local) ? undefined : local;
    }
    return local;
  }
  if (remote) {
    // Absent locally — symmetric to the above.
    if (base) {
      return sameSubtree(base, remote) ? undefined : remote;
    }
    return remote;
  }
  // Deleted on both sides.
  return undefined;
}

/** Merges a node present on both sides: 3-way per attribute, recursive on children. */
function mergeNode(base: Bookmark | undefined, local: Bookmark, remote: Bookmark): Bookmark {
  const type = getBookmarkType(local);
  if (type === BookmarkType.Separator) {
    return { url: SEPARATOR_URL };
  }

  const node: Bookmark = {
    title: pick(base?.title, local.title, remote.title),
  };

  if (type === BookmarkType.Bookmark) {
    node.url = local.url; // identity for bookmarks; equal on both sides by construction
    node.description = pick(base?.description, local.description, remote.description);
    node.tags = pickTags(base?.tags, local.tags, remote.tags);
  } else {
    node.children = mergeLevel(base?.children ?? [], local.children ?? [], remote.children ?? []);
  }
  return node;
}

/** Three-way pick for a scalar attribute; on a two-sided conflict, remote wins. */
function pick<T>(base: T | undefined, local: T | undefined, remote: T | undefined): T | undefined {
  if (local === remote) {
    return local;
  }
  if (local === base) {
    return remote;
  }
  if (remote === base) {
    return local;
  }
  return remote;
}

/** Three-way pick for tag arrays (compared by value); on a conflict, remote wins. */
function pickTags(
  base: string[] | undefined,
  local: string[] | undefined,
  remote: string[] | undefined,
): string[] | undefined {
  const b = JSON.stringify(base ?? []);
  const l = JSON.stringify(local ?? []);
  const r = JSON.stringify(remote ?? []);
  if (l === r) {
    return local;
  }
  if (l === b) {
    return remote;
  }
  if (r === b) {
    return local;
  }
  return remote;
}
