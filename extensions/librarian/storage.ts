/**
 * Librarian -- SQLite Storage Layer
 *
 * Uses node:sqlite (built-in Node 22+) with FTS5 for full-text search.
 * Zero external dependencies.
 *
 * Schema:
 *   memories      -- individual facts, decisions, preferences, projects
 *   memories_fts  -- FTS5 virtual table for text search
 *   sessions      -- per-session metadata and summaries
 *   queue         -- sessions pending deep LLM analysis
 */

import { promises as fs } from "node:fs";
import path from "node:path";
// @ts-ignore -- node:sqlite types may not be in current @types/node
import { DatabaseSync } from "node:sqlite";
import { buildHeuristicSummary, extractFromMessages } from "./extractor.js";

// ============================================================================
// Types
// ============================================================================

export type MemoryCategory = "decision" | "preference" | "project" | "fact" | "todo" | "entity";

export type Memory = {
  id: number;
  text: string;
  category: MemoryCategory;
  sourceSession: string | null;
  createdAt: number;
  importance: number;
};

export type SessionRecord = {
  id: string;
  date: string;
  summary: string | null;
  messageCount: number;
  processed: number;
};

// Max memories to inject per context (keep tokens reasonable)
const MAX_CONTEXT_MEMORIES = 8;
// Max chars per memory in context
const MAX_MEMORY_CHARS = 200;
// FTS5 rank threshold (lower = more results, higher = more strict)
const MIN_RANK_THRESHOLD = -5.0;

// ============================================================================
// LibrarianStorage
// ============================================================================

export class LibrarianStorage {
  private db: InstanceType<typeof DatabaseSync> | null = null;
  private readonly dbPath: string;
  private readonly memoryMdPath: string;

  constructor(private readonly dir: string) {
    this.dbPath = path.join(dir, "librarian.db");
    this.memoryMdPath = path.join(dir, "memory.md");
  }

  // ============================================================================
  // DB Initialization
  // ============================================================================

  private getDb(): InstanceType<typeof DatabaseSync> {
    if (this.db) {
      return this.db;
    }
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
    return this.db;
  }

