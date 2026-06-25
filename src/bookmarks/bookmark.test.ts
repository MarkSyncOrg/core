import { describe, expect, it } from 'vitest';
import {
  assignIds,
  type Bookmark,
  BookmarkContainer,
  BookmarkType,
  canonicalizeBookmarks,
  cleanBookmark,
  DESCRIPTION_MAX_LENGTH,
  deserializeBookmarks,
  eachBookmark,
  getBookmarkType,
  getContainer,
  nativeToBookmarks,
  newBookmark,
  SEPARATOR_URL,
  serializeBookmarks,
  stripIds,
  trimToNearestWord,
} from './bookmark';

describe('getBookmarkType', () => {
  it('classifies bookmarks, folders, containers and separators', () => {
    expect(getBookmarkType({ url: 'https://x.org' })).toBe(BookmarkType.Bookmark);
    expect(getBookmarkType({ title: 'Folder', children: [] })).toBe(BookmarkType.Folder);
    expect(getBookmarkType({ title: BookmarkContainer.Toolbar, children: [] })).toBe(
      BookmarkType.Container,
    );
    expect(getBookmarkType({ url: SEPARATOR_URL })).toBe(BookmarkType.Separator);
  });
});

describe('newBookmark', () => {
  it('creates a leaf bookmark with a URL and no children', () => {
    const bookmark = newBookmark('Title', 'https://x.org');
    expect(bookmark).toEqual({ title: 'Title', url: 'https://x.org' });
    expect(bookmark.children).toBeUndefined();
  });

  it('creates a folder (empty children) when there is no URL', () => {
    expect(newBookmark('My folder')).toEqual({ title: 'My folder', children: [] });
  });

  it('trims whitespace and keeps tags and description', () => {
    const bookmark = newBookmark('  Title  ', '  https://x.org  ', 'desc', ['a', 'b']);
    expect(bookmark).toEqual({
      title: 'Title',
      url: 'https://x.org',
      description: 'desc',
      tags: ['a', 'b'],
    });
  });

  it('reduces a separator to its sentinel URL', () => {
    expect(newBookmark('whatever', SEPARATOR_URL, 'desc', ['t'])).toEqual({ url: SEPARATOR_URL });
  });
});

describe('cleanBookmark', () => {
  it('drops unknown keys and empty description/tags', () => {
    const dirty = {
      title: 'T',
      url: 'https://x.org',
      description: '   ',
      tags: [],
      bogus: 'nope',
    } as unknown as Bookmark;
    expect(cleanBookmark(dirty)).toEqual({ title: 'T', url: 'https://x.org' });
  });
});

describe('trimToNearestWord', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(trimToNearestWord('short', DESCRIPTION_MAX_LENGTH)).toBe('short');
  });

  it('trims to a word boundary with an ellipsis', () => {
    expect(trimToNearestWord('one two three four', 9)).toBe('one two…');
  });
});

describe('nativeToBookmarks', () => {
  it('converts a native tree into folders and bookmarks recursively', () => {
    const native = [
      {
        title: 'Folder',
        children: [
          { title: 'Child', url: 'https://child.org' },
          { title: 'Sub', children: [{ title: 'Deep', url: 'https://deep.org' }] },
        ],
      },
      { title: 'Top', url: 'https://top.org' },
    ];

    expect(nativeToBookmarks(native)).toEqual([
      {
        title: 'Folder',
        children: [
          { title: 'Child', url: 'https://child.org' },
          { title: 'Sub', children: [{ title: 'Deep', url: 'https://deep.org' }] },
        ],
      },
      { title: 'Top', url: 'https://top.org' },
    ]);
  });
});

describe('nativeToBookmarks separators', () => {
  it('maps a native separator (by type) to the sentinel URL', () => {
    const native = [
      { title: 'A', url: 'https://a.org' },
      { type: 'separator' },
      { title: 'B', url: 'https://b.org' },
    ];
    expect(nativeToBookmarks(native)).toEqual([
      { title: 'A', url: 'https://a.org' },
      { url: SEPARATOR_URL },
      { title: 'B', url: 'https://b.org' },
    ]);
  });
});

describe('assignIds', () => {
  it('assigns unique, pre-order, sequential IDs', () => {
    const tree: Bookmark[] = [
      {
        title: 'A',
        children: [
          { title: 'A1', url: 'https://a1' },
          { title: 'A2', url: 'https://a2' },
        ],
      },
      { title: 'B', url: 'https://b' },
    ];
    const withIds = assignIds(tree);

    const ids: number[] = [];
    eachBookmark(withIds, (b) => ids.push(b.id!));
    expect(ids).toEqual([1, 2, 3, 4]);
    // Original tree is not mutated.
    expect(tree[0]!.id).toBeUndefined();
  });
});

describe('getContainer', () => {
  it('finds an existing container', () => {
    const bookmarks: Bookmark[] = [{ title: BookmarkContainer.Toolbar, children: [] }];
    expect(getContainer(BookmarkContainer.Toolbar, bookmarks)).toBe(bookmarks[0]);
  });

  it('creates and appends a container when missing and requested', () => {
    const bookmarks: Bookmark[] = [];
    const container = getContainer(BookmarkContainer.Other, bookmarks, true);
    expect(container).toEqual({ title: BookmarkContainer.Other, children: [] });
    expect(bookmarks).toHaveLength(1);
  });

  it('returns undefined when missing and not asked to create', () => {
    expect(getContainer(BookmarkContainer.Menu, [])).toBeUndefined();
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a cleaned bookmark tree', () => {
    const bookmarks: Bookmark[] = [
      {
        title: BookmarkContainer.Toolbar,
        children: [{ title: 'X', url: 'https://x.org', tags: [] }],
      },
    ];
    const json = serializeBookmarks(bookmarks);
    expect(deserializeBookmarks(json)).toEqual([
      { title: BookmarkContainer.Toolbar, children: [{ title: 'X', url: 'https://x.org' }] },
    ]);
  });

  it('rejects non-array payloads', () => {
    expect(() => deserializeBookmarks('{"not":"array"}')).toThrow(TypeError);
  });
});

describe('canonicalizeBookmarks / stripIds', () => {
  it('is identical for trees that differ only by IDs', () => {
    const a: Bookmark[] = [
      { title: 'A', id: 1, children: [{ title: 'X', url: 'https://x.org', id: 2 }] },
    ];
    const b: Bookmark[] = [
      { title: 'A', id: 99, children: [{ title: 'X', url: 'https://x.org', id: 50 }] },
    ];
    expect(canonicalizeBookmarks(a)).toBe(canonicalizeBookmarks(b));
  });

  it('differs when content differs', () => {
    const a: Bookmark[] = [{ title: 'A', url: 'https://a.org' }];
    const b: Bookmark[] = [{ title: 'B', url: 'https://b.org' }];
    expect(canonicalizeBookmarks(a)).not.toBe(canonicalizeBookmarks(b));
  });

  it('stripIds removes ids recursively', () => {
    const tree: Bookmark[] = [{ title: 'A', id: 1, children: [{ url: 'https://x.org', id: 2 }] }];
    expect(stripIds(tree)).toEqual([{ title: 'A', children: [{ url: 'https://x.org' }] }]);
  });
});
