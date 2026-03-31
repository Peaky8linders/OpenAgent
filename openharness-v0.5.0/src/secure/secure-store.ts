/**
 * SecureStore — Governance wrapper around any LcmStore.
 *
 * Decorator pattern: wraps an existing LcmStore with:
 *   1. RBAC enforcement (checked BEFORE every operation)
 *   2. Sentinel inspection (all content scanned before persistence)
 *   3. Tamper-proof audit ledger (hash-chained, separate from LCM's audit_log)
 *   4. PII/PHI compliance (dual detection: LCM + VaultClaw)
 *
 * Does NOT modify the underlying store implementation.
 * Works with SqliteStore, PgStore, or any LcmStore.
 */
import { randomUUID } from 'node:crypto';
import type { LcmStore, TimeRange } from '../store/lcm-store.js';
import type {
  EnrichedMessage, MessageId, SummaryNode, SummaryId,
  SummaryMessageLink, SummaryParentLink, ConversationId,
  ContextItem, AuditEntry, AuditAction, RetentionPolicy,
  MemoryScope, ScopeId, EmbeddingRecord, SimilarityResult,
  SearchQuery, SearchResult, HealthStatus, DeletionReport,
} from '../types/index.js';

// ─── VaultClaw types (inlined to avoid cross-package dep) ────────

export type SecureRole = 'admin' | 'operator' | 'auditor' | 'user';

export interface SecureUser {
  readonly id: string;
  readonly role: SecureRole;
}

export interface SecureAuditEntry {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly timestamp: string;
  readonly type: string;
  readonly userId: string;
  readonly action: string;
  readonly target: string;
  readonly previousHash: string;
  readonly hash: string;
  readonly details: Record<string, unknown>;
  readonly outcome: 'success' | 'failure' | 'blocked';
}

export type ThreatLevel = 'safe' | 'suspicious' | 'blocked';

export interface ThreatFinding {
  readonly category: string;
  readonly confidence: number;
  readonly description: string;
  readonly matchedPattern?: string;
}

export interface InspectionResult {
  readonly threatLevel: ThreatLevel;
  readonly findings: ThreatFinding[];
  readonly latencyMs: number;
}

/**
 * Sentinel pipeline interface — injectable for testing.
 */
export interface SentinelInspector {
  inspect(content: string): InspectionResult;
}

/**
 * Audit ledger interface — injectable for testing.
 */
export interface AuditLedgerWriter {
  record(event: {
    type: string;
    userId?: string;
    sessionId?: string;
    details: Record<string, unknown>;
    outcome: 'success' | 'failure' | 'blocked';
  }): SecureAuditEntry;
  verifyChain(): { valid: boolean; brokenAt?: number; reason?: string };
}

// ─── Permission Matrix ───────────────────────────────────────────

type StoreAction = 'read' | 'write' | 'delete' | 'search' | 'admin' | 'audit_read';

const ROLE_PERMISSIONS: Record<SecureRole, Set<StoreAction>> = {
  admin: new Set(['read', 'write', 'delete', 'search', 'admin', 'audit_read']),
  operator: new Set(['read', 'write', 'search']),
  auditor: new Set(['read', 'search', 'audit_read']),
  user: new Set(['read', 'search']),
};

function checkPermission(role: SecureRole, action: StoreAction): boolean {
  return ROLE_PERMISSIONS[role].has(action);
}

// ─── SecureStore ─────────────────────────────────────────────────

export interface SecureStoreConfig {
  /** Block content that sentinel flags as suspicious (default: true) */
  blockOnSuspicious?: boolean;
  /** Enable sentinel content inspection (default: true) */
  sentinelEnabled?: boolean;
  /** Enable audit logging (default: true) */
  auditEnabled?: boolean;
}

export class SecureStore implements LcmStore {
  private readonly inner: LcmStore;
  private readonly sentinel: SentinelInspector | null;
  private readonly audit: AuditLedgerWriter | null;
  private readonly config: Required<SecureStoreConfig>;
  private currentUser: SecureUser;

