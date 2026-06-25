import { describe, expect, it } from 'vitest';
import { type Bookmark, BookmarkContainer } from '../bookmarks/bookmark';
import { backupFilename, buildBackup, extractBookmarks, parseBackup } from './backup';

const bookmarks: Bookmark[] = [
  { title: BookmarkContainer.Toolbar, children: [{ title: 'X', url: 'https://x.org' }] },
];

describe('buildBackup / extractBookmarks', () => {
  it('builds a current-format backup and round-trips the bookmarks', () => {
    const backup = buildBackup(bookmarks, { id: 'abc', url: 'https://svc', type: 'xbrowsersync' });
    expect(backup.xbrowsersync?.data.bookmarks).toEqual(bookmarks);
    expect(backup.xbrowsersync?.sync?.id).toBe('abc');
    expect(extractBookmarks(backup)).toEqual(bookmarks);
  });

  it('omits sync info when not provided', () => {
    expect(buildBackup(bookmarks).xbrowsersync?.sync).toBeUndefined();
  });

  it('reads bookmarks from the legacy backup shape', () => {
    expect(extractBookmarks({ xBrowserSync: { bookmarks, id: 'x' } })).toEqual(bookmarks);
  });

  it('throws on an unrecognised backup', () => {
    expect(() => extractBookmarks({})).toThrow();
  });
});

describe('parseBackup', () => {
  it('parses valid backup JSON', () => {
    const json = JSON.stringify(buildBackup(bookmarks));
    expect(extractBookmarks(parseBackup(json))).toEqual(bookmarks);
  });

  it('rejects invalid JSON content', () => {
    expect(() => parseBackup('"just a string"')).toThrow();
    expect(() => parseBackup('{"nope":1}')).toThrow();
  });
});

describe('backupFilename', () => {
  it('formats the timestamp', () => {
    expect(backupFilename(new Date('2026-06-22T15:30:00'))).toBe('xbs_backup_20260622153000.txt');
  });
});
