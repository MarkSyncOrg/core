// A minimal key/value storage abstraction. The core depends only on this interface,
// so it stays testable in Node (via MemoryStorageArea) and decoupled from the
// extension runtime (the browser-backed implementation lives in browser-storage-area.ts).
export interface StorageArea {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory StorageArea for tests and ephemeral use. */
export class MemoryStorageArea implements StorageArea {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }

  set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}
