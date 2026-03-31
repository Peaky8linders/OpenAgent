/**
 * PostgreSQL schema migrations for LCM v2.
 *
 * Key features vs SQLite:
 * - pgvector extension for native ANN similarity search (HNSW index)
 * - tsvector column + GIN index for native full-text search
 * - pgcrypto for encryption helpers
 * - Row-level security (RLS) prep for multi-tenant isolation
 * - Connection pooling compatible (no single-writer bottleneck)
 */

export interface PgMigration {
  version: number;
  description: string;
  up: string;
  down: string;
}

export const PG_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    description: 'Extensions and core tables',
    up: `
      -- Extensions
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE EXTENSION IF NOT EXISTS "vector";
      CREATE EXTENSION IF NOT EXISTS "pg_trgm";

      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Messages: immutable store
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pii_annotations JSONB DEFAULT '[]'::jsonb,
        pii_detected BOOLEAN NOT NULL DEFAULT FALSE,
        topic_id TEXT,
        topic_label TEXT,
        compressed_content TEXT,
        compressed_token_count INTEGER,
        metadata JSONB,
        -- Native tsvector column for FTS (auto-updated via trigger)
        content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
      CREATE INDEX idx_messages_topic ON messages(topic_id) WHERE topic_id IS NOT NULL;
      CREATE INDEX idx_messages_pii ON messages(conversation_id) WHERE pii_detected = TRUE;
      CREATE INDEX idx_messages_fts ON messages USING GIN(content_tsv);
      -- Trigram index for LIKE/regex fallback search
      CREATE INDEX idx_messages_trgm ON messages USING GIN(content gin_trgm_ops);

      -- Summaries: DAG nodes
      CREATE TABLE IF NOT EXISTS summaries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('leaf','condensed')),
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        quality_score REAL,
        quality_method TEXT,
        flagged_for_resummary BOOLEAN NOT NULL DEFAULT FALSE,
        earliest_at TIMESTAMPTZ NOT NULL,
        latest_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB,
        content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      );
      CREATE INDEX idx_summaries_conversation ON summaries(conversation_id, depth);
      CREATE INDEX idx_summaries_fts ON summaries USING GIN(content_tsv);
      CREATE INDEX idx_summaries_flagged ON summaries(conversation_id) WHERE flagged_for_resummary = TRUE;

      -- DAG links: summary → source messages
      CREATE TABLE IF NOT EXISTS summary_messages (
        summary_id UUID NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY (summary_id, message_id)
      );

      -- DAG links: condensed → parent summaries
      CREATE TABLE IF NOT EXISTS summary_parents (
        child_id UUID NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        parent_id UUID NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (child_id, parent_id)
      );

      -- Context items: what the model sees per turn
      CREATE TABLE IF NOT EXISTS context_items (
        conversation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN ('message','summary')),
        item_id UUID NOT NULL,
        PRIMARY KEY (conversation_id, ordinal)
      );
    `,
    down: `
      DROP TABLE IF EXISTS context_items CASCADE;
      DROP TABLE IF EXISTS summary_parents CASCADE;
      DROP TABLE IF EXISTS summary_messages CASCADE;
      DROP TABLE IF EXISTS summaries CASCADE;
      DROP TABLE IF EXISTS messages CASCADE;
      DROP TABLE IF EXISTS schema_version CASCADE;
    `,
  },
  {
    version: 2,
    description: 'Audit, retention, scopes',
    up: `
      -- Append-only audit log
      CREATE TABLE IF NOT EXISTS audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        conversation_id TEXT,
        metadata JSONB
      );
      CREATE INDEX idx_audit_time ON audit_log(timestamp DESC);
      CREATE INDEX idx_audit_conversation ON audit_log(conversation_id, timestamp DESC);

      -- Retention policies
      CREATE TABLE IF NOT EXISTS retention_policies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id TEXT UNIQUE,
        max_age_days INTEGER,
        max_messages INTEGER,
        pii_max_age_days INTEGER,
        auto_delete BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Memory scopes for RBAC
      CREATE TABLE IF NOT EXISTS memory_scopes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_scope_id TEXT REFERENCES memory_scopes(id),
        permissions JSONB NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS memory_scopes CASCADE;
      DROP TABLE IF EXISTS retention_policies CASCADE;
      DROP TABLE IF EXISTS audit_log CASCADE;
    `,
  },
  {
    version: 3,
    description: 'Embeddings with pgvector HNSW index',
    up: `
      CREATE TABLE IF NOT EXISTS embeddings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('message','summary','file')),
        entity_id UUID NOT NULL,
        vector vector(384) NOT NULL,  -- 384 = all-MiniLM-L6-v2 dimensionality
        model TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (entity_type, entity_id)
      );
      -- HNSW index for fast approximate nearest neighbor search
      -- cosine distance operator: <=>
      CREATE INDEX idx_embeddings_hnsw ON embeddings
        USING hnsw (vector vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
      CREATE INDEX idx_embeddings_entity ON embeddings(entity_type, entity_id);
    `,
    down: `DROP TABLE IF EXISTS embeddings CASCADE;`,
  },
  {
    version: 4,
    description: 'Row-level security policies for multi-tenant isolation',
    up: `
      -- Enable RLS on all data tables
      ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
      ALTER TABLE summaries ENABLE ROW LEVEL SECURITY;
      ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

      -- Default permissive policy (app manages tenancy via conversation_id filtering)
      -- Production: replace with scope-based policies using current_setting('app.scope_id')
      CREATE POLICY messages_default ON messages FOR ALL USING (TRUE);
      CREATE POLICY summaries_default ON summaries FOR ALL USING (TRUE);
      CREATE POLICY embeddings_default ON embeddings FOR ALL USING (TRUE);
      CREATE POLICY audit_default ON audit_log FOR ALL USING (TRUE);
    `,
    down: `
      DROP POLICY IF EXISTS messages_default ON messages;
      DROP POLICY IF EXISTS summaries_default ON summaries;
      DROP POLICY IF EXISTS embeddings_default ON embeddings;
      DROP POLICY IF EXISTS audit_default ON audit_log;
      ALTER TABLE messages DISABLE ROW LEVEL SECURITY;
      ALTER TABLE summaries DISABLE ROW LEVEL SECURITY;
      ALTER TABLE embeddings DISABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;
    `,
  },
];
