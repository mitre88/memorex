import { describe, it, expect } from 'vitest';
import { CONFIG } from '../utils/config.js';

describe('CONFIG', () => {
  it('has all required constants', () => {
    expect(CONFIG.MAX_MEMORIES).toBe(200);
    expect(CONFIG.MAX_SAVES_PER_SESSION).toBe(5);
    expect(CONFIG.MAX_BODY_LENGTH).toBe(4000);
    expect(CONFIG.MAX_DISPLAY_BODY).toBe(500);
  });

  it('has valid paths', () => {
    expect(CONFIG.SESSION_FILE).toContain('.memorex');
    expect(CONFIG.DB_DIR).toContain('.memorex');
  });
});
