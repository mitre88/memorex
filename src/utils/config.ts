import { homedir } from 'os';
import { join } from 'path';

const MEMOREX_DIR = join(homedir(), '.memorex');

export const CONFIG = {
  MAX_MEMORIES: 200, // Hard cap on total stored memories
  MAX_SAVES_PER_SESSION: 5, // Max new saves per session
  MAX_BODY_LENGTH: 1500, // Max body chars per memory
  MAX_DISPLAY_BODY: 500, // Max body chars in search output
  SESSION_FILE: join(MEMOREX_DIR, 'session.json'),
  DB_DIR: MEMOREX_DIR,
} as const;