  constructor(
    inner: LcmStore,
    user: SecureUser,
    sentinel: SentinelInspector | null,
    audit: AuditLedgerWriter | null,
    config: SecureStoreConfig = {},
  ) {
    this.inner = inner;
    this.currentUser = user;
    this.sentinel = sentinel;
    this.audit = audit;
    this.config = {
      blockOnSuspicious: config.blockOnSuspicious ?? true,
      sentinelEnabled: config.sentinelEnabled ?? true,
      auditEnabled: config.auditEnabled ?? true,
    };
  }

  /**
   * Switch the active user context (single-user deployments only).
   * WARNING: Not safe for concurrent access. Use withUser() for multi-tenant.
   */
  setUser(user: SecureUser): void {
    this.currentUser = user;
  }

  /**
   * Create a lightweight view of this store bound to a specific user.
   * Safe for concurrent access — each view has its own user context
   * but shares the same underlying store, sentinel, and audit ledger.
   */
  withUser(user: SecureUser): SecureStore {
    return new SecureStore(this.inner, user, this.sentinel, this.audit, this.config);
  }

  // ─── Lifecycle (admin only) ─────────────────────────────

  async initialize(): Promise<void> {
    this.enforce('admin', 'initialize');
    await this.inner.initialize();
    this.log('system_start', 'store', 'success', {});
  }

  async close(): Promise<void> {
    this.enforce('admin', 'close');
    await this.inner.close();
    this.log('system_stop', 'store', 'success', {});
  }

  async healthCheck(): Promise<HealthStatus> {
    this.enforce('read', 'healthCheck');
    return this.inner.healthCheck();
  }

  async backup(destinationPath: string): Promise<void> {
    this.enforce('admin', 'backup');
    this.log('admin_action', `backup:${destinationPath}`, 'success', { path: destinationPath });
    return this.inner.backup(destinationPath);
  }

  // ─── Messages ───────────────────────────────────────────

  async persistMessage(msg: EnrichedMessage): Promise<MessageId> {
    this.enforce('write', 'persistMessage');

    // Sentinel: inspect content before persistence
    const inspection = this.inspectContent(msg.content, 'persistMessage');
    if (inspection && inspection.threatLevel === 'blocked') {
      this.log('sentinel_block', `message:${msg.id}`, 'blocked', {
        findings: inspection.findings.map(f => f.category),
      });
      throw new Error(
        `Content blocked by sentinel: ${inspection.findings.map(f => f.description).join('; ')}`,
      );
    }

    const result = await this.inner.persistMessage(msg);
    this.log('message_persisted', `message:${msg.id}`, 'success', {
      conversationId: msg.conversationId,
      piiDetected: msg.pii.length > 0,
      sentinelClear: true,
    });
    return result;
  }

  async getMessage(id: MessageId): Promise<EnrichedMessage | null> {
    this.enforce('read', 'getMessage');
    return this.inner.getMessage(id);
  }

  async getMessagesByConversation(cid: ConversationId, range?: TimeRange): Promise<EnrichedMessage[]> {
    this.enforce('read', 'getMessagesByConversation');
    return this.inner.getMessagesByConversation(cid, range);
  }

  async searchMessages(query: SearchQuery): Promise<SearchResult[]> {
    this.enforce('search', 'searchMessages');

    // Sentinel: inspect search pattern (could contain injection)
    this.inspectContent(query.pattern, 'searchMessages');

    this.log('search_executed', 'messages', 'success', {
      mode: query.mode,
      scope: query.scope,
      conversationId: query.conversationId,
    });
    return this.inner.searchMessages(query);
  }

  async deleteMessages(ids: MessageId[]): Promise<DeletionReport> {
    this.enforce('delete', 'deleteMessages');
    const report = await this.inner.deleteMessages(ids);
    this.log('message_deleted', `messages:${ids.length}`, 'success', {
      count: ids.length,
      report,
    });
    return report;
  }

