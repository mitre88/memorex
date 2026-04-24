import { normalize } from 'path';
import { LIMITS } from './config.js';

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
  if (sanitized.length > LIMITS.MAX_QUERY_LENGTH) {
    sanitized = sanitized.slice(0, LIMITS.MAX_QUERY_LENGTH);
  }

  return sanitized || '*';
}

/**
 * Validates that a project path is well-formed.
 *
 * The previous implementation rejected any absolute path outside `$HOME`,
 * which broke legitimate repos under `/tmp`, `/private/var` (macOS realpath),
 * `/opt`, system repos, etc. Git-root detection already produces paths the
 * user trusts, and the search/save paths use parameterized SQL so there is
 * no SQL-injection vector through this string. We keep the lightweight
 * safety net (no null bytes, no traversal beyond the starting point,
 * bounded length) without the home-scope jail.
 */
export function isValidProjectPath(project: string): boolean {
  if (!project || typeof project !== 'string') {
    return false;
  }
  if (project.includes('\0')) return false;
  if (project.length > LIMITS.MAX_PROJECT_PATH_LENGTH) return false;

  // Reject `..` sequences that would escape the starting point. We permit
  // absolute paths on any root (they canonicalize below) and relative paths
  // as long as they never dip below depth 0.
  const normalized = normalize(project);
  const parts = normalized.split(/[/\\]/);
  let depth = 0;
  for (const part of parts) {
    if (part === '..') {
      depth--;
      if (depth < 0) return false;
    } else if (part && part !== '.') {
      depth++;
    }
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
  if (tags.length > LIMITS.MAX_TAGS) {
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
    if (tag.length > LIMITS.MAX_TAG_LENGTH) {
      return false;
    }
  }

  return true;
}
