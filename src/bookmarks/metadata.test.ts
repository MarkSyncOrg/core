import { describe, expect, it } from 'vitest';
import { type Bookmark, BookmarkContainer, SEPARATOR_URL } from './bookmark';
import {
  applyBookmarkMetadata,
  type BookmarkMetadataMap,
  bookmarkMetadataKey,
  bookmarkMetadataKeysForUrl,
  bookmarkMetadataPath,
  captureBookmarkMetadata,
  collectBookmarkMetadata,
  formatTags,
  MAX_TAGS,
  normalizeDescription,
  normalizeTags,
  parseTags,
  setBookmarkMetadata,
  TAG_MAX_LENGTH,
} from './metadata';

/** A tree with one bookmark inside a folder inside the Other container. */
function tree(bookmark: Bookmark): Bookmark[] {
  return [
    {
      title: BookmarkContainer.Other,
      children: [{ title: 'News', children: [bookmark] }],
    },
  ];
}

const NEWS_KEY = bookmarkMetadataKey([
  `f:${BookmarkContainer.Other}#0`,
  'f:News#0',
  'b:https://x.org/#0',
]);

describe('bookmarkMetadataKey', () => {
  it('round-trips a path', () => {
    const path = ['f:[xbs] Other#0', 'b:https://x.org/#0'];
    expect(bookmarkMetadataPath(bookmarkMetadataKey(path))).toEqual(path);
  });

  it('does not confuse paths that differ only in where a separator falls', () => {
    // A joined-string key would collapse these two onto the same entry.
    expect(bookmarkMetadataKey(['a/b', 'c'])).not.toBe(bookmarkMetadataKey(['a', 'b/c']));
  });
});

describe('collectBookmarkMetadata', () => {
  it('keys leaf bookmarks by their path through the tree', () => {
    const collected = collectBookmarkMetadata(
      tree({ title: 'X', url: 'https://x.org/', description: 'A site', tags: ['news'] }),
    );
    expect(collected).toEqual({
      [NEWS_KEY]: { url: 'https://x.org/', description: 'A site', tags: ['news'] },
    });
  });

  it('skips nodes with nothing to store', () => {
    expect(collectBookmarkMetadata(tree({ title: 'X', url: 'https://x.org/' }))).toEqual({});
    expect(
      collectBookmarkMetadata(tree({ url: 'https://x.org/', description: '  ', tags: [] })),
    ).toEqual({});
  });

  it('ignores folders, containers and separators', () => {
    const collected = collectBookmarkMetadata([
      {
        title: BookmarkContainer.Other,
        description: 'container',
        children: [
          { title: 'Folder', description: 'folder', children: [] },
          { url: SEPARATOR_URL, description: 'separator' },
        ],
      },
    ]);
    expect(collected).toEqual({});
  });

  it('distinguishes duplicate URLs in one folder by occurrence', () => {
    const collected = collectBookmarkMetadata([
      {
        title: BookmarkContainer.Other,
        children: [
          { url: 'https://x.org/', description: 'first' },
          { url: 'https://x.org/', description: 'second' },
        ],
      },
    ]);
    expect(Object.keys(collected)).toHaveLength(2);
    expect(Object.values(collected).map((entry) => entry.description)).toEqual(['first', 'second']);
  });
});

describe('applyBookmarkMetadata', () => {
  it('lays stored metadata back over a native tree that lost it', () => {
    const stored = collectBookmarkMetadata(
      tree({ title: 'X', url: 'https://x.org/', description: 'A site', tags: ['news'] }),
    );
    // What the browser hands back: title and URL, nothing else.
    const applied = applyBookmarkMetadata(tree({ title: 'X', url: 'https://x.org/' }), stored);
    expect(applied).toEqual(
      tree({ title: 'X', url: 'https://x.org/', description: 'A site', tags: ['news'] }),
    );
  });

  it('leaves the input untouched', () => {
    const stored = collectBookmarkMetadata(tree({ url: 'https://x.org/', description: 'A site' }));
    const input = tree({ url: 'https://x.org/' });
    applyBookmarkMetadata(input, stored);
    expect(input[0]!.children![0]!.children![0]!.description).toBeUndefined();
  });

  it('follows a bookmark whose folder was renamed', () => {
    const stored = collectBookmarkMetadata(tree({ url: 'https://x.org/', description: 'A site' }));
    const renamed: Bookmark[] = [
      {
        title: BookmarkContainer.Other,
        children: [{ title: 'Headlines', children: [{ url: 'https://x.org/' }] }],
      },
    ];
    const applied = applyBookmarkMetadata(renamed, stored);
    expect(applied[0]!.children![0]!.children![0]!.description).toBe('A site');
  });

  it('does not guess when the same URL is bookmarked twice', () => {
    const stored = collectBookmarkMetadata(tree({ url: 'https://x.org/', description: 'A site' }));
    const duplicated: Bookmark[] = [
      {
        title: BookmarkContainer.Other,
        children: [
          { title: 'News', children: [{ url: 'https://x.org/' }] },
          { url: 'https://x.org/' },
        ],
      },
    ];
    const applied = applyBookmarkMetadata(duplicated, stored);
    // The exact path still matches; the copy elsewhere is left alone rather than
    // inheriting a description the user never gave it.
    expect(applied[0]!.children![0]!.children![0]!.description).toBe('A site');
    expect(applied[0]!.children![1]!.description).toBeUndefined();
  });

  it('adds metadata but never clears what a node already carries', () => {
    const applied = applyBookmarkMetadata(tree({ url: 'https://x.org/', description: 'kept' }), {
      [bookmarkMetadataKey(['nope'])]: { url: 'https://other.org/', tags: ['t'] },
    });
    expect(applied[0]!.children![0]!.children![0]!.description).toBe('kept');
  });
});

