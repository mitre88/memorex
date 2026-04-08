import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { PATHS } from './config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_FILE = `${PATHS.LOG_DIR}/memorex-${new Date().toISOString().split('T')[0]}.log`;

class Logger {
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private level: LogLevel = 'info';
  private isClosing = false;

  constructor() {
    if (process.env.MEMOREX_LOG_LEVEL) {
      this.level = process.env.MEMOREX_LOG_LEVEL as LogLevel;
    }

    // Register cleanup handlers
    process.on('exit', () => this.close());
    process.on('SIGINT', () => {
      this.close();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      this.close();
      process.exit(0);
    });
  }

  private getStream(): ReturnType<typeof createWriteStream> | null {
    if (this.isClosing) return null;
    if (!this.stream) {
      if (!existsSync(PATHS.LOG_DIR)) {
        mkdirSync(PATHS.LOG_DIR, { recursive: true });
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

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.shouldLog(level)) return;
    const stream = this.getStream();
    if (stream) {
      stream.write(this.format(level, message, meta));
    }
  }

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }

  error(message: string, error?: Error): void {
    const meta = error instanceof Error ? { message: error.message, stack: error.stack } : error;
    this.write('error', message, meta);
  }

  close(): void {
    if (this.isClosing || !this.stream) return;
    this.isClosing = true;
    this.stream.end();
    this.stream = null;
  }
}

export const logger = new Logger();
