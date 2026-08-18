import { isValidSyncId, XbrowsersyncApi } from '../api/xbrowsersync-api.js';
import {
  assignIds,
  type Bookmark,
  canonicalizeBookmarks,
  deserializeBookmarks,
  serializeBookmarks,
} from '../bookmarks/bookmark.js';
import {
  acceptBookmarkTree,
  acceptBookmarkTreeWithReport,
  reinstateRemovedBookmarks,
  type SanitizeResult,
  sanitizeBookmarkTree,
} from '../bookmarks/validate.js';
import { decryptData, encryptData, getPasswordHash } from '../crypto/crypto.js';
import {
  InvalidCredentialsError,
  SyncDirectionError,
  SyncNotEnabledError,
  SyncNotFoundError,
} from '../errors.js';
import type { SyncDirection, SyncInfo, SyncStore } from '../storage/sync-store.js';
import type { BookmarkProvider } from './bookmark-provider.js';
import { threeWayMerge } from './merge.js';

/** The subset of the API client the engine uses (so tests can supply a fake). */
export type ApiClient = Pick<
  XbrowsersyncApi,
  'getInfo' | 'createSync' | 'getSync' | 'getLastUpdated' | 'updateSync'
>;

export type ApiFactory = (serviceUrl: string) => ApiClient;

export interface SyncEngineOptions {
  store: SyncStore;
  provider: BookmarkProvider;
  /** Sync data format version this client writes (sent on create/update). */
  appVersion: string;
  /** Override the API client factory (defaults to the real HTTP client). */
  createApi?: ApiFactory;
}

export interface SyncStatus {
  enabled: boolean;
  serviceUrl?: string;
  syncId?: string;
  lastUpdated?: string;
  /** Which way this device lets bookmarks flow (from settings, not from the service). */
  direction: SyncDirection;
}

/**
 * Result of a reconciling {@link SyncEngine.sync}:
 * - `idle` — nothing to do (no local edits, remote unchanged)
 * - `pushed` — local edits uploaded (remote was unchanged)
 * - `pulled` — remote changes applied locally (no local edits)
 * - `merged` — both sides changed; a three-way merge was applied locally and uploaded
 * - `skipped` — remote changed but this device is `push-only`, so nothing was applied
 * - `reverted` — local edits on a `pull-only` device were undone from the last-synced tree
 */
export type SyncOutcome = 'idle' | 'pushed' | 'pulled' | 'merged' | 'skipped' | 'reverted';

/**
 * Orchestrates bookmark synchronisation between the browser and an xBrowserSync
 * service. Uses full-tree push/pull: the entire bookmark tree is encrypted and
 * uploaded, or downloaded and applied. Change detection uses the `lastUpdated`
 * timestamp; a server-side change during push surfaces as a SyncConflictError.
 *
 * The `syncDirection` setting narrows which of those halves the device performs. A
 * `push-only` device never applies the service's tree, and a `pull-only` one never
 * uploads its own; the guards live here rather than in the callers so the direction
 * holds for background sync, bookmark-change pushes and the recovery actions alike.
 * Enabling a sync is exempt: `enableNewSync` has to upload the tree it creates the sync
 * from, and `enableExistingSync` has to download the one it is joining, and both are
 * explicit setup steps the user just asked for.
 */