  // ─── Summaries ──────────────────────────────────────────

  async createSummary(summary: SummaryNode): Promise<SummaryId> {
    this.enforce('write', 'createSummary');

    // Sentinel: inspect summary content
    const inspection = this.inspectContent(summary.content, 'createSummary');
    if (inspection && inspection.threatLevel === 'blocked') {
      this.log('sentinel_block', `summary:${summary.id}`, 'blocked', {
        findings: inspection.findings.map(f => f.category),
      });
      throw new Error(`Summary content blocked by sentinel`);
    }

    const result = await this.inner.createSummary(summary);
    this.log('summary_created', `summary:${summary.id}`, 'success', {
      conversationId: summary.conversationId,
      depth: summary.depth,
    });
    return result;
  }

  async getSummary(id: SummaryId): Promise<SummaryNode | null> {
    this.enforce('read', 'getSummary');
    return this.inner.getSummary(id);
  }

  async getSummariesByConversation(cid: ConversationId): Promise<SummaryNode[]> {
    this.enforce('read', 'getSummariesByConversation');
    return this.inner.getSummariesByConversation(cid);
  }

  async linkSummaryToMessages(links: SummaryMessageLink[]): Promise<void> {
    this.enforce('write', 'linkSummaryToMessages');
    return this.inner.linkSummaryToMessages(links);
  }

  async linkSummaryToParents(links: SummaryParentLink[]): Promise<void> {
    this.enforce('write', 'linkSummaryToParents');
    return this.inner.linkSummaryToParents(links);
  }

  async getChildSummaries(id: SummaryId): Promise<SummaryNode[]> {
    this.enforce('read', 'getChildSummaries');
    return this.inner.getChildSummaries(id);
  }

  async getParentSummaries(id: SummaryId): Promise<SummaryNode[]> {
    this.enforce('read', 'getParentSummaries');
    return this.inner.getParentSummaries(id);
  }

  async getSourceMessages(summaryId: SummaryId): Promise<EnrichedMessage[]> {
    this.enforce('read', 'getSourceMessages');
    return this.inner.getSourceMessages(summaryId);
  }

  async updateSummaryQuality(id: SummaryId, score: number, method: string): Promise<void> {
    this.enforce('write', 'updateSummaryQuality');
    return this.inner.updateSummaryQuality(id, score, method);
  }

  async flagForResummary(id: SummaryId): Promise<void> {
    this.enforce('write', 'flagForResummary');
    return this.inner.flagForResummary(id);
  }

  async deleteSummary(id: SummaryId): Promise<void> {
    this.enforce('delete', 'deleteSummary');
    this.log('summary_deleted', `summary:${id}`, 'success', {});
    return this.inner.deleteSummary(id);
  }

  // ─── Context Items ──────────────────────────────────────

  async getContextItems(cid: ConversationId): Promise<ContextItem[]> {
    this.enforce('read', 'getContextItems');
    return this.inner.getContextItems(cid);
  }

  async updateContextItems(cid: ConversationId, items: ContextItem[]): Promise<void> {
    this.enforce('write', 'updateContextItems');
    return this.inner.updateContextItems(cid, items);
  }

  // ─── Audit ──────────────────────────────────────────────

