import { EMAIL_LIKE } from './email';

/**
 * PII-safe structured JSON logger (NFR-SEC-03, NFR-OPS-02).
 * Keys on the deny-list are dropped to "[redacted]" and any value that looks like an
 * email address is replaced with "[email]". Never pass raw recipients to the logger.
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

const DENY_KEYS = new Set(['email', 'attributes', 'attrs', 'html', 'text', 'subject', 'recipients', 'password', 'token', 'cookie', 'secret', 'body']);
const DENY_PREFIXES = ['merge'];

let sink: LogSink = (line) => {
  process.stdout.write(line + '\n');
};
let minLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'INFO';
const ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function isDenied(key: string): boolean {
  const lower = key.toLowerCase();
  return DENY_KEYS.has(lower) || DENY_PREFIXES.some((p) => lower.startsWith(p));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(EMAIL_LIKE, '[email]');
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = isDenied(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(service: string, base: LogFields = {}): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const record = redact({ level, message, service, timestamp: new Date().toISOString(), ...base, ...fields });
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit('DEBUG', m, f),
    info: (m, f) => emit('INFO', m, f),
    warn: (m, f) => emit('WARN', m, f),
    error: (m, f) => emit('ERROR', m, f),
    child: (fields) => createLogger(service, { ...base, ...fields }),
  };
}
