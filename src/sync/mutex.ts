/**
 * A minimal async mutex: serialises asynchronous critical sections so they run one at
 * a time, in call order. The sync controller uses it to make every push/pull/restore
 * atomic with respect to the others — without it, a bookmark edit or a second sync
 * firing mid-operation can interleave with the destructive `setBookmarks` and upload a
 * partial tree, corrupting the remote sync.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs `task` once all previously-queued tasks have settled, and resolves with its
   * result. A rejection in one task does not break the chain for later tasks.
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    // Keep the chain alive even if this task rejects; swallow here so the stored tail
    // never carries an unhandled rejection (the caller still sees the real result).
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
