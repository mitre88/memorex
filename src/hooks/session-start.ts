#!/usr/bin/env node
import { getDb } from '../db.js';
import { resetSession, sessionStats } from '../session.js';
import { CONFIG } from '../config.js';

// Reset session counter on each new session start
resetSession();

const db = getDb();
const total = (db.prepare('SELECT COUNT(*) as n FROM memories').get() as {n: number}).n;
const sess = sessionStats();
process.stdout.write(`[Memorex: ${total} mem | ${sess.remaining}/${CONFIG.MAX_SAVES_PER_SESSION} saves left]\n`);
db.close();
