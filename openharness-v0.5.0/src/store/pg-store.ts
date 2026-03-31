/**
 * PgStore — LcmStore implementation for PostgreSQL with pgvector.
 *
 * Production features:
 * - Connection pooling via pg.Pool
 * - Native tsvector FTS with ts_rank scoring
 * - pgvector HNSW index for O(log n) ANN similarity search
 * - Parameterized queries everywhere (zero string interpolation)
 * - Transactional deletes with proper cascade
 * - NOTIFY for async compaction triggers
 *
 * Requires: pg, pgvector extension on the database
 * Install: npm install pg @types/pg
 */

// Type-only import so this file compiles without pg installed.
// At runtime, pg must be available or createStore() should not select 'postgres'.
import type { Pool, PoolConfig, PoolClient, QueryResult } from 'pg';
import { randomUUID } from 'node:crypto';
import type { LcmStore, TimeRange } from './lcm-store.js';
import type {
  EnrichedMessage, MessageId, SummaryNode, SummaryId,
  SummaryMessageLink, SummaryParentLink, ConversationId,
  ContextItem, AuditEntry, AuditAction, RetentionPolicy,
  MemoryScope, ScopeId, EmbeddingRecord, SimilarityResult,
  SearchQuery, SearchResult, HealthStatus, DeletionReport,
} from '../types/index.js';
import { PG_MIGRATIONS } from '../db/pg-migrations.js';

export interface PgStoreOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  maxConnections?: number;
  /** pgvector embedding dimensions (default 384 for all-MiniLM-L6-v2) */
  embeddingDimensions?: number;
}

export class PgStore implements LcmStore {
  private pool!: Pool;
  private opts: PgStoreOptions;
  private dims: number;

  constructor(opts: PgStoreOptions) {
    this.opts = opts;
    this.dims = opts.embeddingDimensions ?? 384;
  }

  // ─── Lifecycle ──────────────────────────────────────────

