import { promises as fs } from 'fs';
import { join } from 'path';

const LOG_DIR = process.env.LOG_DIR || 'logs';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  time: string; // ISO string
  msg: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: Record<string, any>;
}

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function getLogFilePath(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return join(LOG_DIR, `${yyyy}-${mm}-${dd}.log`);
}

async function appendLine(line: string) {
  await ensureDir(LOG_DIR);
  const file = getLogFilePath();
  await fs.appendFile(file, line + '\n', { encoding: 'utf8' });
}

export const Logger = {
  async log(level: LogLevel, msg: string, meta?: LogEntry['meta']) {
    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      msg,
      meta,
    };
    const line = JSON.stringify(entry);
    try {
      // write to file and console
      await appendLine(line);
      // eslint-disable-next-line no-console
      console[level === 'info' ? 'log' : level](`[${entry.time}] ${level.toUpperCase()}: ${msg}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Logger failed', err);
    }
  },
  info(msg: string, meta?: LogEntry['meta']) {
    return this.log('info', msg, meta);
  },
  warn(msg: string, meta?: LogEntry['meta']) {
    return this.log('warn', msg, meta);
  },
  error(msg: string, meta?: LogEntry['meta']) {
    return this.log('error', msg, meta);
  },
};
