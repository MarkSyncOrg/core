import { describe, expect, it } from 'vitest';
import { type Bookmark, BookmarkContainer, SEPARATOR_URL } from './bookmark';
import { restoreMissingContainers, restoreMissingSeparators } from './restore';

describe('restoreMissingContainers', () => {
  const toolbar: Bookmark = {
    title: BookmarkContainer.Toolbar,
    children: [{ title: 'X', url: 'https://x.org' }],
  };
  const menu: Bookmark = {
    title: BookmarkContainer.Menu,
    children: [{ title: 'M', url: 'https://m.org' }],
  };
  const other: Bookmark = { title: BookmarkContainer.Other, children: [] };

  it('carries a container the local tree has no root for, at its reference position', () => {
    expect(restoreMissingContainers([toolbar, other], [toolbar, menu, other])).toEqual([
      toolbar,
      menu,
      other,
    ]);
  });

  it('leaves a tree that already has every container untouched', () => {
    const local = [toolbar, menu, other];
    expect(restoreMissingContainers(local, [other, toolbar, menu])).toEqual(local);
  });

  it('keeps the local container, not the reference one, when both have it', () => {
    const edited: Bookmark = { title: BookmarkContainer.Toolbar, children: [] };
    expect(restoreMissingContainers([edited], [toolbar])).toEqual([edited]);
  });

  it('restores nothing from an empty reference', () => {
    expect(restoreMissingContainers([toolbar], [])).toEqual([toolbar]);
  });

  it('ignores non-container nodes in the reference', () => {
    const stray: Bookmark = { title: 'Not a container', children: [] };
    expect(restoreMissingContainers([toolbar], [stray, menu])).toEqual([toolbar, menu]);
  });
});

describe('restoreMissingSeparators', () => {
  const bookmark = (title: string): Bookmark => ({ title, url: `https://${title}.org/` });
  const separator: Bookmark = { url: SEPARATOR_URL };

  it('puts each separator back at the index it held', () => {
    const reference = [bookmark('a'), separator, bookmark('b'), separator, bookmark('c')];
    const local = [bookmark('a'), bookmark('b'), bookmark('c')];
    expect(restoreMissingSeparators(local, reference)).toEqual(reference);
  });

  it('restores one at the very front', () => {
    const reference = [separator, bookmark('a')];
    expect(restoreMissingSeparators([bookmark('a')], reference)).toEqual(reference);
  });

  it('leaves a tree that kept its separators exactly as it is', () => {
    const local = [bookmark('a'), separator, bookmark('b')];
    expect(restoreMissingSeparators(local, local)).toEqual(local);
  });

  it('recurses into the folders both trees have', () => {
    const folder = (children: Bookmark[]): Bookmark[] => [
      { title: BookmarkContainer.Other, children: [{ title: 'Folder', children }] },
    ];
    const reference = folder([bookmark('a'), separator, bookmark('b')]);
    const local = folder([bookmark('a'), bookmark('b')]);
    expect(restoreMissingSeparators(local, reference)).toEqual(reference);
  });

  it('places one best-effort when a neighbour is gone', () => {
    // 'b' deleted on this device: the separator keeps its index rather than its company.
    const reference = [bookmark('a'), separator, bookmark('b'), bookmark('c')];
    const local = [bookmark('a'), bookmark('c')];
    expect(restoreMissingSeparators(local, reference)).toEqual([
      bookmark('a'),
      separator,
      bookmark('c'),
    ]);
  });

  it('restores nothing from a reference with no separators', () => {
    const local = [bookmark('a'), bookmark('b')];
    expect(restoreMissingSeparators(local, [bookmark('a')])).toEqual(local);
  });

  it('ignores a folder that only the reference has', () => {
    const local = [bookmark('a')];
    const reference = [bookmark('a'), { title: 'Gone', children: [separator] }];
    expect(restoreMissingSeparators(local, reference)).toEqual(local);
  });

  it('does not mutate the tree it is given', () => {
    const local = [bookmark('a'), { title: 'Folder', children: [bookmark('b')] }];
    const snapshot = structuredClone(local);
    restoreMissingSeparators(local, [
      bookmark('a'),
      { title: 'Folder', children: [separator, bookmark('b')] },
    ]);
    expect(local).toEqual(snapshot);
  });
});
