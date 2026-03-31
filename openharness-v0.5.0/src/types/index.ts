/**
 * LCM v2 Core Types
 *
 * All data models for messages, summaries, DAG nodes, audit,
 * retention, permissions, and embeddings.
 */

// ─── Identifiers ────────────────────────────────────────────

export type MessageId = string;
export type SummaryId = string;
export type ConversationId = string;
export type ScopeId = string;
export type FileId = string;

// ─── Messages ───────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface RawMessage {
  id: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface EnrichedMessage extends RawMessage {
  pii: PiiAnnotation[];
  topicId: string | null;
  topicLabel: string | null;
  compressedContent: string | null; // for summarization input
  compressedTokenCount: number | null;
}

// ─── PII ────────────────────────────────────────────────────

export type PiiType =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'api_key'
  | 'ip_address'
  | 'aws_key'
  | 'jwt';

export interface PiiAnnotation {
  type: PiiType;
  start: number;
  end: number;
  confidence: number; // 0.0 - 1.0
}

export type PiiMode = 'annotate' | 'redact_in_summaries' | 'redact_everywhere';

export interface PiiPolicy {
  mode: PiiMode;
  types: PiiType[];
  retentionDays: number | null; // null = no special retention
}

// ─── Summaries (DAG) ────────────────────────────────────────

export type SummaryKind = 'leaf' | 'condensed';

export interface SummaryNode {
  id: SummaryId;
  conversationId: ConversationId;
  kind: SummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  qualityScore: number | null;
  qualityMethod: string | null;
  flaggedForResummary: boolean;
  earliestAt: string;
  latestAt: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SummaryMessageLink {
  summaryId: SummaryId;
  messageId: MessageId;
}

export interface SummaryParentLink {
  childId: SummaryId;
  parentId: SummaryId;
  ordinal: number;
}

// ─── Context Items ──────────────────────────────────────────

export type ContextItemType = 'message' | 'summary';

export interface ContextItem {
  conversationId: ConversationId;
  ordinal: number;
  itemType: ContextItemType;
  itemId: string; // MessageId or SummaryId
}

// ─── Audit ──────────────────────────────────────────────────

export type AuditAction =
  | 'message_persisted'
  | 'summary_created'
  | 'summary_deleted'
  | 'message_deleted'
  | 'search_executed'
  | 'expand_executed'
  | 'compaction_triggered'
  | 'retention_enforced'
  | 'scope_access';

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  targetType: string;
  targetId: string | null;
  conversationId: string | null;
  metadata: Record<string, unknown> | null;
}

// ─── Retention ──────────────────────────────────────────────

export interface RetentionPolicy {
  id: string;
  conversationId: string | null; // null = global default
  maxAgeDays: number | null;
  maxMessages: number | null;
  piiMaxAgeDays: number | null;
  autoDelete: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeletionReport {
  messagesDeleted: number;
  summariesInvalidated: number;
  summariesRegenerated: number;
  embeddingsRemoved: number;
  auditEntriesCreated: number;
}

// ─── Memory Scopes ──────────────────────────────────────────

export interface MemoryScope {
  id: ScopeId;
  name: string;
  parentScopeId: ScopeId | null;
  permissions: ScopePermissions;
}

export interface ScopePermissions {
  read: ScopeId[];
  write: ScopeId[];
  search: ScopeId[];
  expand: ScopeId[];
}

// ─── Embeddings ─────────────────────────────────────────────

export type EmbeddableEntityType = 'message' | 'summary' | 'file';

export interface EmbeddingRecord {
  id: string;
  entityType: EmbeddableEntityType;
  entityId: string;
  vector: Float64Array;
  model: string;
  createdAt: string;
}

export interface SimilarityResult {
  entityType: EmbeddableEntityType;
  entityId: string;
  score: number;
}

// ─── Search ─────────────────────────────────────────────────

export interface SearchQuery {
  pattern: string;
  mode: 'fts' | 'regex';
  scope: 'messages' | 'summaries' | 'both';
  conversationId?: string;
  since?: string;
  before?: string;
  limit: number;
}

export interface SearchResult {
  entityType: 'message' | 'summary';
  entityId: string;
  content: string;
  rank: number;
  highlights?: string[];
}

// ─── Health ─────────────────────────────────────────────────

export interface HealthStatus {
  ok: boolean;
  dbSizeBytes: number;
  messageCount: number;
  summaryCount: number;
  walSizeBytes: number | null;
  errors: string[];
}

// ─── Topic Segmentation ─────────────────────────────────────

export interface TopicSegment {
  topicId: string;
  topicLabel: string;
  messages: RawMessage[];
  tokenCount: number;
  startTime: string;
  endTime: string;
}

// ─── Ingestion ──────────────────────────────────────────────

export interface IngestionResult {
  message: EnrichedMessage;
  piiDetected: boolean;
  topicChanged: boolean;
  embeddingGenerated: boolean;
}
