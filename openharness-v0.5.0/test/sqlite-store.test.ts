import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from '../src/store/sqlite-store.js';
import type {
  EnrichedMessage,
  SummaryNode,
  SummaryMessageLink,
  SummaryParentLink,
  ContextItem,
  RetentionPolicy,
  MemoryScope,
  EmbeddingRecord,
} from '../src/types/index.js';
import { randomUUID } from 'node:crypto';

function makeMessage(overrides: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return {
    id: randomUUID(),
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello, this is a test message',
    tokenCount: 8,
    createdAt: new Date().toISOString(),
    pii: [],
    topicId: null,
    topicLabel: null,
    compressedContent: null,
    compressedTokenCount: null,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SummaryNode> = {}): SummaryNode {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    conversationId: 'conv-1',
    kind: 'leaf',
    depth: 0,
    content: 'Summary of conversation about testing',
    tokenCount: 6,
    qualityScore: null,
    qualityMethod: null,
    flaggedForResummary: false,
    earliestAt: now,
    latestAt: now,
    createdAt: now,
    ...overrides,
  };
}

describe('SqliteStore', () => {
  let store: SqliteStore;

  beforeEach(async () => {
    store = new SqliteStore({ path: ':memory:' });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  // ─── Lifecycle ─────────────────────────────────────────

  describe('lifecycle', () => {
    it('healthCheck returns valid status after init', async () => {
      const health = await store.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.messageCount).toBe(0);
      expect(health.summaryCount).toBe(0);
      expect(health.errors).toHaveLength(0);
    });
  });

  // ─── Messages ──────────────────────────────────────────

  describe('messages', () => {
    it('persists and retrieves a message', async () => {
      const msg = makeMessage();
      await store.persistMessage(msg);

      const retrieved = await store.getMessage(msg.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(msg.id);
      expect(retrieved!.content).toBe(msg.content);
      expect(retrieved!.role).toBe('user');
    });

    it('returns null for non-existent message', async () => {
      expect(await store.getMessage('nonexistent')).toBeNull();
    });

    it('retrieves messages by conversation', async () => {
      const m1 = makeMessage({ createdAt: '2026-01-01T00:00:00Z' });
      const m2 = makeMessage({ createdAt: '2026-01-02T00:00:00Z' });
      const m3 = makeMessage({ conversationId: 'conv-2' });

      await store.persistMessage(m1);
      await store.persistMessage(m2);
      await store.persistMessage(m3);

      const msgs = await store.getMessagesByConversation('conv-1');
      expect(msgs).toHaveLength(2);
      expect(msgs[0].createdAt).toBe('2026-01-01T00:00:00Z');
    });

    it('filters messages by time range', async () => {
      const m1 = makeMessage({ createdAt: '2026-01-01T00:00:00Z' });
      const m2 = makeMessage({ createdAt: '2026-06-01T00:00:00Z' });
      await store.persistMessage(m1);
      await store.persistMessage(m2);

      const msgs = await store.getMessagesByConversation('conv-1', {
        since: '2026-03-01T00:00:00Z',
      });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe(m2.id);
    });

    it('persists PII annotations', async () => {
      const msg = makeMessage({
        pii: [{ type: 'email', start: 0, end: 15, confidence: 0.95 }],
      });
      await store.persistMessage(msg);

      const retrieved = await store.getMessage(msg.id);
      expect(retrieved!.pii).toHaveLength(1);
      expect(retrieved!.pii[0].type).toBe('email');
    });

    it('persists topic and compression metadata', async () => {
      const msg = makeMessage({
        topicId: 'topic-abc',
        topicLabel: 'Testing',
        compressedContent: 'Hello test',
        compressedTokenCount: 3,
      });
      await store.persistMessage(msg);

      const retrieved = await store.getMessage(msg.id);
      expect(retrieved!.topicId).toBe('topic-abc');
      expect(retrieved!.compressedContent).toBe('Hello test');
      expect(retrieved!.compressedTokenCount).toBe(3);
    });

    it('FTS search finds messages by content', async () => {
      const m1 = makeMessage({ content: 'The database migration was completed' });
      const m2 = makeMessage({ content: 'Weather is nice today' });
      await store.persistMessage(m1);
      await store.persistMessage(m2);

      const results = await store.searchMessages({
        pattern: 'database migration',
        mode: 'fts',
        scope: 'messages',
        limit: 10,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].entityId).toBe(m1.id);
    });

    it('deleteMessages removes message and flags linked summaries', async () => {
      const msg = makeMessage();
      await store.persistMessage(msg);

      const summary = makeSummary();
      await store.createSummary(summary);
      await store.linkSummaryToMessages([{ summaryId: summary.id, messageId: msg.id }]);

      const report = await store.deleteMessages([msg.id]);
      expect(report.messagesDeleted).toBe(1);
      expect(report.summariesInvalidated).toBe(1);

      expect(await store.getMessage(msg.id)).toBeNull();

      const updatedSummary = await store.getSummary(summary.id);
      expect(updatedSummary!.flaggedForResummary).toBe(true);
    });
  });

  // ─── Summaries ─────────────────────────────────────────

  describe('summaries', () => {
    it('creates and retrieves a summary', async () => {
      const s = makeSummary();
      await store.createSummary(s);

      const retrieved = await store.getSummary(s.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.kind).toBe('leaf');
      expect(retrieved!.depth).toBe(0);
    });

    it('links summaries to source messages', async () => {
      const m1 = makeMessage();
      const m2 = makeMessage();
      await store.persistMessage(m1);
      await store.persistMessage(m2);

      const s = makeSummary();
      await store.createSummary(s);
      await store.linkSummaryToMessages([
        { summaryId: s.id, messageId: m1.id },
        { summaryId: s.id, messageId: m2.id },
      ]);

      const sources = await store.getSourceMessages(s.id);
      expect(sources).toHaveLength(2);
    });

    it('builds and traverses DAG parent-child links', async () => {
      const leaf1 = makeSummary({ kind: 'leaf', depth: 0 });
      const leaf2 = makeSummary({ kind: 'leaf', depth: 0 });
      const condensed = makeSummary({ kind: 'condensed', depth: 1 });

      await store.createSummary(leaf1);
      await store.createSummary(leaf2);
      await store.createSummary(condensed);

      await store.linkSummaryToParents([
        { childId: condensed.id, parentId: leaf1.id, ordinal: 0 },
        { childId: condensed.id, parentId: leaf2.id, ordinal: 1 },
      ]);

      const parents = await store.getParentSummaries(condensed.id);
      expect(parents).toHaveLength(2);
      expect(parents[0].id).toBe(leaf1.id);

      const children = await store.getChildSummaries(leaf1.id);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(condensed.id);
    });

    it('updates quality score', async () => {
      const s = makeSummary();
      await store.createSummary(s);
      await store.updateSummaryQuality(s.id, 0.85, 'embedding_similarity');

      const updated = await store.getSummary(s.id);
      expect(updated!.qualityScore).toBe(0.85);
      expect(updated!.qualityMethod).toBe('embedding_similarity');
    });

    it('flags summary for re-summarization', async () => {
      const s = makeSummary();
      await store.createSummary(s);
      await store.flagForResummary(s.id);

      const updated = await store.getSummary(s.id);
      expect(updated!.flaggedForResummary).toBe(true);
    });

    it('gets summaries by conversation ordered by depth', async () => {
      const s1 = makeSummary({ depth: 1, kind: 'condensed' });
      const s2 = makeSummary({ depth: 0, kind: 'leaf' });
      await store.createSummary(s1);
      await store.createSummary(s2);

      const summaries = await store.getSummariesByConversation('conv-1');
      expect(summaries).toHaveLength(2);
      expect(summaries[0].depth).toBe(0); // leaf first
    });
  });

  // ─── Context Items ─────────────────────────────────────

  describe('context items', () => {
    it('stores and retrieves context items in order', async () => {
      const msg = makeMessage();
      const summary = makeSummary();
      await store.persistMessage(msg);
      await store.createSummary(summary);

      const items: ContextItem[] = [
        { conversationId: 'conv-1', ordinal: 0, itemType: 'summary', itemId: summary.id },
        { conversationId: 'conv-1', ordinal: 1, itemType: 'message', itemId: msg.id },
      ];
      await store.updateContextItems('conv-1', items);

      const retrieved = await store.getContextItems('conv-1');
      expect(retrieved).toHaveLength(2);
      expect(retrieved[0].itemType).toBe('summary');
      expect(retrieved[1].itemType).toBe('message');
    });

    it('replaces context items on update', async () => {
      const msg = makeMessage();
      await store.persistMessage(msg);

      await store.updateContextItems('conv-1', [
        { conversationId: 'conv-1', ordinal: 0, itemType: 'message', itemId: msg.id },
      ]);
      expect(await store.getContextItems('conv-1')).toHaveLength(1);

      await store.updateContextItems('conv-1', []);
      expect(await store.getContextItems('conv-1')).toHaveLength(0);
    });
  });

  // ─── Audit ─────────────────────────────────────────────

  describe('audit', () => {
    it('appends and queries audit entries', async () => {
      await store.appendAudit({
        actor: 'system',
        action: 'message_persisted',
        targetType: 'message',
        targetId: 'msg-1',
        conversationId: 'conv-1',
        metadata: { test: true },
      });

      const entries = await store.queryAudit({ conversationId: 'conv-1' });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('message_persisted');
      expect(entries[0].metadata).toEqual({ test: true });
    });

    it('filters audit by action', async () => {
      await store.appendAudit({
        actor: 'system',
        action: 'message_persisted',
        targetType: 'message',
        targetId: 'msg-1',
        conversationId: 'conv-1',
        metadata: null,
      });
      await store.appendAudit({
        actor: 'system',
        action: 'compaction_triggered',
        targetType: 'conversation',
        targetId: 'conv-1',
        conversationId: 'conv-1',
        metadata: null,
      });

      const entries = await store.queryAudit({ action: 'compaction_triggered' });
      expect(entries).toHaveLength(1);
    });
  });

  // ─── Retention ─────────────────────────────────────────

  describe('retention', () => {
    it('stores and retrieves retention policy', async () => {
      const policy: RetentionPolicy = {
        id: randomUUID(),
        conversationId: 'conv-1',
        maxAgeDays: 30,
        maxMessages: 1000,
        piiMaxAgeDays: 7,
        autoDelete: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.upsertRetentionPolicy(policy);

      const retrieved = await store.getRetentionPolicy('conv-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.maxAgeDays).toBe(30);
      expect(retrieved!.autoDelete).toBe(true);
    });

    it('enforces maxMessages retention', async () => {
      const policy: RetentionPolicy = {
        id: randomUUID(),
        conversationId: 'conv-1',
        maxAgeDays: null,
        maxMessages: 2,
        piiMaxAgeDays: null,
        autoDelete: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.upsertRetentionPolicy(policy);

      // Insert 5 messages
      for (let i = 0; i < 5; i++) {
        await store.persistMessage(makeMessage({
          createdAt: new Date(Date.now() - (5 - i) * 60000).toISOString(),
        }));
      }

      const report = await store.enforceRetention('conv-1');
      expect(report.messagesDeleted).toBe(3); // keep 2, delete 3

      const remaining = await store.getMessagesByConversation('conv-1');
      expect(remaining).toHaveLength(2);
    });

    it('enforces PII retention separately', async () => {
      const policy: RetentionPolicy = {
        id: randomUUID(),
        conversationId: 'conv-1',
        maxAgeDays: null,
        maxMessages: null,
        piiMaxAgeDays: 0, // immediate expiry for PII
        autoDelete: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.upsertRetentionPolicy(policy);

      // One with PII, one without
      const withPii = makeMessage({
        pii: [{ type: 'email', start: 0, end: 10, confidence: 0.9 }],
        createdAt: new Date(Date.now() - 86400000).toISOString(), // 1 day old
      });
      const withoutPii = makeMessage({
        createdAt: new Date(Date.now() - 86400000).toISOString(),
      });

      await store.persistMessage(withPii);
      await store.persistMessage(withoutPii);

      const report = await store.enforceRetention('conv-1');
      expect(report.messagesDeleted).toBe(1); // only the PII message
    });
  });

  // ─── Memory Scopes ────────────────────────────────────

  describe('memory scopes', () => {
    it('creates and retrieves a scope', async () => {
      const scope: MemoryScope = {
        id: 'scope-1',
        name: 'user:alice',
        parentScopeId: null,
        permissions: {
          read: ['scope-1'],
          write: ['scope-1'],
          search: ['scope-1'],
          expand: ['scope-1'],
        },
      };
      await store.createScope(scope);

      const retrieved = await store.getScope('scope-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('user:alice');
    });

    it('checks permissions correctly', async () => {
      await store.createScope({
        id: 'team',
        name: 'team:eng',
        parentScopeId: null,
        permissions: {
          read: ['alice', 'bob', '*'],
          write: ['alice'],
          search: ['alice', 'bob'],
          expand: ['alice'],
        },
      });

      expect(await store.checkPermission('alice', 'write', 'team')).toBe(true);
      expect(await store.checkPermission('bob', 'write', 'team')).toBe(false);
      expect(await store.checkPermission('bob', 'read', 'team')).toBe(true);
      expect(await store.checkPermission('charlie', 'read', 'team')).toBe(true); // wildcard
    });
  });

  // ─── Embeddings ────────────────────────────────────────

  describe('embeddings', () => {
    it('stores and retrieves embeddings', async () => {
      const vec = new Float64Array([1, 0, 0, 0]);
      const record: EmbeddingRecord = {
        id: randomUUID(),
        entityType: 'message',
        entityId: 'msg-1',
        vector: vec,
        model: 'test-model',
        createdAt: new Date().toISOString(),
      };
      await store.upsertEmbedding(record);

      const retrieved = await store.getEmbedding('msg-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.vector.length).toBe(4);
      expect(retrieved!.vector[0]).toBeCloseTo(1);
    });

    it('similarity search returns ranked results', async () => {
      // Store 3 vectors: one similar, one orthogonal, one opposite
      const similar = new Float64Array([0.9, 0.1, 0, 0]);
      const orthogonal = new Float64Array([0, 0, 1, 0]);
      const opposite = new Float64Array([-1, 0, 0, 0]);

      await store.upsertEmbedding({
        id: '1', entityType: 'message', entityId: 'similar',
        vector: similar, model: 'test', createdAt: new Date().toISOString(),
      });
      await store.upsertEmbedding({
        id: '2', entityType: 'message', entityId: 'orthogonal',
        vector: orthogonal, model: 'test', createdAt: new Date().toISOString(),
      });
      await store.upsertEmbedding({
        id: '3', entityType: 'message', entityId: 'opposite',
        vector: opposite, model: 'test', createdAt: new Date().toISOString(),
      });

      const query = new Float64Array([1, 0, 0, 0]);
      const results = await store.similaritySearch(query, 3);

      expect(results).toHaveLength(3);
      expect(results[0].entityId).toBe('similar');
      expect(results[0].score).toBeGreaterThan(0.9);
      expect(results[2].entityId).toBe('opposite');
      expect(results[2].score).toBeLessThan(0);
    });
  });
});
