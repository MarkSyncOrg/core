import { describe, expect, it } from 'vitest';
import { BookmarkContainer, SEPARATOR_URL } from './bookmark';
import { bookmarkMatchKey, keyBookmarkSiblings } from './identity';

describe('bookmarkMatchKey', () => {
  it('keys each kind of node by what identifies it', () => {
    expect(bookmarkMatchKey({ url: 'https://x.org/' })).toBe('b:https://x.org/');
    expect(bookmarkMatchKey({ title: 'News', children: [] })).toBe('f:News');
    expect(bookmarkMatchKey({ title: BookmarkContainer.Other, children: [] })).toBe(
      `f:${BookmarkContainer.Other}`,
    );
    expect(bookmarkMatchKey({ url: SEPARATOR_URL })).toBe('sep');
  });

  it('ignores attributes that are not identity', () => {
    expect(
      bookmarkMatchKey({ title: 'X', url: 'https://x.org/', description: 'a', tags: ['t'] }),
    ).toBe(bookmarkMatchKey({ title: 'Y', url: 'https://x.org/' }));
  });
});

describe('keyBookmarkSiblings', () => {
  it('numbers repeats within a sibling list', () => {
    const keys = keyBookmarkSiblings([
      { url: 'https://x.org/' },
      { url: 'https://y.org/' },
      { url: 'https://x.org/' },
    ]).map(({ key }) => key);
    expect(keys).toEqual(['b:https://x.org/#0', 'b:https://y.org/#0', 'b:https://x.org/#1']);
  });

  it('keeps numbering stable when a sibling it cannot represent is dropped', () => {
    // Chromium has no separators, so the tree it hands back is missing them. The
    // bookmarks around them must still key the same, or the sidecar loses track of them.
    const withSeparator = keyBookmarkSiblings([
      { url: 'https://x.org/' },
      { url: SEPARATOR_URL },
      { url: 'https://y.org/' },
    ]).map(({ key }) => key);
    const without = keyBookmarkSiblings([{ url: 'https://x.org/' }, { url: 'https://y.org/' }]).map(
      ({ key }) => key,
    );
    expect(without).toEqual(withSeparator.filter((key) => !key.startsWith('sep')));
  });
});