export class SyncEngine {
  private readonly store: SyncStore;
  private readonly provider: BookmarkProvider;
  private readonly appVersion: string;
  private readonly createApi: ApiFactory;

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.appVersion = options.appVersion;
    this.createApi = options.createApi ?? ((serviceUrl) => new XbrowsersyncApi(serviceUrl));
  }

  /**
   * Creates a brand-new sync from the browser's current bookmarks and enables sync.
   * Returns the generated sync ID (the user must save it to sync other devices).
   */
  async enableNewSync(serviceUrl: string, password: string): Promise<string> {
    const api = this.createApi(serviceUrl);
    await api.getInfo();

    const created = await api.createSync(this.appVersion);
    const passwordHash = await getPasswordHash(password, created.id);

    const lastUpdated = await this.uploadLocal(
      api,
      created.id,
      passwordHash,
      created.lastUpdated,
      this.appVersion,
    );

    await this.persist(
      { serviceUrl, syncId: created.id, passwordHash },
      created.version,
      lastUpdated,
    );
    return created.id;
  }

  /**
   * Enables sync against an existing sync ID, downloading and applying its bookmarks.
   * Throws InvalidCredentialsError if the password cannot decrypt the data.
   */
  async enableExistingSync(serviceUrl: string, syncId: string, password: string): Promise<void> {
    if (!isValidSyncId(syncId)) {
      // Checked before the 250k-iteration key derivation so a typo fails fast, with a
      // message about the ID rather than an opaque lookup failure a round trip later.
      throw new SyncNotFoundError('Sync ID must be 32 lowercase hexadecimal characters');
    }
    const api = this.createApi(serviceUrl);
    await api.getInfo();

    const passwordHash = await getPasswordHash(password, syncId);
    const remote = await api.getSync(syncId);
    const bookmarks = await this.decryptBookmarks(remote.bookmarks, passwordHash);

    await this.applyRemote(bookmarks);
    await this.persist({ serviceUrl, syncId, passwordHash }, remote.version, remote.lastUpdated);
  }

  /**
   * Pulls remote bookmarks into the browser when the sync changed since the last pull.
   * Returns true when local bookmarks were updated.
   */
  async pull(): Promise<boolean> {
    const { api, info } = await this.requireSync();
    await this.requireDirection('pull');

    const remoteLastUpdated = await api.getLastUpdated(info.syncId);
    const localLastUpdated = await this.store.getLastUpdated();
    if (remoteLastUpdated === localLastUpdated) {
      return false;
    }

    const remote = await api.getSync(info.syncId);
    const bookmarks = await this.decryptBookmarks(remote.bookmarks, info.passwordHash);
    await this.applyRemote(bookmarks);
    await this.store.setLastUpdated(remote.lastUpdated);
    return true;
  }

  /**
   * Pushes the browser's current bookmarks to the service. Throws SyncConflictError if
   * the remote sync changed since the last pull; the caller should pull and retry.
   */
  async push(): Promise<void> {
    const { api, info } = await this.requireSync();
    await this.requireDirection('push');

    const lastUpdated = await this.store.getLastUpdated();
    const newLastUpdated = await this.uploadLocal(api, info.syncId, info.passwordHash, lastUpdated);
    await this.store.setLastUpdated(newLastUpdated);
  }

  /**
   * Reconciles this device with the service, choosing the safe action automatically:
   * pushes when only local changed, pulls when only remote changed, and three-way
   * merges when both changed (so neither side's edits are lost). Returns what it did.
   *
   * The merge applies locally and uploads against the server timestamp we merged from;
   * if the server changed again in between, the upload raises SyncConflictError and the
   * caller should retry.
   */
  async sync(): Promise<SyncOutcome> {
    const { api, info } = await this.requireSync();

    const remoteLastUpdated = await api.getLastUpdated(info.syncId);
    const localLastUpdated = await this.store.getLastUpdated();
    const remoteChanged = remoteLastUpdated !== localLastUpdated;
    const dirty = await this.isDirty();

    const direction = await this.getDirection();
    if (direction === 'push-only') {
      return this.syncPushOnly(api, info, remoteLastUpdated, remoteChanged, dirty);
    }
    if (direction === 'pull-only') {
      return this.syncPullOnly(api, info, remoteChanged, dirty);
    }

    if (!remoteChanged) {
      if (!dirty) {
        return 'idle';
      }
      await this.push();
      return 'pushed';
    }
    if (!dirty) {
      await this.pull();
      return 'pulled';
    }

    // Both sides changed: download remote, three-way merge against the cached base,
    // apply the result locally, then upload it against the timestamp we merged from.
    const remote = await api.getSync(info.syncId);
    const remoteTree = await this.decryptBookmarks(remote.bookmarks, info.passwordHash);
    const cached = await this.store.getCachedBookmarks();
    const base = cached ? deserializeBookmarks(cached) : [];
    const local = await this.localBookmarks();

    const merged = threeWayMerge(base, local, remoteTree);
    await this.applyRemote(merged);
    const newLastUpdated = await this.uploadLocal(
      api,
      info.syncId,
      info.passwordHash,
      remote.lastUpdated,
    );
    await this.store.setLastUpdated(newLastUpdated);
    return 'merged';
  }

  /**
   * Reconciles a `push-only` device: this browser owns the bookmarks and never takes
   * any from the service.
   *
   * When there are local edits they are uploaded against the service's *current*
   * timestamp, so the upload always wins rather than raising a conflict the device is
   * not allowed to resolve by pulling. When there are none, a remote change is recorded
   * as seen without being applied — carrying the timestamp forward is what keeps the
   * next local edit uploadable instead of conflicting for ever.
   */
  private async syncPushOnly(
    api: ApiClient,
    info: SyncInfo,
    remoteLastUpdated: string,
    remoteChanged: boolean,
    dirty: boolean,
  ): Promise<SyncOutcome> {
    if (!dirty) {
      if (!remoteChanged) {
        return 'idle';
      }
      await this.store.setLastUpdated(remoteLastUpdated);
      return 'skipped';
    }
    const newLastUpdated = await this.uploadLocal(
      api,
      info.syncId,
      info.passwordHash,
      remoteLastUpdated,
    );
    await this.store.setLastUpdated(newLastUpdated);
    return 'pushed';
  }

  /**
   * Reconciles a `pull-only` device: this browser mirrors the service and never sends
   * it anything.
   *
   * A remote change is applied unconditionally. Local edits cannot block it the way
   * they do in two-way mode — they are never going to be uploaded, so merging them in
   * would only feed this browser's own state back into a tree that is supposed to be a
   * copy. For the same reason, local edits made while the remote sat still are undone
   * from the last-synced tree: leaving them would let the mirror drift silently until
   * the service happened to change again.
   */
  private async syncPullOnly(
    api: ApiClient,
    info: SyncInfo,
    remoteChanged: boolean,
    dirty: boolean,
  ): Promise<SyncOutcome> {
    if (remoteChanged) {
      const remote = await api.getSync(info.syncId);
      const bookmarks = await this.decryptBookmarks(remote.bookmarks, info.passwordHash);
      await this.applyRemote(bookmarks);
      await this.store.setLastUpdated(remote.lastUpdated);
      return 'pulled';
    }
    const cached = dirty ? await this.store.getCachedBookmarks() : undefined;
    if (cached === undefined) {
      // `isDirty` is false without a cached tree, so this is the genuinely-idle case.
      return 'idle';
    }
    await this.applyRemote(deserializeBookmarks(cached));
    return 'reverted';
  }

  /**
   * Conflict recovery: discards local bookmarks and replaces them with the server's
   * current state, ignoring the change-detection short-circuit that {@link pull} uses.
   * Use when a device is stuck in conflict and the server copy is the source of truth.
   */
  async forcePull(): Promise<void> {
    const { api, info } = await this.requireSync();
    await this.requireDirection('pull');
    const remote = await api.getSync(info.syncId);
    const bookmarks = await this.decryptBookmarks(remote.bookmarks, info.passwordHash);
    await this.applyRemote(bookmarks);
    await this.store.setLastUpdated(remote.lastUpdated);
  }

  /**
   * Conflict recovery: overwrites the server with this device's current bookmarks,
   * bypassing conflict detection by uploading against the server's latest timestamp.
   * Use when a device is stuck in conflict and the local copy is the source of truth.
   */
  async forcePush(): Promise<void> {
    const { api, info } = await this.requireSync();
    await this.requireDirection('push');
    const remoteLastUpdated = await api.getLastUpdated(info.syncId);
    const newLastUpdated = await this.uploadLocal(
      api,
      info.syncId,
      info.passwordHash,
      remoteLastUpdated,
    );
    await this.store.setLastUpdated(newLastUpdated);
  }

  /**
   * Replaces the browser's bookmarks with a restored tree (e.g. from a backup file) and,
   * when sync is enabled, uploads it so the server converges on the restored state. The
   * local apply refreshes the cache, so a later auto-pull does not mistake the restore
   * for an un-pushed local edit. Callers must serialise this against other sync work.
   *
   * Unlike a pull, this replaces the local tree wholesale: nodes with unsafe URLs are not
   * carried over, because the user asked for these bookmarks and not the current ones.
   * Use `acceptBookmarkTreeWithReport` on the backup if you want to tell them what the
   * restored file itself lost to sanitisation.
   *
   * On a `pull-only` device the restore stays local: the tree is applied and cached, but
   * not uploaded, since that device never sends anything to the service. It is a mirror
   * again as soon as the service next changes.
   */
  async restore(bookmarks: Bookmark[]): Promise<void> {
    // Restored trees usually come from a backup file, so validate here too rather than
    // trusting the caller to have done it.
    const restored = acceptBookmarkTree(bookmarks);
    if (await this.store.isSyncEnabled()) {
      // applyRemote refreshes the cache; push then uploads the restored tree.
      await this.applyRemote(restored, false);
      if ((await this.getDirection()) !== 'pull-only') {
        await this.push();
      }
    } else {
      await this.provider.setBookmarks(restored);
    }
  }

  /**
   * Whether the browser's bookmarks differ from the last-synced (cached) tree, i.e.
   * there are local edits not yet pushed. Used to avoid overwriting them on auto-pull.
   */
  async isDirty(): Promise<boolean> {
    const cached = await this.store.getCachedBookmarks();
    if (cached === undefined) {
      return false;
    }
    const current = canonicalizeBookmarks(await this.localBookmarks());
    return current !== cached;
  }

  /** Disables sync and clears all persisted sync state (browser bookmarks are kept). */
  async disable(): Promise<void> {
    await this.store.clear();
  }

  /** Returns the current sync status for display. */
  async getStatus(): Promise<SyncStatus> {
    const [info, enabled, lastUpdated, direction] = await Promise.all([
      this.store.getSyncInfo(),
      this.store.isSyncEnabled(),
      this.store.getLastUpdated(),
      this.getDirection(),
    ]);
    return {
      enabled,
      serviceUrl: info?.serviceUrl,
      syncId: info?.syncId,
      lastUpdated,
      direction,
    };
  }

  /** The configured direction for this device (defaults to two-way). */
  private async getDirection(): Promise<SyncDirection> {
    return (await this.store.getSettings()).syncDirection;
  }

  /**
   * Throws unless this device is allowed to move bookmarks the given way. The message
   * names the setting, because the only fix is for the user to change it.
   */
  private async requireDirection(way: 'push' | 'pull'): Promise<void> {
    const direction = await this.getDirection();
    if (way === 'push' && direction === 'pull-only') {
      throw new SyncDirectionError(
        'This device is set to receive changes only, so it cannot send bookmarks to the service',
      );
    }
    if (way === 'pull' && direction === 'push-only') {
      throw new SyncDirectionError(
        'This device is set to send changes only, so it cannot apply bookmarks from the service',
      );
    }
  }

  private async requireSync(): Promise<{ api: ApiClient; info: SyncInfo }> {
    const info = await this.store.getSyncInfo();
    if (!info || !(await this.store.isSyncEnabled())) {
      throw new SyncNotEnabledError();
    }
    return { api: this.createApi(info.serviceUrl), info };
  }

  /**
   * The browser's current bookmarks, validated and stripped of unsafe-URL nodes.
   *
   * Every read of the local tree goes through here so the same policy applies to both
   * sides of a comparison. Sanitising only the remote tree would leave local and cached
   * permanently unequal, and {@link isDirty} compares them — the tree would look edited
   * on every check and sync in a loop.
   */
  private async localBookmarks(): Promise<Bookmark[]> {
    return (await this.readLocal()).bookmarks;
  }

  /**
   * The browser's current bookmarks, split into the tree the sync works with and the
   * unsafe-URL nodes held back from it. {@link applyRemote} needs the second half: those
   * nodes exist only in the browser, so a destructive write has to put them back.
   */
  private async readLocal(): Promise<SanitizeResult> {
    return acceptBookmarkTreeWithReport(await this.provider.getBookmarks());
  }

  /** Encrypts and uploads the browser's current bookmarks, updating the cache. */
  private async uploadLocal(
    api: ApiClient,
    syncId: string,
    passwordHash: string,
    lastUpdated: string | undefined,
    version?: string,
  ): Promise<string> {
    const local = assignIds(await this.localBookmarks());
    const encrypted = await encryptData(serializeBookmarks(local), passwordHash);
    const newLastUpdated = await api.updateSync(syncId, encrypted, lastUpdated, version);
    await this.store.setCachedBookmarks(canonicalizeBookmarks(local));
    return newLastUpdated;
  }

  /**
   * Applies a remote tree to the browser and refreshes the cache.
   *
   * `setBookmarks` is a destructive full-tree write and the tree being written has been
   * sanitised, so a bookmarklet the user keeps in the browser would be erased by it — the
   * sync excludes such nodes, which is not the same as deleting them. They are put back
   * before the write, at the position they held locally.
   *
   * The cache stores the tree *without* them, so it still mirrors what the service holds
   * and {@link isDirty} keeps comparing two sanitised trees.
   *
   * @param preserveLocalUnsafe pass false for a restore, where replacing the whole local
   * tree — bookmarklets included — is what the user asked for.
   */
  private async applyRemote(bookmarks: Bookmark[], preserveLocalUnsafe = true): Promise<void> {
    let local = bookmarks;
    if (preserveLocalUnsafe) {
      const { removed } = await this.readLocal();
      local = reinstateRemovedBookmarks(bookmarks, removed);
    }
    await this.provider.setBookmarks(local);
    await this.store.setCachedBookmarks(canonicalizeBookmarks(bookmarks));
  }

  private async decryptBookmarks(encrypted: string, passwordHash: string): Promise<Bookmark[]> {
    let json: string;
    try {
      json = await decryptData(encrypted, passwordHash);
    } catch {
      throw new InvalidCredentialsError();
    }
    // Validation failures stay outside the catch above: a malformed tree is not a wrong
    // password, and reporting it as one would send users chasing their credentials.
    return json ? sanitizeBookmarkTree(deserializeBookmarks(json)) : [];
  }

  private async persist(info: SyncInfo, version: string, lastUpdated: string): Promise<void> {
    await this.store.setSyncInfo(info);
    await this.store.setSyncVersion(version);
    await this.store.setLastUpdated(lastUpdated);
    await this.store.setSyncEnabled(true);
  }
}
