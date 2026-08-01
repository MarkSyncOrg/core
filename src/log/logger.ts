import type { StorageArea } from '../storage/storage-area.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
}

const LOG_KEY = 'traceLog';
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Scrubs values that must not reach a shareable trace log.
 *
 * The log lives in the same storage area as the sync credentials and is designed to be
 * downloaded and attached to bug reports, so anything identifying the sync is stripped
 * on the way in — redacting at write time means a log that was never sensitive, rather
 * than one that has to be sanitised before every share.
 *
 * Covers the sync ID (32 hex characters), a Base64-encoded 256-bit key (the stored
 * password hash), and credentials embedded in a URL.
 */
export function redactSensitive(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted-credentials]@')
    .replace(/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g, '[redacted-key]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[redacted-sync-id]');
}

/**
 * Append-only debug log persisted in storage (capped, oldest entries dropped). Used
 * by the background worker to record sync activity; the options page reads, downloads
 * and clears it.
 */
export class Logger {
  constructor(
    private readonly area: StorageArea,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    /** Scrub sync IDs, keys and URL credentials from messages. Disable only for tests. */
    private readonly redact = true,
  ) {}

  async append(level: LogLevel, message: string): Promise<void> {
    const entries = await this.getEntries();
    entries.push({
      timestamp: Date.now(),
      level,
      message: this.redact ? redactSensitive(message) : message,
    });
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
