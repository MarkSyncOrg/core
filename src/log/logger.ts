import type { StorageArea } from '../storage/storage-area';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
}

const LOG_KEY = 'traceLog';
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Append-only debug log persisted in storage (capped, oldest entries dropped). Used
 * by the background worker to record sync activity; the options page reads, downloads
 * and clears it.
 */
export class Logger {
  constructor(
    private readonly area: StorageArea,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  async append(level: LogLevel, message: string): Promise<void> {
    const entries = await this.getEntries();
    entries.push({ timestamp: Date.now(), level, message });
    if (entries.length > this.maxEntries) {
      entries.splice(0, entries.length - this.maxEntries);
    }
    await this.area.set(LOG_KEY, entries);
  }

  info(message: string): Promise<void> {
    return this.append('info', message);
  }

  warn(message: string): Promise<void> {
    return this.append('warn', message);
  }

  error(message: string): Promise<void> {
    return this.append('error', message);
  }

  async getEntries(): Promise<LogEntry[]> {
    return (await this.area.get<LogEntry[]>(LOG_KEY)) ?? [];
  }

  clear(): Promise<void> {
    return this.area.remove(LOG_KEY);
  }
}

/** Formats log entries as downloadable plain text (one tab-separated line each). */
export function formatLog(entries: LogEntry[]): string {
  return entries
    .map((e) => `${new Date(e.timestamp).toISOString()}\t${e.level.toUpperCase()}\t${e.message}`)
    .join('\n');
}
