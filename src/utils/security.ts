import { normalize, resolve } from 'path';
import { homedir } from 'os';

/**
 * Sanitizes user input for SQLite FTS5 queries.
 * Removes FTS5 special characters that could be used for injection or DoS.
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query || typeof query !== 'string') {
    return '';
  }

  // Escape FTS5 special characters: " * ( ) AND OR NOT NEAR ^ - ~
  // Replace with spaces to avoid unintended boolean logic
  let sanitized = query
    .replace(/["*()^\-~]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Limit length to prevent DoS via complex queries
  const MAX_QUERY_LENGTH = 200;
  if (sanitized.length > MAX_QUERY_LENGTH) {
    sanitized = sanitized.slice(0, MAX_QUERY_LENGTH);
  }

  return sanitized || '*';
}

/**
 * Validates that a project path is safe.
 * Prevents path traversal attacks.
 */
export function isValidProjectPath(project: string): boolean {
  if (!project || typeof project !== 'string') {
    return false;
  }

  // Reject paths with null bytes
  if (project.includes('\0')) {
    return false;
  }

  // Normalize and check for path traversal
  const normalized = normalize(project);

  // Reject absolute paths outside home directory
  if (normalized.startsWith('/') || normalized.startsWith('\\')) {
    const home = homedir();
    const resolved = resolve(normalized);
    if (!resolved.startsWith(home)) {
      return false;
    }
  }

  // Reject parent directory references that escape intended scope
  const parts = normalized.split(/[/\\]/);
  let depth = 0;
  for (const part of parts) {
    if (part === '..') {
      depth--;
      if (depth < 0) {
        return false; // Attempts to escape above starting point
      }
    } else if (part && part !== '.') {
      depth++;
    }
  }

  // Length limit
  if (project.length > 500) {
    return false;
  }

  return true;
}

/**
 * Validates tag array for safety.
 */
export function validateTags(tags: string[]): boolean {
  if (!Array.isArray(tags)) {
    return false;
  }

  // Limit number of tags
  if (tags.length > 20) {
    return false;
  }

  for (const tag of tags) {
    if (typeof tag !== 'string') {
      return false;
    }

    // Reject tags with control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(tag)) {
      return false;
    }

    // Length limit per tag
    if (tag.length > 50) {
      return false;
    }
  }

  return true;
}
