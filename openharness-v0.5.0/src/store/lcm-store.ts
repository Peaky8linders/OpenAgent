/**
 * LcmStore — Abstract async storage interface for LCM v2.
 *
 * All operations return Promises for PostgreSQL compatibility.
 * SQLite implementation wraps sync calls in resolved Promises.
 */
import type {
  EnrichedMessage,
  MessageId,
  SummaryNode,
  SummaryId,
  SummaryMessageLink,
  SummaryParentLink,
  ConversationId,
  ContextItem,
  AuditEntry,
  AuditAction,
  RetentionPolicy,
  MemoryScope,
  ScopeId,
  EmbeddingRecord,
  SimilarityResult,
  SearchQuery,
  SearchResult,
  HealthStatus,
  DeletionReport,
} from '../types/index.js';

export interface TimeRange {
  since?: string;
  before?: string;
}

export interface LcmStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  backup(destinationPath: string): Promise<void>;

  persistMessage(msg: EnrichedMessage): Promise<MessageId>;
  getMessage(id: MessageId): Promise<EnrichedMessage | null>;
  getMessagesByConversation(conversationId: ConversationId, range?: TimeRange): Promise<EnrichedMessage[]>;
  searchMessages(query: SearchQuery): Promise<SearchResult[]>;
  deleteMessages(ids: MessageId[]): Promise<DeletionReport>;

  createSummary(summary: SummaryNode): Promise<SummaryId>;
  getSummary(id: SummaryId): Promise<SummaryNode | null>;
  getSummariesByConversation(conversationId: ConversationId): Promise<SummaryNode[]>;
  linkSummaryToMessages(links: SummaryMessageLink[]): Promise<void>;
  linkSummaryToParents(links: SummaryParentLink[]): Promise<void>;
  getChildSummaries(id: SummaryId): Promise<SummaryNode[]>;
  getParentSummaries(id: SummaryId): Promise<SummaryNode[]>;
  getSourceMessages(summaryId: SummaryId): Promise<EnrichedMessage[]>;
  updateSummaryQuality(id: SummaryId, score: number, method: string): Promise<void>;
  flagForResummary(id: SummaryId): Promise<void>;
  deleteSummary(id: SummaryId): Promise<void>;

  getContextItems(conversationId: ConversationId): Promise<ContextItem[]>;
  updateContextItems(conversationId: ConversationId, items: ContextItem[]): Promise<void>;

  appendAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void>;
  queryAudit(opts: {
    conversationId?: string;
    action?: AuditAction;
    since?: string;
    before?: string;
    limit?: number;
  }): Promise<AuditEntry[]>;

  upsertRetentionPolicy(policy: RetentionPolicy): Promise<void>;
  getRetentionPolicy(conversationId: ConversationId | null): Promise<RetentionPolicy | null>;
  enforceRetention(conversationId: ConversationId): Promise<DeletionReport>;

  createScope(scope: MemoryScope): Promise<ScopeId>;
  getScope(id: ScopeId): Promise<MemoryScope | null>;
  checkPermission(scopeId: ScopeId, action: 'read' | 'write' | 'search' | 'expand', targetScopeId: ScopeId): Promise<boolean>;

  upsertEmbedding(record: EmbeddingRecord): Promise<void>;
  getEmbedding(entityId: string): Promise<EmbeddingRecord | null>;
  similaritySearch(vector: Float64Array, k: number, filter?: { entityType?: string; conversationId?: string }): Promise<SimilarityResult[]>;
}
