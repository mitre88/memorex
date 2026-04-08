import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_DIR = join(homedir(), '.memorex', 'logs');
const LOG_FILE = join(LOG_DIR, `memorex-${new Date().toISOString().split('T')[0]}.log`);

class Logger {
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private level: LogLevel = 'info';

  constructor() {
    if (process.env.MEMOREX_LOG_LEVEL) {
      this.level = process.env.MEMOREX_LOG_LEVEL as LogLevel;
    }
  }

  private getStream(): ReturnType<typeof createWriteStream> {
    if (!this.stream) {
      if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
      }
      this.stream = createWriteStream(LOG_FILE, { flags: 'a' });
    }
    return this.stream;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] >= levels[this.level];
  }

  private format(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
  }

  debug(message: string, meta?: unknown): void {
    if (this.shouldLog('debug')) {
      this.getStream().write(this.format('debug', message, meta));
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog('info')) {
      this.getStream().write(this.format('info', message, meta));
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog('warn')) {
      this.getStream().write(this.format('warn', message, meta));
    }
  }

  error(message: string, error?: Error): void {
    if (this.shouldLog('error')) {
      const meta = error instanceof Error ? { message: error.message, stack: error.stack } : error;
      this.getStream().write(this.format('error', message, meta));
    }
  }
}

export const logger = new Logger();
