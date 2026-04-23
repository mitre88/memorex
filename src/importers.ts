/**
 * Bulk importers for bootstrapping memorex from existing knowledge bases.
 *
 * All importers bypass the session save rate limit (this is a one-shot user
 * action, not Claude writing memories) but still respect the hard 200-memory
 * cap via eviction in saveMemory(). Each importer returns {imported, skipped}.
 *
 * Sources:
 *   - claude-md   CLAUDE.md-style project instructions (one memory per H2 section)
 *   - obsidian    markdown vault; recurses, one memory per .md file
 *   - engram      JSON dump from engram-memory plugin (array of observations)
 */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, relative } from 'path';

export type ImportSource = 'claude-md' | 'obsidian' | 'engram';

export interface ImportResult {
  imported: number;
  skipped: number;
}

interface RawMemory {
  type: 'user' | 'project' | 'feedback' | 'reference';
  title: string;
  body: string;
  tags: string[];
  importance: number;
  project: string | null;
}

function insertRaw(db: Database.Database, mem: RawMemory): boolean {
  const now = Math.floor(Date.now() / 1000);
  // Dedup by (type, title) — same rule as saveMemory's exact-match path.
  const existing = db
    .prepare('SELECT id FROM memories WHERE type = ? AND title = ? LIMIT 1')
    .get(mem.type, mem.title) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE memories SET body = ?, tags = ?, accessed_at = ? WHERE id = ?').run(
      mem.body,
      JSON.stringify(mem.tags),
      now,
      existing.id
    );
    return false;
  }
  db.prepare(
    `INSERT INTO memories (type, title, body, project, tags, importance, pinned, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    mem.type,
    mem.title,
    mem.body,
    mem.project,
    JSON.stringify(mem.tags),
    mem.importance,
    now,
    now
  );
  return true;
}

/**
 * Split a CLAUDE.md-style markdown file into section memories by H2 headings.
 * Why H2: H1 is usually the doc title; H2 is the coarsest "topic" boundary
 * in real-world CLAUDE.md files (Environment, Workspace, Skills, etc.).
 */
function importClaudeMd(db: Database.Database, path: string): ImportResult {
  const raw = readFileSync(path, 'utf8');
  const sections = raw.split(/\n(?=## )/g);
  let imported = 0;
  let skipped = 0;
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || !trimmed.startsWith('## ')) {
      skipped++;
      continue;
    }
    const lines = trimmed.split('\n');
    const title = lines[0].replace(/^## +/, '').slice(0, 80).trim();
    const body = lines.slice(1).join('\n').trim().slice(0, 4000);
    if (!title || body.length < 20) {
      skipped++;
      continue;
    }
    const inserted = insertRaw(db, {
      type: 'reference',
      title: `claude.md: ${title}`,
      body,
      tags: ['imported', 'claude-md'],
      importance: 0.6,
      project: null,
    });
    if (inserted) imported++;
    else skipped++;
  }
  return { imported, skipped };
}

/**
 * Recurse an Obsidian vault, import each .md file as a memory. Folder path
 * becomes a tag so vault structure survives as queryable context.
 */
function importObsidian(db: Database.Database, vaultPath: string): ImportResult {
  let imported = 0;
  let skipped = 0;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue; // skip .obsidian, .trash, etc.
      const full = join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      const title = basename(name, '.md').slice(0, 80);
      const body = content.slice(0, 4000).trim();
      if (body.length < 30) {
        skipped++;
        continue;
      }
      const folder = relative(vaultPath, dir).split(/[/\\]/).filter(Boolean);
      const tags = ['imported', 'obsidian', ...folder.slice(0, 5)];
      const inserted = insertRaw(db, {
        type: 'reference',
        title,
        body,
        tags,
        importance: 0.5,
        project: null,
      });
      if (inserted) imported++;
      else skipped++;
    }
  };

  walk(vaultPath);
  return { imported, skipped };
}

interface EngramObservation {
  title?: string;
  content?: string;
  body?: string;
  type?: string;
  project?: string;
  tags?: string[];
  importance?: number;
}

/**
 * Import an Engram JSON dump. Accepts either an array at the root or an
 * object with `observations: [...]`. Maps Engram types onto memorex types
 * when recognizable; otherwise falls back to 'reference'.
 */
function importEngram(db: Database.Database, path: string): ImportResult {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const arr: EngramObservation[] = Array.isArray(parsed)
    ? (parsed as EngramObservation[])
    : ((parsed as { observations?: EngramObservation[] })?.observations ?? []);
  let imported = 0;
  let skipped = 0;

  const typeMap: Record<string, RawMemory['type']> = {
    decision: 'project',
    bugfix: 'project',
    architecture: 'project',
    discovery: 'project',
    pattern: 'project',
    config: 'project',
    preference: 'user',
    learning: 'reference',
  };

  for (const obs of arr) {
    const title = (obs.title ?? '').slice(0, 80).trim();
    const body = (obs.content ?? obs.body ?? '').slice(0, 4000).trim();
    if (!title || body.length < 20) {
      skipped++;
      continue;
    }
    const mappedType = obs.type ? (typeMap[obs.type] ?? 'reference') : 'reference';
    const tags = ['imported', 'engram', ...(Array.isArray(obs.tags) ? obs.tags.slice(0, 8) : [])];
    const inserted = insertRaw(db, {
      type: mappedType,
      title,
      body,
      tags,
      importance: typeof obs.importance === 'number' ? obs.importance : 0.5,
      project: typeof obs.project === 'string' ? obs.project : null,
    });
    if (inserted) imported++;
    else skipped++;
  }
  return { imported, skipped };
}

export function runImport(db: Database.Database, source: ImportSource, path: string): ImportResult {
  const stats = statSync(path); // throws clean if path missing
  if (source === 'obsidian' && !stats.isDirectory()) {
    throw new Error('obsidian import expects a directory');
  }
  if ((source === 'claude-md' || source === 'engram') && !stats.isFile()) {
    throw new Error(`${source} import expects a file`);
  }

  // Wrap in a transaction — importers can be chatty and we want atomicity.
  const tx = db.transaction(() => {
    switch (source) {
      case 'claude-md':
        return importClaudeMd(db, path);
      case 'obsidian':
        return importObsidian(db, path);
      case 'engram':
        return importEngram(db, path);
    }
  });
  return tx();
}
