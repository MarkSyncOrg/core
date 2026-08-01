import { describe, expect, it } from 'vitest';
import type { Bookmark } from './bookmark';
import {
  reinstateRemovedBookmarks,
  sanitizeBookmarkTree,
  sanitizeBookmarkTreeWithReport,
} from './validate';

const BOOKMARKLET = 'javascript:void(0)';

describe('sanitizeBookmarkTreeWithReport', () => {
  it('returns the same tree as sanitizeBookmarkTree', () => {
    const tree: Bookmark[] = [
      { title: 'ok', url: 'https://example.org/' },
      { title: 'let', url: BOOKMARKLET },
    ];
    expect(sanitizeBookmarkTreeWithReport(tree).bookmarks).toEqual(sanitizeBookmarkTree(tree));
  });

  it('reports each removal with the folder path and index it held', () => {
    const tree: Bookmark[] = [
      {
        title: 'Toolbar',
        children: [
          { title: 'a', url: 'https://a.org/' },
          { title: 'let', url: BOOKMARKLET },
          { title: 'Nested', children: [{ title: 'inline', url: 'data:text/html,x' }] },
        ],
      },
      { title: 'top-level let', url: BOOKMARKLET },
    ];

    expect(sanitizeBookmarkTreeWithReport(tree).removed).toEqual([
      { bookmark: { title: 'let', url: BOOKMARKLET }, path: ['Toolbar'], index: 1 },
      {
        bookmark: { title: 'inline', url: 'data:text/html,x' },
        path: ['Toolbar', 'Nested'],
        index: 0,
      },
      { bookmark: { title: 'top-level let', url: BOOKMARKLET }, path: [], index: 1 },
    ]);
  });

  it('reports nothing for a tree that is already safe', () => {
    expect(sanitizeBookmarkTreeWithReport([{ title: 'a', url: 'https://a.org/' }]).removed).toEqual(
      [],
    );
  });
});

describe('reinstateRemovedBookmarks', () => {
  it('restores a sanitised tree to its original shape', () => {
    const tree: Bookmark[] = [
      {
        title: 'Toolbar',
        children: [
          { title: 'a', url: 'https://a.org/' },
          { title: 'let', url: BOOKMARKLET },
          { title: 'b', url: 'https://b.org/' },
        ],
      },
      { title: 'top-level let', url: BOOKMARKLET },
    ];
    const { bookmarks, removed } = sanitizeBookmarkTreeWithReport(tree);

    expect(reinstateRemovedBookmarks(bookmarks, removed)).toEqual(tree);
  });

  it('keeps several removals from one folder in their original order', () => {
    const tree: Bookmark[] = [
      {
        title: 'Toolbar',
        children: [
          { title: 'one', url: `${BOOKMARKLET}/1` },
          { title: 'a', url: 'https://a.org/' },
          { title: 'two', url: `${BOOKMARKLET}/2` },
          { title: 'three', url: `${BOOKMARKLET}/3` },
        ],
      },
    ];
    const { bookmarks, removed } = sanitizeBookmarkTreeWithReport(tree);

    expect(reinstateRemovedBookmarks(bookmarks, removed)).toEqual(tree);
  });

  it('appends to the deepest surviving folder when the original one is gone', () => {
    const removed = sanitizeBookmarkTreeWithReport([
      { title: 'Toolbar', children: [{ title: 'Gone', children: [{ url: BOOKMARKLET }] }] },
    ]).removed;
    const target: Bookmark[] = [
      { title: 'Toolbar', children: [{ title: 'a', url: 'https://a.org/' }] },
    ];

    expect(reinstateRemovedBookmarks(target, removed)).toEqual([
      {
        title: 'Toolbar',
        children: [{ title: 'a', url: 'https://a.org/' }, { url: BOOKMARKLET }],
      },
    ]);
  });

  it('appends when the recorded index is past the end of the target folder', () => {
    const removed = sanitizeBookmarkTreeWithReport([
      { title: 'Toolbar', children: [{ url: 'https://a.org/' }, { url: BOOKMARKLET }] },
    ]).removed;
    const target: Bookmark[] = [{ title: 'Toolbar', children: [] }];

    expect(reinstateRemovedBookmarks(target, removed)).toEqual([
      { title: 'Toolbar', children: [{ url: BOOKMARKLET }] },
    ]);
  });

  it('does not match a leaf bookmark that shares a folder title', () => {
    const removed = sanitizeBookmarkTreeWithReport([
      { title: 'Same', children: [{ url: BOOKMARKLET }] },
    ]).removed;
    const target: Bookmark[] = [{ title: 'Same', url: 'https://example.org/' }];

    expect(reinstateRemovedBookmarks(target, removed)).toEqual([
      { title: 'Same', url: 'https://example.org/' },
      { url: BOOKMARKLET },
    ]);
  });

  it('leaves the input tree untouched', () => {
    const target: Bookmark[] = [{ title: 'Toolbar', children: [] }];
    const snapshot = structuredClone(target);
    const removed = sanitizeBookmarkTreeWithReport([
      { title: 'Toolbar', children: [{ url: BOOKMARKLET }] },
    ]).removed;

    reinstateRemovedBookmarks(target, removed);

    expect(target).toEqual(snapshot);
  });

  it('returns the tree as-is when nothing was removed', () => {
    const target: Bookmark[] = [{ title: 'Toolbar', children: [] }];
    expect(reinstateRemovedBookmarks(target, [])).toBe(target);
  });
});
