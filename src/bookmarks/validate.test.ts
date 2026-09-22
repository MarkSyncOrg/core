import { describe, expect, it } from 'vitest';
import type { Bookmark } from './bookmark';
import {
  isSafeBookmarkUrl,
  isSyncableBookmarkUrl,
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

describe('isSyncableBookmarkUrl', () => {
  // The bug this pins: these are the schemes xBrowserSync carried and MarkSync dropped
  // (MarkSyncOrg/app-next#37). None of them executes anything in the origin that holds it.
  it.each([
    'chrome://bookmarks/',
    'edge://settings/profiles',
    'brave://settings/',
    'vivaldi://history',
    'opera://about',
    'about:config',
    'file:///home/user/notes.html',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
    'moz-extension://11111111-2222-3333-4444-555555555555/options.html',
    'https://example.org/',
    'mailto:someone@example.org',
    'xbs:separator',
  ])('carries %j', (url) => {
    expect(isSyncableBookmarkUrl(url)).toBe(true);
  });

  it.each(['javascript:void(0)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>'])(
    'holds back %j unless the user opts in',
    (url) => {
      expect(isSyncableBookmarkUrl(url)).toBe(false);
      expect(isSyncableBookmarkUrl(url, { allowBookmarklets: true })).toBe(true);
    },
  );

  it.each(['', 'not a url', '/relative/path', 'example.org'])(
    'refuses %j, which no browser produces',
    (url) => {
      expect(isSyncableBookmarkUrl(url)).toBe(false);
      expect(isSyncableBookmarkUrl(url, { allowBookmarklets: true })).toBe(false);
    },
  );

  it('treats a folder (no URL) as syncable', () => {
    expect(isSyncableBookmarkUrl(undefined)).toBe(true);
  });

  it('stays wider than the render guard, which the opt-in never widens', () => {
    expect(isSafeBookmarkUrl('chrome://bookmarks/')).toBe(false);
    expect(isSafeBookmarkUrl('file:///etc/hosts')).toBe(false);
    expect(isSafeBookmarkUrl('javascript:void(0)')).toBe(false);
  });
});

describe('sanitizeBookmarkTree scheme policy', () => {
  const tree: Bookmark[] = [
    {
      title: 'Toolbar',
      children: [
        { title: 'page', url: 'https://x.org/' },
        { title: 'internals', url: 'chrome://bookmarks/' },
        { title: 'local file', url: 'file:///home/user/notes.html' },
        { title: 'let', url: BOOKMARKLET },
      ],
    },
  ];

  it('keeps local and browser-internal bookmarks', () => {
    const urls = sanitizeBookmarkTree(tree)[0]!.children!.map((node) => node.url);
    expect(urls).toEqual(['https://x.org/', 'chrome://bookmarks/', 'file:///home/user/notes.html']);
  });

  it('reports only the bookmarklet as removed', () => {
    expect(sanitizeBookmarkTreeWithReport(tree).removed).toEqual([
      { bookmark: { title: 'let', url: BOOKMARKLET }, path: ['Toolbar'], index: 3 },
    ]);
  });

  it('keeps the bookmarklet too once the user opts in', () => {
    const { bookmarks, removed } = sanitizeBookmarkTreeWithReport(tree, {
      allowBookmarklets: true,
    });
    expect(removed).toEqual([]);
    expect(bookmarks[0]!.children!.map((node) => node.url)).toContain(BOOKMARKLET);
  });
});
