import { describe, expect, it } from 'vitest';
import { type Bookmark, BookmarkContainer, SEPARATOR_URL } from '../bookmarks/bookmark';
import { threeWayMerge } from './merge';

/** A toolbar container wrapping the given children (the common top-level shape). */
function toolbar(children: Bookmark[]): Bookmark[] {
  return [{ title: BookmarkContainer.Toolbar, children }];
}

const a: Bookmark = { title: 'A', url: 'https://a.org' };
const b: Bookmark = { title: 'B', url: 'https://b.org' };
const c: Bookmark = { title: 'C', url: 'https://c.org' };

describe('threeWayMerge — no-op and one-sided changes', () => {
  it('returns the common tree when nothing changed', () => {
    const tree = toolbar([a, b]);
    expect(threeWayMerge(tree, tree, tree)).toEqual(toolbar([a, b]));
  });

  it('keeps a local-only addition', () => {
    const base = toolbar([a]);
    const local = toolbar([a, b]);
    expect(threeWayMerge(base, local, base)).toEqual(toolbar([a, b]));
  });

  it('keeps a remote-only addition', () => {
    const base = toolbar([a]);
    const remote = toolbar([a, b]);
    expect(threeWayMerge(base, base, remote)).toEqual(toolbar([a, b]));
  });

  it('applies a local-only deletion', () => {
    const base = toolbar([a, b]);
    const local = toolbar([a]);
    expect(threeWayMerge(base, local, base)).toEqual(toolbar([a]));
  });

  it('applies a remote-only deletion', () => {
    const base = toolbar([a, b]);
    const remote = toolbar([a]);
    expect(threeWayMerge(base, base, remote)).toEqual(toolbar([a]));
  });
});

describe('threeWayMerge — concurrent additions (the core parity case)', () => {
  it('keeps additions from both sides', () => {
    const base = toolbar([a]);
    const local = toolbar([a, b]);
    const remote = toolbar([a, c]);
    const merged = threeWayMerge(base, local, remote);
    const urls = merged[0]!.children!.map((n) => n.url);
    expect(urls).toContain('https://a.org');
    expect(urls).toContain('https://b.org');
    expect(urls).toContain('https://c.org');
    expect(urls).toHaveLength(3);
  });

  it('merges additions made in different folders', () => {
    const base = toolbar([{ title: 'F', children: [a] }]);
    const local = toolbar([{ title: 'F', children: [a, b] }]);
    const remote = toolbar([{ title: 'F', children: [a, c] }]);
    const merged = threeWayMerge(base, local, remote);
    const folder = merged[0]!.children![0]!;
    expect(folder.children!.map((n) => n.url)).toEqual([
      'https://a.org',
      'https://b.org',
      'https://c.org',
    ]);
  });
});

describe('threeWayMerge — attribute merges', () => {
  it('takes a title edited on one side only', () => {
    const base = toolbar([a]);
    const local = toolbar([{ ...a, title: 'A renamed' }]);
    const merged = threeWayMerge(base, local, base);
    expect(merged[0]!.children![0]!.title).toBe('A renamed');
  });

  it('remote wins when the same attribute is edited on both sides', () => {
    const base = toolbar([a]);
    const local = toolbar([{ ...a, title: 'local title' }]);
    const remote = toolbar([{ ...a, title: 'remote title' }]);
    const merged = threeWayMerge(base, local, remote);
    expect(merged[0]!.children![0]!.title).toBe('remote title');
  });

  it('merges tags edited on one side', () => {
    const tagged: Bookmark = { title: 'A', url: 'https://a.org', tags: ['x'] };
    const base = toolbar([tagged]);
    const local = toolbar([{ ...tagged, tags: ['x', 'y'] }]);
    const merged = threeWayMerge(base, local, base);
    expect(merged[0]!.children![0]!.tags).toEqual(['x', 'y']);
  });
});

describe('threeWayMerge — delete vs edit', () => {
  it('resurrects a node deleted remotely but edited locally', () => {
    const base = toolbar([a, b]);
    const local = toolbar([a, { ...b, title: 'B edited' }]);
    const remote = toolbar([a]); // remote deleted b
    const merged = threeWayMerge(base, local, remote);
    const titles = merged[0]!.children!.map((n) => n.title);
    expect(titles).toContain('B edited');
  });

  it('honours a remote deletion when the node is untouched locally', () => {
    const base = toolbar([a, b]);
    const remote = toolbar([a]);
    const merged = threeWayMerge(base, base, remote);
    expect(merged[0]!.children!.map((n) => n.url)).toEqual(['https://a.org']);
  });

  it('drops a node deleted on both sides', () => {
    const base = toolbar([a, b]);
    const local = toolbar([a]);
    const remote = toolbar([a]);
    expect(threeWayMerge(base, local, remote)).toEqual(toolbar([a]));
  });
});

describe('threeWayMerge — edge cases', () => {
  it('handles an empty base (first merge): unions both sides', () => {
    const merged = threeWayMerge([], toolbar([a]), toolbar([b]));
    const urls = merged[0]!.children!.map((n) => n.url);
    expect(urls).toContain('https://a.org');
    expect(urls).toContain('https://b.org');
  });

  it('preserves separators', () => {
    const sep: Bookmark = { url: SEPARATOR_URL };
    const base = toolbar([a, sep, b]);
    expect(threeWayMerge(base, base, base)).toEqual(toolbar([a, sep, b]));
  });

  it('matches duplicate URLs in the same folder by position', () => {
    const dup: Bookmark = { title: 'Dup', url: 'https://dup.org' };
    const base = toolbar([dup, dup]);
    const local = toolbar([{ ...dup, title: 'first' }, dup]);
    const merged = threeWayMerge(base, local, base);
    expect(merged[0]!.children!.map((n) => n.title)).toEqual(['first', 'Dup']);
  });

  it('produces a tree free of IDs', () => {
    const base = toolbar([{ ...a, id: 5 }]);
    const merged = threeWayMerge(base, base, base);
    expect(JSON.stringify(merged)).not.toContain('"id"');
  });
});
