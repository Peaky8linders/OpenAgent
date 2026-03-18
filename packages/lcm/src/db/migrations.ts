/**
 * Schema migrations for LCM v2 SQLite store.
 * Each migration has an up() and a rollback description.
 * Migrations run in order; the current version is tracked in a meta table.
 */

export interface Migration {
  version: number;
  description: string;
  up: string; // SQL to apply
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: messages, summaries, DAG links, context items',
    up: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        pii_annotations TEXT, -- JSON array of PiiAnnotation
        pii_detected INTEGER NOT NULL DEFAULT 0,
        topic_id TEXT,
        topic_label TEXT,
        compressed_content TEXT,
        compressed_token_count INTEGER,
        metadata TEXT -- JSON
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        quality_score REAL,
        quality_method TEXT,
        flagged_for_resummary INTEGER NOT NULL DEFAULT 0,
        earliest_at TEXT NOT NULL,
        latest_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT -- JSON
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON summaries(conversation_id, depth);

      CREATE TABLE IF NOT EXISTS summary_messages (
        summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY (summary_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS summary_parents (
        child_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        parent_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (child_id, parent_id)
      );

      CREATE TABLE IF NOT EXISTS context_items (
        conversation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
        item_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, ordinal)
      );
    `,
  },
  {
    version: 2,
    description: 'Audit log, retention policies, memory scopes',
    up: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        conversation_id TEXT,
        metadata TEXT -- JSON
      );
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_conversation ON audit_log(conversation_id);

      CREATE TABLE IF NOT EXISTS retention_policies (
        id TEXT PRIMARY KEY,
        conversation_id TEXT UNIQUE, -- NULL = global
        max_age_days INTEGER,
        max_messages INTEGER,
        pii_max_age_days INTEGER,
        auto_delete INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_scopes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_scope_id TEXT REFERENCES memory_scopes(id),
        permissions TEXT NOT NULL -- JSON: ScopePermissions
      );
    `,
  },
  {
    version: 3,
    description: 'Embeddings table for vector similarity search',
    up: `
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('message', 'summary', 'file')),
        entity_id TEXT NOT NULL,
        vector BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_type, entity_id);
    `,
  },
];

export function getCurrentVersion(db: { exec: (sql: string) => void; prepare: (sql: string) => { all: () => Array<{ version: number }> } }): number {
  try {
    const rows = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').all();
    return rows.length > 0 ? rows[0].version : 0;
  } catch {
    return 0;
  }
}

export function applyMigrations(db: {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void; all: () => Array<{ version: number }> };
}): number {
  const current = getCurrentVersion(db);
  let applied = 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec(migration.up);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
    applied++;
  }

  return applied;
}