describe('captureBookmarkMetadata', () => {
  it('replaces the entries of every container it writes', () => {
    const before = collectBookmarkMetadata(tree({ url: 'https://x.org/', description: 'A site' }));
    // The same tree, with the description removed on another device.
    const after = captureBookmarkMetadata(before, tree({ url: 'https://x.org/' }));
    expect(after).toEqual({});
  });

  it('keeps entries for containers the write does not touch', () => {
    const existing = collectBookmarkMetadata([
      { title: BookmarkContainer.Toolbar, children: [{ url: 'https://t.org/', tags: ['bar'] }] },
      { title: BookmarkContainer.Other, children: [{ url: 'https://o.org/', tags: ['other'] }] },
    ]);
    // A sync with the toolbar excluded writes the Other container only.
    const after = captureBookmarkMetadata(existing, [
      { title: BookmarkContainer.Other, children: [{ url: 'https://o.org/' }] },
    ]);
    expect(Object.values(after)).toEqual([{ url: 'https://t.org/', tags: ['bar'] }]);
  });
});

describe('a pull followed by a dirty check', () => {
  it('does not read a pulled description as a local edit', () => {
    // The regression this sidecar exists to prevent: without it the browser drops the
    // metadata, the rebuilt tree no longer matches the cached one, and the next push
    // erases every description in the sync.
    const remote = tree({ title: 'X', url: 'https://x.org/', description: 'A site' });
    const sidecar = captureBookmarkMetadata({}, remote);
    // The browser stores what it can, and hands that back on the next read.
    const native = tree({ title: 'X', url: 'https://x.org/' });
    expect(applyBookmarkMetadata(native, sidecar)).toEqual(remote);
  });
});

describe('bookmarkMetadataKeysForUrl / setBookmarkMetadata', () => {
  it('sets and clears metadata for a URL', () => {
    const bookmarks = tree({ title: 'X', url: 'https://x.org/' });
    const keys = bookmarkMetadataKeysForUrl(bookmarks, 'https://x.org/');
    expect(keys).toEqual([NEWS_KEY]);

    const set = setBookmarkMetadata({}, keys, 'https://x.org/', {
      description: 'A site',
      tags: ['news'],
    });
    expect(set[NEWS_KEY]).toEqual({ url: 'https://x.org/', description: 'A site', tags: ['news'] });

    const cleared = setBookmarkMetadata(set, keys, 'https://x.org/', {
      description: '',
      tags: [],
    });
    expect(cleared).toEqual({});
  });

  it('finds no keys for a URL that is not bookmarked', () => {
    expect(bookmarkMetadataKeysForUrl(tree({ url: 'https://x.org/' }), 'https://y.org/')).toEqual(
      [],
    );
  });

  it('leaves other entries alone', () => {
    const existing: BookmarkMetadataMap = {
      other: { url: 'https://y.org/', description: 'kept' },
    };
    const updated = setBookmarkMetadata(existing, [NEWS_KEY], 'https://x.org/', { tags: ['t'] });
    expect(updated['other']).toEqual({ url: 'https://y.org/', description: 'kept' });
  });
});

describe('normalizeTags', () => {
  it('trims, drops blanks, de-duplicates case-insensitively and sorts', () => {
    expect(normalizeTags(['  News ', 'news', '', 'Alpha', 'beta'])).toEqual([
      'Alpha',
      'beta',
      'News',
    ]);
  });

  it('collapses internal whitespace', () => {
    expect(normalizeTags(['web   dev'])).toEqual(['web dev']);
  });

  it('sorts identically whatever order the tags arrive in', () => {
    const forwards = normalizeTags(['zeta', 'Alpha', 'mu']);
    expect(normalizeTags(['mu', 'zeta', 'Alpha'])).toEqual(forwards);
  });

  it('bounds tag length and count', () => {
    expect(normalizeTags(['x'.repeat(TAG_MAX_LENGTH + 20)])[0]).toHaveLength(TAG_MAX_LENGTH);
    const many = Array.from(
      { length: MAX_TAGS + 10 },
      (_, i) => `tag${String(i).padStart(3, '0')}`,
    );
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS);
  });
});

describe('parseTags / formatTags', () => {
  it('round-trips a comma-separated entry field', () => {
    expect(parseTags('news, tech,,  Reading ')).toEqual(['news', 'Reading', 'tech']);
    expect(formatTags(parseTags('news, tech'))).toBe('news, tech');
    expect(formatTags(undefined)).toBe('');
  });
});

describe('normalizeDescription', () => {
  it('trims a long description at a word boundary', () => {
    const long = `${'word '.repeat(100)}end`;
    const normalized = normalizeDescription(long);
    expect(normalized.length).toBeLessThanOrEqual(301);
    expect(normalized.endsWith('…')).toBe(true);
  });

  it('leaves a short description alone', () => {
    expect(normalizeDescription('  A site  ')).toBe('A site');
    expect(normalizeDescription(undefined)).toBe('');
  });
});