  async initialize(): Promise<void> {
    // Dynamic import so compilation doesn't fail without pg
    const pg = await import('pg');
    const poolConfig: PoolConfig = {
      connectionString: this.opts.connectionString,
      host: this.opts.host,
      port: this.opts.port,
      database: this.opts.database,
      user: this.opts.user,
      password: this.opts.password,
      ssl: this.opts.ssl ? { rejectUnauthorized: true } : undefined,
      max: this.opts.maxConnections ?? 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
    this.pool = new pg.default.Pool(poolConfig);
    await this.runMigrations();
  }

  private async runMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Ensure schema_version exists for first run
      await client.query(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      const { rows } = await client.query('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
      const current = rows.length > 0 ? rows[0].version : 0;
      for (const m of PG_MIGRATIONS) {
        if (m.version <= current) continue;
        await client.query('BEGIN');
        await client.query(m.up);
        await client.query('INSERT INTO schema_version (version) VALUES ($1)', [m.version]);
        await client.query('COMMIT');
      }
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async healthCheck(): Promise<HealthStatus> {
    const errors: string[] = [];
    let dbSizeBytes = 0, messageCount = 0, summaryCount = 0;
    try {
      const sz = await this.pool.query("SELECT pg_database_size(current_database()) as size");
      dbSizeBytes = sz.rows[0]?.size ?? 0;
    } catch (e) { errors.push(`DB size: ${e}`); }
    try {
      const mc = await this.pool.query('SELECT COUNT(*)::int as cnt FROM messages');
      messageCount = mc.rows[0]?.cnt ?? 0;
    } catch (e) { errors.push(`Messages: ${e}`); }
    try {
      const sc = await this.pool.query('SELECT COUNT(*)::int as cnt FROM summaries');
      summaryCount = sc.rows[0]?.cnt ?? 0;
    } catch (e) { errors.push(`Summaries: ${e}`); }
    return { ok: errors.length === 0, dbSizeBytes, messageCount, summaryCount, walSizeBytes: null, errors };
  }

  async backup(destinationPath: string): Promise<void> {
    // pg_dump is the canonical approach; not available via SQL.
    // For programmatic backup, use COPY or pg_dump externally.
    throw new Error('PostgreSQL backup requires pg_dump. Use: pg_dump $DATABASE_URL > ' + destinationPath);
  }

  // ─── Messages ───────────────────────────────────────────

  async persistMessage(msg: EnrichedMessage): Promise<MessageId> {
    await this.pool.query(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at,
        pii_annotations, pii_detected, topic_id, topic_label,
        compressed_content, compressed_token_count, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [msg.id, msg.conversationId, msg.role, msg.content, msg.tokenCount, msg.createdAt,
       JSON.stringify(msg.pii), msg.pii.length > 0, msg.topicId, msg.topicLabel,
       msg.compressedContent, msg.compressedTokenCount,
       msg.metadata ? JSON.stringify(msg.metadata) : null]);
    return msg.id;
  }

  async getMessage(id: MessageId): Promise<EnrichedMessage | null> {
    const { rows } = await this.pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    return rows.length === 0 ? null : this.rowToMessage(rows[0]);
  }

  async getMessagesByConversation(cid: ConversationId, range?: TimeRange): Promise<EnrichedMessage[]> {
    let sql = 'SELECT * FROM messages WHERE conversation_id = $1';
    const params: unknown[] = [cid];
    let idx = 2;
    if (range?.since) { sql += ` AND created_at >= $${idx++}`; params.push(range.since); }
    if (range?.before) { sql += ` AND created_at <= $${idx++}`; params.push(range.before); }
    sql += ' ORDER BY created_at ASC';
    const { rows } = await this.pool.query(sql, params);
    return rows.map(r => this.rowToMessage(r));
  }

  async searchMessages(query: SearchQuery): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    if (query.scope === 'messages' || query.scope === 'both') {
      if (query.mode === 'fts') {
        // Native PostgreSQL tsvector full-text search with ts_rank
        let sql = `SELECT id, content, ts_rank(content_tsv, plainto_tsquery('english', $1)) as rank
          FROM messages WHERE content_tsv @@ plainto_tsquery('english', $1)`;
        const params: unknown[] = [query.pattern];
        let idx = 2;
        if (query.conversationId) { sql += ` AND conversation_id = $${idx++}`; params.push(query.conversationId); }
        sql += ` ORDER BY rank DESC LIMIT $${idx++}`; params.push(query.limit);
        const { rows } = await this.pool.query(sql, params);
        for (const r of rows) {
          results.push({ entityType: 'message', entityId: r.id, content: r.content, rank: r.rank });
        }
      } else {
        // regex/LIKE mode with pg_trgm for performance
        let sql = 'SELECT id, content FROM messages WHERE content ILIKE $1';
        const params: unknown[] = [`%${this.escapeLike(query.pattern)}%`];
        let idx = 2;
        if (query.conversationId) { sql += ` AND conversation_id = $${idx++}`; params.push(query.conversationId); }
        sql += ` ORDER BY created_at DESC LIMIT $${idx++}`; params.push(query.limit);
        const { rows } = await this.pool.query(sql, params);
        for (const r of rows) {
          results.push({ entityType: 'message', entityId: r.id, content: r.content, rank: 0 });
        }
      }
    }

    if (query.scope === 'summaries' || query.scope === 'both') {
      if (query.mode === 'fts') {
        let sql = `SELECT id, content, ts_rank(content_tsv, plainto_tsquery('english', $1)) as rank
          FROM summaries WHERE content_tsv @@ plainto_tsquery('english', $1)`;
        const params: unknown[] = [query.pattern];
        let idx = 2;
        if (query.conversationId) { sql += ` AND conversation_id = $${idx++}`; params.push(query.conversationId); }
        sql += ` ORDER BY rank DESC LIMIT $${idx++}`; params.push(query.limit);
        const { rows } = await this.pool.query(sql, params);
        for (const r of rows) {
          results.push({ entityType: 'summary', entityId: r.id, content: r.content, rank: r.rank });
        }
      } else {
        let sql = 'SELECT id, content FROM summaries WHERE content ILIKE $1';
        const params: unknown[] = [`%${this.escapeLike(query.pattern)}%`];
        let idx = 2;
        if (query.conversationId) { sql += ` AND conversation_id = $${idx++}`; params.push(query.conversationId); }
        sql += ` LIMIT $${idx++}`; params.push(query.limit);
        const { rows } = await this.pool.query(sql, params);
        for (const r of rows) {
          results.push({ entityType: 'summary', entityId: r.id, content: r.content, rank: 0 });
        }
      }
    }
    return results.slice(0, query.limit);
  }

  async deleteMessages(ids: MessageId[]): Promise<DeletionReport> {
    if (ids.length === 0) return { messagesDeleted: 0, summariesInvalidated: 0, summariesRegenerated: 0, embeddingsRemoved: 0, auditEntriesCreated: 0 };
    const client = await this.pool.connect();
    let messagesDeleted = 0, summariesInvalidated = 0, embeddingsRemoved = 0;
    try {
      await client.query('BEGIN');
      // Flag linked summaries
      const linked = await client.query(
        'UPDATE summaries SET flagged_for_resummary = TRUE WHERE id IN (SELECT summary_id FROM summary_messages WHERE message_id = ANY($1)) RETURNING id', [ids]);
      summariesInvalidated = linked.rowCount ?? 0;
      // Delete embeddings
      const embDel = await client.query("DELETE FROM embeddings WHERE entity_type = 'message' AND entity_id = ANY($1)", [ids]);
      embeddingsRemoved = embDel.rowCount ?? 0;
      // Delete messages (CASCADE handles summary_messages)
      const msgDel = await client.query('DELETE FROM messages WHERE id = ANY($1)', [ids]);
      messagesDeleted = msgDel.rowCount ?? 0;
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    return { messagesDeleted, summariesInvalidated, summariesRegenerated: 0, embeddingsRemoved, auditEntriesCreated: 0 };
  }

  // ─── Summaries ──────────────────────────────────────────

  async createSummary(s: SummaryNode): Promise<SummaryId> {
    await this.pool.query(`INSERT INTO summaries (id,conversation_id,kind,depth,content,token_count,
      quality_score,quality_method,flagged_for_resummary,earliest_at,latest_at,created_at,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [s.id, s.conversationId, s.kind, s.depth, s.content, s.tokenCount,
       s.qualityScore, s.qualityMethod, s.flaggedForResummary,
       s.earliestAt, s.latestAt, s.createdAt, s.metadata ? JSON.stringify(s.metadata) : null]);
    return s.id;
  }

  async getSummary(id: SummaryId): Promise<SummaryNode | null> {
    const { rows } = await this.pool.query('SELECT * FROM summaries WHERE id = $1', [id]);
    return rows.length === 0 ? null : this.rowToSummary(rows[0]);
  }

  async getSummariesByConversation(cid: ConversationId): Promise<SummaryNode[]> {
    const { rows } = await this.pool.query('SELECT * FROM summaries WHERE conversation_id = $1 ORDER BY depth, created_at', [cid]);
    return rows.map(r => this.rowToSummary(r));
  }

  async linkSummaryToMessages(links: SummaryMessageLink[]): Promise<void> {
    if (links.length === 0) return;
    const values = links.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
    const params = links.flatMap(l => [l.summaryId, l.messageId]);
    await this.pool.query(`INSERT INTO summary_messages (summary_id, message_id) VALUES ${values} ON CONFLICT DO NOTHING`, params);
  }

  async linkSummaryToParents(links: SummaryParentLink[]): Promise<void> {
    if (links.length === 0) return;
    const values = links.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
    const params = links.flatMap(l => [l.childId, l.parentId, l.ordinal]);
    await this.pool.query(`INSERT INTO summary_parents (child_id, parent_id, ordinal) VALUES ${values} ON CONFLICT DO NOTHING`, params);
  }

  async getChildSummaries(id: SummaryId): Promise<SummaryNode[]> {
    const { rows } = await this.pool.query(
      'SELECT s.* FROM summaries s JOIN summary_parents sp ON sp.child_id = s.id WHERE sp.parent_id = $1 ORDER BY sp.ordinal', [id]);
    return rows.map(r => this.rowToSummary(r));
  }

  async getParentSummaries(id: SummaryId): Promise<SummaryNode[]> {
    const { rows } = await this.pool.query(
      'SELECT s.* FROM summaries s JOIN summary_parents sp ON sp.parent_id = s.id WHERE sp.child_id = $1 ORDER BY sp.ordinal', [id]);
    return rows.map(r => this.rowToSummary(r));
  }

  async getSourceMessages(sid: SummaryId): Promise<EnrichedMessage[]> {
    const { rows } = await this.pool.query(
      'SELECT m.* FROM messages m JOIN summary_messages sm ON sm.message_id = m.id WHERE sm.summary_id = $1 ORDER BY m.created_at', [sid]);
    return rows.map(r => this.rowToMessage(r));
  }

  async updateSummaryQuality(id: SummaryId, score: number, method: string): Promise<void> {
    await this.pool.query('UPDATE summaries SET quality_score = $1, quality_method = $2 WHERE id = $3', [score, method, id]);
  }

  async flagForResummary(id: SummaryId): Promise<void> {
    await this.pool.query('UPDATE summaries SET flagged_for_resummary = TRUE WHERE id = $1', [id]);
  }

  async deleteSummary(id: SummaryId): Promise<void> {
    await this.pool.query('DELETE FROM summaries WHERE id = $1', [id]);
  }

  // ─── Context Items ──────────────────────────────────────

  async getContextItems(cid: ConversationId): Promise<ContextItem[]> {
    const { rows } = await this.pool.query('SELECT * FROM context_items WHERE conversation_id = $1 ORDER BY ordinal', [cid]);
    return rows.map(r => ({
      conversationId: r.conversation_id, ordinal: r.ordinal,
      itemType: r.item_type as 'message' | 'summary', itemId: r.item_id,
    }));
  }

  async updateContextItems(cid: ConversationId, items: ContextItem[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM context_items WHERE conversation_id = $1', [cid]);
      if (items.length > 0) {
        const values = items.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`).join(',');
        const params = items.flatMap(it => [cid, it.ordinal, it.itemType, it.itemId]);
        await client.query(`INSERT INTO context_items (conversation_id,ordinal,item_type,item_id) VALUES ${values}`, params);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  // ─── Audit ──────────────────────────────────────────────

  async appendAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    await this.pool.query(`INSERT INTO audit_log (actor,action,target_type,target_id,conversation_id,metadata)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.actor, entry.action, entry.targetType, entry.targetId,
       entry.conversationId, entry.metadata ? JSON.stringify(entry.metadata) : null]);
  }

  async queryAudit(opts: { conversationId?: string; action?: AuditAction; since?: string; before?: string; limit?: number }): Promise<AuditEntry[]> {
    let sql = 'SELECT * FROM audit_log WHERE TRUE';
    const params: unknown[] = [];
    let idx = 1;
    if (opts.conversationId) { sql += ` AND conversation_id = $${idx++}`; params.push(opts.conversationId); }
    if (opts.action) { sql += ` AND action = $${idx++}`; params.push(opts.action); }
    if (opts.since) { sql += ` AND timestamp >= $${idx++}`; params.push(opts.since); }
    if (opts.before) { sql += ` AND timestamp <= $${idx++}`; params.push(opts.before); }
    sql += ` ORDER BY timestamp DESC LIMIT $${idx++}`; params.push(opts.limit ?? 100);
    const { rows } = await this.pool.query(sql, params);
    return rows.map(r => ({
      id: r.id, timestamp: r.timestamp.toISOString(), actor: r.actor,
      action: r.action as AuditAction, targetType: r.target_type,
      targetId: r.target_id, conversationId: r.conversation_id,
      metadata: r.metadata,
    }));
  }

  // ─── Retention ──────────────────────────────────────────

  async upsertRetentionPolicy(p: RetentionPolicy): Promise<void> {
    await this.pool.query(`INSERT INTO retention_policies (id,conversation_id,max_age_days,max_messages,pii_max_age_days,auto_delete,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET
      max_age_days=EXCLUDED.max_age_days, max_messages=EXCLUDED.max_messages,
      pii_max_age_days=EXCLUDED.pii_max_age_days, auto_delete=EXCLUDED.auto_delete, updated_at=EXCLUDED.updated_at`,
      [p.id, p.conversationId, p.maxAgeDays, p.maxMessages, p.piiMaxAgeDays, p.autoDelete, p.createdAt, p.updatedAt]);
  }

  async getRetentionPolicy(cid: ConversationId | null): Promise<RetentionPolicy | null> {
    const { rows } = cid
      ? await this.pool.query('SELECT * FROM retention_policies WHERE conversation_id = $1', [cid])
      : await this.pool.query('SELECT * FROM retention_policies WHERE conversation_id IS NULL');
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id, conversationId: r.conversation_id, maxAgeDays: r.max_age_days,
      maxMessages: r.max_messages, piiMaxAgeDays: r.pii_max_age_days,
      autoDelete: r.auto_delete, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    };
  }

  async enforceRetention(cid: ConversationId): Promise<DeletionReport> {
    const policy = await this.getRetentionPolicy(cid) ?? await this.getRetentionPolicy(null);
    if (!policy) return { messagesDeleted: 0, summariesInvalidated: 0, summariesRegenerated: 0, embeddingsRemoved: 0, auditEntriesCreated: 0 };
    const ids: string[] = [];
    if (policy.maxAgeDays !== null) {
      const { rows } = await this.pool.query(
        'SELECT id FROM messages WHERE conversation_id = $1 AND created_at < NOW() - make_interval(days => $2::int)',
        [cid, policy.maxAgeDays]);
      ids.push(...rows.map(r => r.id));
    }
    if (policy.maxMessages !== null) {
      const { rows } = await this.pool.query(
        'SELECT id FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT GREATEST(0, (SELECT COUNT(*) FROM messages WHERE conversation_id = $1) - $2)',
        [cid, policy.maxMessages]);
      ids.push(...rows.map(r => r.id));
    }
    if (policy.piiMaxAgeDays !== null) {
      const { rows } = await this.pool.query(
        'SELECT id FROM messages WHERE conversation_id = $1 AND pii_detected = TRUE AND created_at < NOW() - make_interval(days => $2::int)',
        [cid, policy.piiMaxAgeDays]);
      ids.push(...rows.map(r => r.id));
    }
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { messagesDeleted: 0, summariesInvalidated: 0, summariesRegenerated: 0, embeddingsRemoved: 0, auditEntriesCreated: 0 };
    const report = await this.deleteMessages(unique);
    await this.appendAudit({ actor: 'system', action: 'retention_enforced', targetType: 'conversation', targetId: cid, conversationId: cid, metadata: { policy: policy.id, deleted: report.messagesDeleted } });
    return report;
  }

  // ─── Memory Scopes ──────────────────────────────────────

  async createScope(s: MemoryScope): Promise<ScopeId> {
    await this.pool.query('INSERT INTO memory_scopes (id,name,parent_scope_id,permissions) VALUES ($1,$2,$3,$4)',
      [s.id, s.name, s.parentScopeId, JSON.stringify(s.permissions)]);
    return s.id;
  }

  async getScope(id: ScopeId): Promise<MemoryScope | null> {
    const { rows } = await this.pool.query('SELECT * FROM memory_scopes WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, name: r.name, parentScopeId: r.parent_scope_id, permissions: r.permissions };
  }

  async checkPermission(scopeId: ScopeId, action: 'read' | 'write' | 'search' | 'expand', targetScopeId: ScopeId): Promise<boolean> {
    const scope = await this.getScope(targetScopeId);
    if (!scope) return false;
    return scope.permissions[action]?.includes(scopeId) || scope.permissions[action]?.includes('*');
  }

  // ─── Embeddings (pgvector) ──────────────────────────────

  async upsertEmbedding(rec: EmbeddingRecord): Promise<void> {
    const vecStr = `[${Array.from(rec.vector).join(',')}]`;
    await this.pool.query(`INSERT INTO embeddings (id,entity_type,entity_id,vector,model,created_at)
      VALUES ($1,$2,$3,$4::vector,$5,$6) ON CONFLICT (entity_type,entity_id) DO UPDATE SET vector=EXCLUDED.vector, model=EXCLUDED.model`,
      [rec.id, rec.entityType, rec.entityId, vecStr, rec.model, rec.createdAt]);
  }

  async getEmbedding(entityId: string): Promise<EmbeddingRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM embeddings WHERE entity_id = $1', [entityId]);
    if (rows.length === 0) return null;
    const r = rows[0];
    // pgvector returns string like "[0.1,0.2,...]"
    const vec = new Float64Array(JSON.parse(r.vector.replace(/^\[/, '[').replace(/\]$/, ']')));
    return { id: r.id, entityType: r.entity_type, entityId: r.entity_id, vector: vec, model: r.model, createdAt: r.created_at.toISOString() };
  }

  async similaritySearch(vector: Float64Array, k: number, filter?: { entityType?: string; conversationId?: string }): Promise<SimilarityResult[]> {
    const vecStr = `[${Array.from(vector).join(',')}]`;
    let sql: string;
    const params: unknown[] = [vecStr];
    let idx = 2;

    if (filter?.conversationId) {
      // Join to messages/summaries to filter by conversation
      sql = `SELECT e.entity_type, e.entity_id, 1 - (e.vector <=> $1::vector) as score
        FROM embeddings e
        JOIN (
          SELECT id, conversation_id FROM messages
          UNION ALL
          SELECT id, conversation_id FROM summaries
        ) src ON src.id = e.entity_id
        WHERE src.conversation_id = $${idx++}`;
      params.push(filter.conversationId);
      if (filter.entityType) { sql += ` AND e.entity_type = $${idx++}`; params.push(filter.entityType); }
    } else {
      sql = `SELECT entity_type, entity_id, 1 - (vector <=> $1::vector) as score FROM embeddings WHERE TRUE`;
      if (filter?.entityType) { sql += ` AND entity_type = $${idx++}`; params.push(filter.entityType); }
    }

    sql += ` ORDER BY vector <=> $1::vector LIMIT $${idx++}`; params.push(k);
    const { rows } = await this.pool.query(sql, params);
    return rows.map(r => ({ entityType: r.entity_type, entityId: r.entity_id, score: parseFloat(r.score) }));
  }

  // ─── Private ────────────────────────────────────────────

  private rowToMessage(r: Record<string, unknown>): EnrichedMessage {
    return {
      id: r.id as string, conversationId: r.conversation_id as string,
      role: r.role as EnrichedMessage['role'], content: r.content as string,
      tokenCount: r.token_count as number, createdAt: (r.created_at as Date).toISOString(),
      pii: (r.pii_annotations as unknown[]) ?? [],
      topicId: r.topic_id as string | null, topicLabel: r.topic_label as string | null,
      compressedContent: r.compressed_content as string | null,
      compressedTokenCount: r.compressed_token_count as number | null,
      metadata: r.metadata as Record<string, unknown> | undefined,
    } as EnrichedMessage;
  }

  private rowToSummary(r: Record<string, unknown>): SummaryNode {
    return {
      id: r.id as string, conversationId: r.conversation_id as string,
      kind: r.kind as SummaryNode['kind'], depth: r.depth as number,
      content: r.content as string, tokenCount: r.token_count as number,
      qualityScore: r.quality_score as number | null, qualityMethod: r.quality_method as string | null,
      flaggedForResummary: r.flagged_for_resummary as boolean,
      earliestAt: (r.earliest_at as Date).toISOString(), latestAt: (r.latest_at as Date).toISOString(),
      createdAt: (r.created_at as Date).toISOString(), metadata: r.metadata as Record<string, unknown> | undefined,
    };
  }

  private escapeLike(input: string): string {
    return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }
}
