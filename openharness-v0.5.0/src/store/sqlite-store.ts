/**
 * SqliteStore — LcmStore implementation using Node 22 built-in node:sqlite.
 *
 * Wraps synchronous DatabaseSync calls in Promises for interface compat.
 * Uses WAL mode, busy timeout, and foreign keys.
 * All review bugs (C1-C3, I1-I4) are fixed in this version.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { cosineSimilarity } from '../util/math.js';
import { applyMigrations } from '../db/migrations.js';
import type { LcmStore, TimeRange } from './lcm-store.js';
import type {
  EnrichedMessage, MessageId, SummaryNode, SummaryId,
  SummaryMessageLink, SummaryParentLink, ConversationId,
  ContextItem, AuditEntry, AuditAction, RetentionPolicy,
  MemoryScope, ScopeId, EmbeddingRecord, SimilarityResult,
  SearchQuery, SearchResult, HealthStatus, DeletionReport,
} from '../types/index.js';

export interface SqliteStoreOptions {
  path: string; // ':memory:' for tests
}

type SqlParam = string | number | null | Buffer;

export class SqliteStore implements LcmStore {
  private db: DatabaseSync;

  constructor(opts: SqliteStoreOptions) {
    this.db = new DatabaseSync(opts.path);
  }

  // ─── Lifecycle ──────────────────────────────────────────

  async initialize(): Promise<void> {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = NORMAL');
    applyMigrations(this.db as never);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async healthCheck(): Promise<HealthStatus> {
    const errors: string[] = [];
    let dbSizeBytes = 0, messageCount = 0, summaryCount = 0;
    try {
      const pc = this.q<{ page_count: number }>('PRAGMA page_count');
      const ps = this.q<{ page_size: number }>('PRAGMA page_size');
      dbSizeBytes = (pc[0]?.page_count ?? 0) * (ps[0]?.page_size ?? 0);
    } catch (e) { errors.push(`DB size: ${e}`); }
    try { messageCount = this.q<{ cnt: number }>('SELECT COUNT(*) as cnt FROM messages')[0]?.cnt ?? 0; }
    catch (e) { errors.push(`Messages: ${e}`); }
    try { summaryCount = this.q<{ cnt: number }>('SELECT COUNT(*) as cnt FROM summaries')[0]?.cnt ?? 0; }
    catch (e) { errors.push(`Summaries: ${e}`); }
    return { ok: errors.length === 0, dbSizeBytes, messageCount, summaryCount, walSizeBytes: null, errors };
  }

  async backup(destinationPath: string): Promise<void> {
    // Reject traversal sequences and characters that could escape the VACUUM INTO SQL context
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(destinationPath) || destinationPath.includes('..') || destinationPath.includes("'")) {
      throw new Error('Invalid backup path');
    }
    this.db.exec(`VACUUM INTO '${destinationPath}'`);
  }

  // ─── Messages ───────────────────────────────────────────

  async persistMessage(msg: EnrichedMessage): Promise<MessageId> {
    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at,
        pii_annotations, pii_detected, topic_id, topic_label,
        compressed_content, compressed_token_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id, msg.conversationId, msg.role, msg.content, msg.tokenCount, msg.createdAt,
      JSON.stringify(msg.pii), msg.pii.length > 0 ? 1 : 0,
      msg.topicId, msg.topicLabel, msg.compressedContent, msg.compressedTokenCount,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
    );
    try {
      this.db.prepare(
        'INSERT INTO messages_fts (rowid, content) VALUES ((SELECT rowid FROM messages WHERE id = ?), ?)'
      ).run(msg.id, msg.content);
    } catch { /* FTS insert non-fatal */ }
    return msg.id;
  }

  async getMessage(id: MessageId): Promise<EnrichedMessage | null> {
    const rows = this.q<Record<string, unknown>>('SELECT * FROM messages WHERE id = ?', id);
    return rows.length === 0 ? null : this.rowToMessage(rows[0]);
  }

  async getMessagesByConversation(conversationId: ConversationId, range?: TimeRange): Promise<EnrichedMessage[]> {
    let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
    const params: SqlParam[] = [conversationId];
    if (range?.since) { sql += ' AND created_at >= ?'; params.push(range.since); }
    if (range?.before) { sql += ' AND created_at <= ?'; params.push(range.before); }
    sql += ' ORDER BY created_at ASC';
    return this.q<Record<string, unknown>>(sql, ...params).map(r => this.rowToMessage(r));
  }

  async searchMessages(query: SearchQuery): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    if (query.scope === 'messages' || query.scope === 'both') {
      if (query.mode === 'fts') {
        const ftsQuery = this.sanitizeFts(query.pattern);
        let sql = `SELECT m.id, m.content, rank FROM messages_fts fts
          JOIN messages m ON m.rowid = fts.rowid WHERE messages_fts MATCH ?`;
        const params: SqlParam[] = [ftsQuery];
        if (query.conversationId) { sql += ' AND m.conversation_id = ?'; params.push(query.conversationId); }
        sql += ' ORDER BY rank LIMIT ?'; params.push(query.limit);
        try {
          for (const r of this.q<Record<string, unknown>>(sql, ...params)) {
            results.push({ entityType: 'message', entityId: r.id as string, content: r.content as string, rank: r.rank as number });
          }
        } catch { /* FTS parse error */ }
      } else {
        // regex mode: LIKE fallback with escaped wildcards
        const escaped = this.escapeLike(query.pattern);
        let sql = `SELECT id, content FROM messages WHERE content LIKE ? ESCAPE '\\'`;
        const params: SqlParam[] = [`%${escaped}%`];
        if (query.conversationId) { sql += ' AND conversation_id = ?'; params.push(query.conversationId); }
        sql += ' ORDER BY created_at DESC LIMIT ?'; params.push(query.limit);
        for (const r of this.q<Record<string, unknown>>(sql, ...params)) {
          results.push({ entityType: 'message', entityId: r.id as string, content: r.content as string, rank: 0 });
        }
      }
    }

    if (query.scope === 'summaries' || query.scope === 'both') {
      const escaped = this.escapeLike(query.pattern);
      let sql = `SELECT id, content FROM summaries WHERE content LIKE ? ESCAPE '\\'`;
      const params: SqlParam[] = [`%${escaped}%`];
      if (query.conversationId) { sql += ' AND conversation_id = ?'; params.push(query.conversationId); }
      sql += ' LIMIT ?'; params.push(query.limit);
      for (const r of this.q<Record<string, unknown>>(sql, ...params)) {
        results.push({ entityType: 'summary', entityId: r.id as string, content: r.content as string, rank: 0 });
      }
    }
    return results.slice(0, query.limit);
  }

  async deleteMessages(ids: MessageId[]): Promise<DeletionReport> {
    let messagesDeleted = 0, summariesInvalidated = 0, embeddingsRemoved = 0;
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        const linked = this.q<{ summary_id: string }>('SELECT summary_id FROM summary_messages WHERE message_id = ?', id);
        summariesInvalidated += linked.length;
        for (const l of linked) {
          this.db.prepare('UPDATE summaries SET flagged_for_resummary = 1 WHERE id = ?').run(l.summary_id);
        }
        // Capture rowid BEFORE delete (fix C1)
        const rowResult = this.q<{ rowid: number }>('SELECT rowid FROM messages WHERE id = ?', id);
        if (rowResult[0]?.rowid !== undefined) {
          try { this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(rowResult[0].rowid); } catch { /* non-fatal */ }
        }
        // Clean up embeddings (fix I1)
        const ed = this.db.prepare("DELETE FROM embeddings WHERE entity_type = 'message' AND entity_id = ?").run(id);
        embeddingsRemoved += (ed as { changes?: number }).changes ?? 0;
        const dr = this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
        if ((dr as { changes?: number }).changes) messagesDeleted++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { messagesDeleted, summariesInvalidated, summariesRegenerated: 0, embeddingsRemoved, auditEntriesCreated: 0 };
  }

  // ─── Summaries ──────────────────────────────────────────

  async createSummary(s: SummaryNode): Promise<SummaryId> {
    this.db.prepare(`INSERT INTO summaries (id,conversation_id,kind,depth,content,token_count,
      quality_score,quality_method,flagged_for_resummary,earliest_at,latest_at,created_at,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      s.id, s.conversationId, s.kind, s.depth, s.content, s.tokenCount,
      s.qualityScore, s.qualityMethod, s.flaggedForResummary ? 1 : 0,
      s.earliestAt, s.latestAt, s.createdAt, s.metadata ? JSON.stringify(s.metadata) : null);
    return s.id;
  }

  async getSummary(id: SummaryId): Promise<SummaryNode | null> {
    const rows = this.q<Record<string, unknown>>('SELECT * FROM summaries WHERE id = ?', id);
    return rows.length === 0 ? null : this.rowToSummary(rows[0]);
  }

  async getSummariesByConversation(cid: ConversationId): Promise<SummaryNode[]> {
    return this.q<Record<string, unknown>>(
      'SELECT * FROM summaries WHERE conversation_id = ? ORDER BY depth ASC, created_at ASC', cid
    ).map(r => this.rowToSummary(r));
  }

  async linkSummaryToMessages(links: SummaryMessageLink[]): Promise<void> {
    if (links.length === 0) return;
    const stmt = this.db.prepare('INSERT OR IGNORE INTO summary_messages (summary_id, message_id) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const l of links) stmt.run(l.summaryId, l.messageId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async linkSummaryToParents(links: SummaryParentLink[]): Promise<void> {
    if (links.length === 0) return;
    const stmt = this.db.prepare('INSERT OR IGNORE INTO summary_parents (child_id, parent_id, ordinal) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const l of links) stmt.run(l.childId, l.parentId, l.ordinal);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async getChildSummaries(id: SummaryId): Promise<SummaryNode[]> {
    return this.q<Record<string, unknown>>(
      'SELECT s.* FROM summaries s JOIN summary_parents sp ON sp.child_id = s.id WHERE sp.parent_id = ? ORDER BY sp.ordinal', id
    ).map(r => this.rowToSummary(r));
  }

  async getParentSummaries(id: SummaryId): Promise<SummaryNode[]> {
    return this.q<Record<string, unknown>>(
      'SELECT s.* FROM summaries s JOIN summary_parents sp ON sp.parent_id = s.id WHERE sp.child_id = ? ORDER BY sp.ordinal', id
    ).map(r => this.rowToSummary(r));
  }

  async getSourceMessages(sid: SummaryId): Promise<EnrichedMessage[]> {
    return this.q<Record<string, unknown>>(
      'SELECT m.* FROM messages m JOIN summary_messages sm ON sm.message_id = m.id WHERE sm.summary_id = ? ORDER BY m.created_at', sid
    ).map(r => this.rowToMessage(r));
  }

  async updateSummaryQuality(id: SummaryId, score: number, method: string): Promise<void> {
    this.db.prepare('UPDATE summaries SET quality_score = ?, quality_method = ? WHERE id = ?').run(score, method, id);
  }

  async flagForResummary(id: SummaryId): Promise<void> {
    this.db.prepare('UPDATE summaries SET flagged_for_resummary = 1 WHERE id = ?').run(id);
  }

  async deleteSummary(id: SummaryId): Promise<void> {
    this.db.prepare('DELETE FROM summaries WHERE id = ?').run(id);
  }

  // ─── Context Items ──────────────────────────────────────

  async getContextItems(cid: ConversationId): Promise<ContextItem[]> {
    return this.q<Record<string, unknown>>(
      'SELECT * FROM context_items WHERE conversation_id = ? ORDER BY ordinal ASC', cid
    ).map(r => ({
      conversationId: r.conversation_id as string, ordinal: r.ordinal as number,
      itemType: r.item_type as 'message' | 'summary', itemId: r.item_id as string,
    }));
  }

  async updateContextItems(cid: ConversationId, items: ContextItem[]): Promise<void> {
    this.db.prepare('DELETE FROM context_items WHERE conversation_id = ?').run(cid);
    const stmt = this.db.prepare('INSERT INTO context_items (conversation_id,ordinal,item_type,item_id) VALUES (?,?,?,?)');
    for (const i of items) stmt.run(cid, i.ordinal, i.itemType, i.itemId);
  }

  // ─── Audit ──────────────────────────────────────────────

  async appendAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    this.db.prepare(`INSERT INTO audit_log (id,timestamp,actor,action,target_type,target_id,conversation_id,metadata)
      VALUES (?,datetime('now'),?,?,?,?,?,?)`).run(
      randomUUID(), entry.actor, entry.action, entry.targetType,
      entry.targetId, entry.conversationId, entry.metadata ? JSON.stringify(entry.metadata) : null);
  }

  async queryAudit(opts: { conversationId?: string; action?: AuditAction; since?: string; before?: string; limit?: number }): Promise<AuditEntry[]> {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: SqlParam[] = [];
    if (opts.conversationId) { sql += ' AND conversation_id = ?'; params.push(opts.conversationId); }
    if (opts.action) { sql += ' AND action = ?'; params.push(opts.action); }
    if (opts.since) { sql += ' AND timestamp >= ?'; params.push(opts.since); }
    if (opts.before) { sql += ' AND timestamp <= ?'; params.push(opts.before); }
    sql += ' ORDER BY timestamp DESC LIMIT ?'; params.push(opts.limit ?? 100);
    return this.q<Record<string, unknown>>(sql, ...params).map(r => ({
      id: r.id as string, timestamp: r.timestamp as string, actor: r.actor as string,
      action: r.action as AuditAction, targetType: r.target_type as string,
      targetId: r.target_id as string | null, conversationId: r.conversation_id as string | null,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : null,
    }));
  }

  // ─── Retention ──────────────────────────────────────────

  async upsertRetentionPolicy(p: RetentionPolicy): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO retention_policies
      (id,conversation_id,max_age_days,max_messages,pii_max_age_days,auto_delete,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      p.id, p.conversationId, p.maxAgeDays, p.maxMessages, p.piiMaxAgeDays,
      p.autoDelete ? 1 : 0, p.createdAt, p.updatedAt);
  }

  async getRetentionPolicy(cid: ConversationId | null): Promise<RetentionPolicy | null> {
    const sql = cid ? 'SELECT * FROM retention_policies WHERE conversation_id = ?' : 'SELECT * FROM retention_policies WHERE conversation_id IS NULL';
    const rows = cid ? this.q<Record<string, unknown>>(sql, cid) : this.q<Record<string, unknown>>(sql);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id as string, conversationId: r.conversation_id as string | null,
      maxAgeDays: r.max_age_days as number | null, maxMessages: r.max_messages as number | null,
      piiMaxAgeDays: r.pii_max_age_days as number | null, autoDelete: (r.auto_delete as number) === 1,
      createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    };
  }

  async enforceRetention(cid: ConversationId): Promise<DeletionReport> {
    const policy = await this.getRetentionPolicy(cid) ?? await this.getRetentionPolicy(null);
    if (!policy) return { messagesDeleted: 0, summariesInvalidated: 0, summariesRegenerated: 0, embeddingsRemoved: 0, auditEntriesCreated: 0 };
    const ids: string[] = [];
    if (policy.maxAgeDays !== null) {
      const cutoff = new Date(Date.now() - policy.maxAgeDays * 86400000).toISOString();
      ids.push(...this.q<{ id: string }>('SELECT id FROM messages WHERE conversation_id = ? AND created_at < ?', cid, cutoff).map(r => r.id));
    }
    if (policy.maxMessages !== null) {
      // Compute the delete count in JS — SQLite has no scalar max() function
      const countRows = this.q<{ cnt: number }>('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?', cid);
      const deleteCount = Math.max(0, (countRows[0]?.cnt ?? 0) - policy.maxMessages);
      if (deleteCount > 0) {
        ids.push(...this.q<{ id: string }>(
          'SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?',
          cid, deleteCount).map(r => r.id));
      }
    }
    if (policy.piiMaxAgeDays !== null) {
      const pc = new Date(Date.now() - policy.piiMaxAgeDays * 86400000).toISOString();
      ids.push(...this.q<{ id: string }>('SELECT id FROM messages WHERE conversation_id = ? AND pii_detected = 1 AND created_at < ?', cid, pc).map(r => r.id));
    }
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { messagesDeleted: 0, summariesInvalidated: 0, summariesRegenerated: 0, embeddingsRemoved: 0, auditEntriesCreated: 0 };
    const report = await this.deleteMessages(unique);
    await this.appendAudit({ actor: 'system', action: 'retention_enforced', targetType: 'conversation', targetId: cid, conversationId: cid, metadata: { policy: policy.id, deleted: report.messagesDeleted } });
    return report;
  }

  // ─── Memory Scopes ──────────────────────────────────────

  async createScope(s: MemoryScope): Promise<ScopeId> {
    this.db.prepare('INSERT INTO memory_scopes (id,name,parent_scope_id,permissions) VALUES (?,?,?,?)').run(
      s.id, s.name, s.parentScopeId, JSON.stringify(s.permissions));
    return s.id;
  }

  async getScope(id: ScopeId): Promise<MemoryScope | null> {
    const rows = this.q<Record<string, unknown>>('SELECT * FROM memory_scopes WHERE id = ?', id);
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id as string, name: r.name as string, parentScopeId: r.parent_scope_id as string | null, permissions: JSON.parse(r.permissions as string) };
  }

  async checkPermission(scopeId: ScopeId, action: 'read' | 'write' | 'search' | 'expand', targetScopeId: ScopeId): Promise<boolean> {
    const scope = await this.getScope(targetScopeId);
    if (!scope) return false;
    return scope.permissions[action].includes(scopeId) || scope.permissions[action].includes('*');
  }

  // ─── Embeddings ─────────────────────────────────────────

  async upsertEmbedding(rec: EmbeddingRecord): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO embeddings (id,entity_type,entity_id,vector,model,created_at) VALUES (?,?,?,?,?,?)').run(
      rec.id, rec.entityType, rec.entityId, Buffer.from(rec.vector.buffer), rec.model, rec.createdAt);
  }

  async getEmbedding(entityId: string): Promise<EmbeddingRecord | null> {
    const rows = this.q<Record<string, unknown>>('SELECT * FROM embeddings WHERE entity_id = ?', entityId);
    if (rows.length === 0) return null;
    const r = rows[0];
    const buf = r.vector as Buffer;
    return {
      id: r.id as string, entityType: r.entity_type as EmbeddingRecord['entityType'],
      entityId: r.entity_id as string, vector: new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8),
      model: r.model as string, createdAt: r.created_at as string,
    };
  }

  async similaritySearch(vector: Float64Array, k: number, filter?: { entityType?: string; conversationId?: string }): Promise<SimilarityResult[]> {
    let sql = 'SELECT e.* FROM embeddings e';
    const params: SqlParam[] = [];
    if (filter?.conversationId) {
      // Join to messages/summaries to filter by conversation
      sql += ` JOIN (
        SELECT id, conversation_id FROM messages
        UNION ALL
        SELECT id, conversation_id FROM summaries
      ) src ON src.id = e.entity_id WHERE src.conversation_id = ?`;
      params.push(filter.conversationId);
      if (filter.entityType) { sql += ' AND e.entity_type = ?'; params.push(filter.entityType); }
    } else {
      sql += ' WHERE 1=1';
      if (filter?.entityType) { sql += ' AND entity_type = ?'; params.push(filter.entityType); }
    }
    const rows = this.q<Record<string, unknown>>(sql, ...params);
    const scored: SimilarityResult[] = [];
    for (const row of rows) {
      const buf = row.vector as Buffer;
      const stored = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
      scored.push({ entityType: row.entity_type as SimilarityResult['entityType'], entityId: row.entity_id as string, score: cosineSimilarity(vector, stored) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  // ─── Private ────────────────────────────────────────────

  private q<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private rowToMessage(r: Record<string, unknown>): EnrichedMessage {
    return {
      id: r.id as string, conversationId: r.conversation_id as string,
      role: r.role as EnrichedMessage['role'], content: r.content as string,
      tokenCount: r.token_count as number, createdAt: r.created_at as string,
      pii: r.pii_annotations ? JSON.parse(r.pii_annotations as string) : [],
      topicId: r.topic_id as string | null, topicLabel: r.topic_label as string | null,
      compressedContent: r.compressed_content as string | null,
      compressedTokenCount: r.compressed_token_count as number | null,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    };
  }

  private rowToSummary(r: Record<string, unknown>): SummaryNode {
    return {
      id: r.id as string, conversationId: r.conversation_id as string,
      kind: r.kind as SummaryNode['kind'], depth: r.depth as number,
      content: r.content as string, tokenCount: r.token_count as number,
      qualityScore: r.quality_score as number | null, qualityMethod: r.quality_method as string | null,
      flaggedForResummary: (r.flagged_for_resummary as number) === 1,
      earliestAt: r.earliest_at as string, latestAt: r.latest_at as string,
      createdAt: r.created_at as string, metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    };
  }

  private sanitizeFts(input: string): string {
    return input.replace(/[*"(){}[\]^~\\]/g, ' ').trim();
  }

  private escapeLike(input: string): string {
    return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }
}
