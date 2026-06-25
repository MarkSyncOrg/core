import { describe, expect, it } from 'vitest';
import { XbrowsersyncApi } from '../api/xbrowsersync-api';
import {
  assignIds,
  type Bookmark,
  BookmarkContainer,
  deserializeBookmarks,
  serializeBookmarks,
} from '../bookmarks/bookmark';
import { decryptData, encryptData, getPasswordHash } from '../crypto/crypto';

// Contract test against a REAL xBrowserSync backend. It is skipped unless
// XBS_CONTRACT_URL is set, so it never runs in normal CI. To run it:
//
//   docker compose -f contract/docker-compose.yml up -d
//   XBS_CONTRACT_URL=http://localhost:8080 npm run test:contract
//
// It proves end-to-end interoperability of crypto + API client + data format with
// the reference server: data we encrypt and upload comes back and decrypts identically.
const serviceUrl = process.env.XBS_CONTRACT_URL;

describe.runIf(serviceUrl)('backend contract', () => {
  const url = serviceUrl as string;
  const appVersion = '1.1.13';
  const bookmarks: Bookmark[] = [
    {
      title: BookmarkContainer.Toolbar,
      children: [
        { title: 'xBrowserSync', url: 'https://www.xbrowsersync.org' },
        { title: 'Folder', children: [{ title: 'Nested', url: 'https://example.org' }] },
      ],
    },
  ];

  it('exposes a supported service', async () => {
    const info = await new XbrowsersyncApi(url).getInfo();
    expect(info.status).toBeGreaterThanOrEqual(1);
    expect(info.version).toBeTruthy();
  });

  it('round-trips encrypted bookmarks: create -> update -> get -> decrypt', async () => {
    const api = new XbrowsersyncApi(url);

    const created = await api.createSync(appVersion);
    expect(created.id).toMatch(/^[a-f0-9]{32}$/);

    const passwordHash = await getPasswordHash('correct horse battery staple', created.id);
    const expected = assignIds(bookmarks);
    const encrypted = await encryptData(serializeBookmarks(expected), passwordHash);

    const updatedAt = await api.updateSync(created.id, encrypted, created.lastUpdated, appVersion);

    const remote = await api.getSync(created.id);
    expect(remote.lastUpdated).toBe(updatedAt);
    expect(remote.version).toBe(appVersion);

    const decrypted = deserializeBookmarks(await decryptData(remote.bookmarks, passwordHash));
    expect(decrypted).toEqual(expected);
  });

  it('rejects an update with a stale timestamp (conflict detection)', async () => {
    const api = new XbrowsersyncApi(url);
    const created = await api.createSync(appVersion);
    const hash = await getPasswordHash('pw', created.id);
    const payload = await encryptData(serializeBookmarks(assignIds(bookmarks)), hash);

    // First update succeeds and advances lastUpdated.
    await api.updateSync(created.id, payload, created.lastUpdated, appVersion);
    // Second update with the now-stale original timestamp must conflict.
    const { SyncConflictError } = await import('../errors');
    await expect(api.updateSync(created.id, payload, created.lastUpdated)).rejects.toBeInstanceOf(
      SyncConflictError,
    );
  });
});
