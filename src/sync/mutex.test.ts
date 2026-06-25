import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex';

/** A deferred promise plus its resolver, for driving overlap by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Mutex', () => {
  it('runs tasks one at a time, never overlapping', async () => {
    const mutex = new Mutex();
    const events: string[] = [];
    const gate = deferred();

    // First task blocks until we release the gate; the second must not start meanwhile.
    const first = mutex.runExclusive(async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = mutex.runExclusive(async () => {
      events.push('second:start');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('preserves call order and resolves with each task result', async () => {
    const mutex = new Mutex();
    const results = await Promise.all([
      mutex.runExclusive(async () => 1),
      mutex.runExclusive(async () => 2),
      mutex.runExclusive(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('keeps running later tasks after one rejects', async () => {
    const mutex = new Mutex();
    const failing = mutex.runExclusive(async () => {
      throw new Error('boom');
    });
    const next = mutex.runExclusive(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
