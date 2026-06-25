import { describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '../storage/storage-area';
import { formatLog, Logger } from './logger';

describe('Logger', () => {
  it('appends entries with level and timestamp', async () => {
    const logger = new Logger(new MemoryStorageArea());
    await logger.info('started');
    await logger.error('boom');

    const entries = await logger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.level).toBe('info');
    expect(entries[1]!.message).toBe('boom');
    expect(typeof entries[0]!.timestamp).toBe('number');
  });

  it('caps the log to the maximum, dropping the oldest', async () => {
    const logger = new Logger(new MemoryStorageArea(), 3);
    for (let i = 0; i < 5; i += 1) {
      await logger.info(`entry ${i}`);
    }
    const entries = await logger.getEntries();
    expect(entries.map((e) => e.message)).toEqual(['entry 2', 'entry 3', 'entry 4']);
  });

  it('clears the log', async () => {
    const logger = new Logger(new MemoryStorageArea());
    await logger.info('x');
    await logger.clear();
    expect(await logger.getEntries()).toEqual([]);
  });

  it('formats entries as tab-separated lines', () => {
    const text = formatLog([{ timestamp: 0, level: 'warn', message: 'hi' }]);
    expect(text).toBe('1970-01-01T00:00:00.000Z\tWARN\thi');
  });
});