  private initSchema(): void {
    const db = this.db!;

    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        text        TEXT    NOT NULL,
        category    TEXT    NOT NULL DEFAULT 'fact',
        source_session TEXT,
        created_at  INTEGER NOT NULL,
        importance  REAL    NOT NULL DEFAULT 0.5
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
        USING fts5(text, category, content=memories, content_rowid=id);

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, category) VALUES (new.id, new.text, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, category)
          VALUES ('delete', old.id, old.text, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, category)
          VALUES ('delete', old.id, old.text, old.category);
        INSERT INTO memories_fts(rowid, text, category) VALUES (new.id, new.text, new.category);
      END;

      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT    PRIMARY KEY,
        date          TEXT    NOT NULL,
        summary       TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        processed     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS queue (
        session_id    TEXT    PRIMARY KEY,
        session_file  TEXT    NOT NULL,
        queued_at     INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private ensureDir(): void {
    // sync mkdir -- called before DB init, and DB open will fail anyway if dir missing
    const { mkdirSync } = require("node:fs");
    mkdirSync(this.dir, { recursive: true });
  }

  // ============================================================================
  // Context Block -- before_prompt_build
  // ============================================================================

  buildContextBlock(query: string): string | null {
    try {
      this.ensureDir();
      const db = this.getDb();

      // FTS5 search -- rank by relevance, fallback to recent if query is short
      let rows: Array<{ id: number; text: string; category: string; rank: number }>;

      if (query && query.length >= 5) {
        // Sanitize query for FTS5 (remove special chars)
        const ftsQuery = query.replace(/[^\w\s\-àâçéèêëîïôùûü]/gi, " ").trim();
        rows = db
          .prepare(
            `SELECT m.id, m.text, m.category, fts.rank
             FROM memories_fts fts
             JOIN memories m ON m.id = fts.rowid
             WHERE memories_fts MATCH ?
               AND fts.rank >= ?
             ORDER BY fts.rank
             LIMIT ?`,
          )
          .all(ftsQuery, MIN_RANK_THRESHOLD, MAX_CONTEXT_MEMORIES) as typeof rows;
      } else {
        rows = [];
      }

      // Always include top recent memories if FTS returned nothing
      if (rows.length === 0) {
        rows = db
          .prepare(
            `SELECT id, text, category, importance as rank
             FROM memories
             ORDER BY importance DESC, created_at DESC
             LIMIT ?`,
          )
          .all(MAX_CONTEXT_MEMORIES) as typeof rows;
      }

      if (rows.length === 0) {
        return null;
      }

      // Group by category for readability
      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        const cat = row.category;
        if (!grouped.has(cat)) {
          grouped.set(cat, []);
        }
        const text =
          row.text.length > MAX_MEMORY_CHARS
            ? row.text.slice(0, MAX_MEMORY_CHARS) + "..."
            : row.text;
        grouped.get(cat)!.push(text);
      }

      const lines: string[] = ["=== LIBRARIAN MEMORY ==="];
      for (const [cat, items] of grouped) {
        lines.push(`[${cat}]`);
        for (const item of items) {
          lines.push(`- ${item}`);
        }
      }
      lines.push("=========================");

      return lines.join("\n");
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Session Processing -- agent_end
  // ============================================================================

  processSession(params: {
    sessionId: string;
    messages: unknown[];
    sessionsDir?: string;
  }): Array<{ id: number; text: string; category: string }> {
    try {
      this.ensureDir();
      const db = this.getDb();
      const { sessionId, messages } = params;

      const extracted = extractFromMessages(messages);
      const now = Date.now();
      const date = new Date().toISOString().slice(0, 10);
      const summary = buildHeuristicSummary(sessionId, extracted);
      const inserted: Array<{ id: number; text: string; category: string }> = [];

      // Upsert session record
      db.prepare(
        `INSERT INTO sessions (id, date, summary, message_count, processed)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           message_count = excluded.message_count`,
      ).run(sessionId, date, summary, extracted.messageCount);

      // Insert extracted memories (skip near-duplicates via simple text match)
      const insertMemory = db.prepare(
        `INSERT INTO memories (text, category, source_session, created_at, importance)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM memories
           WHERE lower(text) = lower(?) AND category = ?
         )`,
      );

      const tryInsert = (text: string, category: string, importance: number) => {
        const result = insertMemory.run(
          text,
          category,
          sessionId,
          now,
          importance,
          text,
          category,
        ) as {
          changes: number;
          lastInsertRowid: number | bigint;
        };
        if (result.changes > 0) {
          inserted.push({ id: Number(result.lastInsertRowid), text, category });
        }
      };

      for (const text of extracted.decisions.slice(0, 5)) {
        tryInsert(text, "decision", 0.8);
      }
      for (const text of extracted.preferences.slice(0, 3)) {
        tryInsert(text, "preference", 0.9);
      }
      for (const text of extracted.projects.slice(0, 5)) {
        tryInsert(text, "project", 0.7);
      }
      for (const text of extracted.todos.slice(0, 3)) {
        tryInsert(text, "todo", 0.85);
      }
      for (const text of extracted.facts.slice(0, 3)) {
        tryInsert(text, "fact", 0.6);
      }

      // Queue for deep LLM analysis (same session, real conversation)
      const sessionFile = params.sessionsDir
        ? path.join(params.sessionsDir, `${sessionId}.jsonl`)
        : `~/.openclaw/agents/main/sessions/${sessionId}.jsonl`;

      db.prepare(
        `INSERT INTO queue (session_id, session_file, queued_at, message_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET queued_at = excluded.queued_at`,
      ).run(sessionId, sessionFile, now, extracted.messageCount);

      return inserted;
    } catch {
      // non-fatal -- librarian should never crash Marcel
      return [];
    }
  }

  // ============================================================================
  // Queue Access (for cron job introspection)
  // ============================================================================

  getPendingQueue(): Array<{ sessionId: string; sessionFile: string; messageCount: number }> {
    try {
      const db = this.getDb();
      return db
        .prepare(
          `SELECT session_id as sessionId, session_file as sessionFile, message_count as messageCount
             FROM queue
             ORDER BY queued_at ASC`,
        )
        .all() as Array<{ sessionId: string; sessionFile: string; messageCount: number }>;
    } catch {
      return [];
    }
  }

  // ============================================================================
  // memory.md generation -- called by cron after deep analysis
  // ============================================================================

  async regenerateMemoryMd(): Promise<void> {
    try {
      const db = this.getDb();

      const decisions = db
        .prepare(
          `SELECT text, created_at FROM memories WHERE category = 'decision'
           ORDER BY created_at DESC LIMIT 10`,
        )
        .all() as Array<{ text: string; created_at: number }>;

      const preferences = db
        .prepare(
          `SELECT text FROM memories WHERE category = 'preference'
           ORDER BY importance DESC, created_at DESC LIMIT 10`,
        )
        .all() as Array<{ text: string }>;

      const projects = db
        .prepare(
          `SELECT DISTINCT text FROM memories WHERE category = 'project'
           ORDER BY created_at DESC LIMIT 10`,
        )
        .all() as Array<{ text: string }>;

      const entities = db
        .prepare(
          `SELECT text FROM memories WHERE category = 'entity'
           ORDER BY importance DESC LIMIT 10`,
        )
        .all() as Array<{ text: string }>;

      const todos = db
        .prepare(
          `SELECT text FROM memories WHERE category = 'todo'
           ORDER BY created_at DESC LIMIT 5`,
        )
        .all() as Array<{ text: string }>;

      const date = new Date().toISOString().slice(0, 10);
      const lines: string[] = [
        `# Marcel Memory -- Librarian`,
        `_Last updated: ${date} -- auto-generated from DB, do not edit manually_`,
        "",
      ];

      if (projects.length) {
        lines.push("## Active Projects");
        for (const r of projects) {
          lines.push(`- ${r.text}`);
        }
        lines.push("");
      }
      if (preferences.length) {
        lines.push("## Marco's Preferences");
        for (const r of preferences) {
          lines.push(`- ${r.text}`);
        }
        lines.push("");
      }
      if (decisions.length) {
        lines.push("## Recent Decisions");
        for (const r of decisions) {
          const d = new Date(r.created_at).toISOString().slice(0, 10);
          lines.push(`- [${d}] ${r.text}`);
        }
        lines.push("");
      }
      if (entities.length) {
        lines.push("## Known Entities");
        for (const r of entities) {
          lines.push(`- ${r.text}`);
        }
        lines.push("");
      }
      if (todos.length) {
        lines.push("## Open TODOs");
        for (const r of todos) {
          lines.push(`- ${r.text}`);
        }
        lines.push("");
      }

      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.memoryMdPath, lines.join("\n"), "utf-8");
    } catch {
      // non-fatal
    }
  }
}