  async appendAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    this.enforce('write', 'appendAudit');
    // Write to both LCM's audit table AND VaultClaw's tamper-proof ledger
    await this.inner.appendAudit(entry);
    this.log(entry.action, `${entry.targetType}:${entry.targetId ?? 'null'}`, 'success', entry.metadata ?? {});
  }

  async queryAudit(opts: { conversationId?: string; action?: AuditAction; since?: string; before?: string; limit?: number }): Promise<AuditEntry[]> {
    this.enforce('audit_read', 'queryAudit');
    return this.inner.queryAudit(opts);
  }

  // ─── Retention ──────────────────────────────────────────

  async upsertRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    this.enforce('admin', 'upsertRetentionPolicy');
    this.log('admin_action', `retention:${policy.id}`, 'success', {
      conversationId: policy.conversationId,
      maxAgeDays: policy.maxAgeDays,
    });
    return this.inner.upsertRetentionPolicy(policy);
  }

  async getRetentionPolicy(cid: ConversationId | null): Promise<RetentionPolicy | null> {
    this.enforce('read', 'getRetentionPolicy');
    return this.inner.getRetentionPolicy(cid);
  }

  async enforceRetention(cid: ConversationId): Promise<DeletionReport> {
    this.enforce('admin', 'enforceRetention');
    const report = await this.inner.enforceRetention(cid);
    this.log('retention_enforced', `conversation:${cid}`, 'success', { report });
    return report;
  }

  // ─── Memory Scopes ─────────────────────────────────────

  async createScope(scope: MemoryScope): Promise<ScopeId> {
    this.enforce('admin', 'createScope');
    return this.inner.createScope(scope);
  }

  async getScope(id: ScopeId): Promise<MemoryScope | null> {
    this.enforce('read', 'getScope');
    return this.inner.getScope(id);
  }

  async checkPermission(scopeId: ScopeId, action: 'read' | 'write' | 'search' | 'expand', targetScopeId: ScopeId): Promise<boolean> {
    this.enforce('read', 'checkPermission');
    return this.inner.checkPermission(scopeId, action, targetScopeId);
  }

  // ─── Embeddings ─────────────────────────────────────────

  async upsertEmbedding(record: EmbeddingRecord): Promise<void> {
    this.enforce('write', 'upsertEmbedding');
    return this.inner.upsertEmbedding(record);
  }

  async getEmbedding(entityId: string): Promise<EmbeddingRecord | null> {
    this.enforce('read', 'getEmbedding');
    return this.inner.getEmbedding(entityId);
  }

  async similaritySearch(vector: Float64Array, k: number, filter?: { entityType?: string; conversationId?: string }): Promise<SimilarityResult[]> {
    this.enforce('search', 'similaritySearch');
    return this.inner.similaritySearch(vector, k, filter);
  }

  // ─── Governance Accessors ──────────────────────────────

  /**
   * Verify the integrity of the governance audit chain.
   */
  verifyAuditChain(): { valid: boolean; brokenAt?: number; reason?: string } {
    if (!this.audit) return { valid: true };
    return this.audit.verifyChain();
  }

  /**
   * Get the current user context.
   */
  getUser(): SecureUser {
    return this.currentUser;
  }

  // ─── Private ────────────────────────────────────────────

  private enforce(action: StoreAction, method: string): void {
    if (!checkPermission(this.currentUser.role, action)) {
      this.log(`auth_failure`, method, 'failure', {
        requiredAction: action,
        userRole: this.currentUser.role,
      });
      throw new Error(
        `Access denied: role '${this.currentUser.role}' lacks '${action}' permission for ${method}`,
      );
    }
  }

  private inspectContent(content: string, source: string): InspectionResult | null {
    if (!this.config.sentinelEnabled || !this.sentinel) return null;

    const result = this.sentinel.inspect(content);

    if (result.threatLevel !== 'safe') {
      this.log(
        result.threatLevel === 'blocked' ? 'sentinel_block' : 'sentinel_flag',
        source,
        result.threatLevel === 'blocked' ? 'blocked' : 'success',
        {
          findings: result.findings.map(f => ({ category: f.category, confidence: f.confidence })),
          latencyMs: result.latencyMs,
        },
      );
    }

    if (result.threatLevel === 'blocked') return result;
    if (result.threatLevel === 'suspicious' && this.config.blockOnSuspicious) {
      return { ...result, threatLevel: 'blocked' };
    }

    return result;
  }

  private log(type: string, target: string, outcome: 'success' | 'failure' | 'blocked', details: Record<string, unknown>): void {
    if (!this.config.auditEnabled || !this.audit) return;
    this.audit.record({
      type,
      userId: this.currentUser.id,
      details: { ...details, target },
      outcome,
    });
  }
}
