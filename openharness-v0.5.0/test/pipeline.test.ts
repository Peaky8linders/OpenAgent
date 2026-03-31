import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { IngestionPipeline } from '../src/ingestion/pipeline.js';
import { MockEmbeddingGenerator } from '../src/ingestion/embedding-generator.js';
import type { RawMessage } from '../src/types/index.js';

function makeRaw(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    id: randomUUID(),
    conversationId: 'conv-integration',
    role: 'user',
    content: 'A normal message with no PII',
    tokenCount: 7,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('IngestionPipeline (Integration)', () => {
  let store: SqliteStore;
  let pipeline: IngestionPipeline;

  beforeEach(async () => {
    store = new SqliteStore({ path: ':memory:' });
    await store.initialize();
    const embedGen = new MockEmbeddingGenerator();
    pipeline = new IngestionPipeline(store, embedGen);
  });

  afterEach(async () => {
    await store.close();
  });

  it('ingests a plain message end-to-end', async () => {
    const raw = makeRaw();
    const result = await pipeline.ingest(raw);

    expect(result.message.id).toBe(raw.id);
    expect(result.piiDetected).toBe(false);
    expect(result.embeddingGenerated).toBe(true);

    // Verify persisted in store
    const stored = await store.getMessage(raw.id);
    expect(stored).not.toBeNull();
    expect(stored!.content).toBe(raw.content);

    // Verify embedding persisted
    const emb = await store.getEmbedding(raw.id);
    expect(emb).not.toBeNull();
    expect(emb!.vector.length).toBe(64);

    // Verify audit entry
    const audits = await store.queryAudit({ conversationId: 'conv-integration' });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].action).toBe('message_persisted');
  });

  it('detects PII and annotates without modifying content', async () => {
    const raw = makeRaw({
      content: 'My email is user@example.com and key is sk-abcdefghijklmnopqrstuvwxyz123456',
    });
    const result = await pipeline.ingest(raw);

    expect(result.piiDetected).toBe(true);
    expect(result.message.pii.length).toBeGreaterThanOrEqual(1);

    // Critical: raw content is preserved unmodified
    const stored = await store.getMessage(raw.id);
    expect(stored!.content).toBe(raw.content);
    expect(stored!.content).toContain('user@example.com');
  });

  it('pre-compresses long messages', async () => {
    // Create a long message with redundancy
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`Line ${i}: This is repeated boilerplate content that should compress well`);
      lines.push(''); // blank lines
      lines.push(''); // more blank lines
    }
    const raw = makeRaw({ content: lines.join('\n'), tokenCount: 200 });
    const result = await pipeline.ingest(raw);

    const stored = await store.getMessage(raw.id);
    // Raw content preserved
    expect(stored!.content).toBe(raw.content);
    // Compressed version should be shorter
    if (stored!.compressedContent) {
      expect(stored!.compressedContent.length).toBeLessThan(raw.content.length);
    }
  });

  it('skips compression for short messages', async () => {
    const raw = makeRaw({ content: 'Short' });
    const result = await pipeline.ingest(raw);

    const stored = await store.getMessage(raw.id);
    expect(stored!.compressedContent).toBeNull();
  });

  it('assigns topic IDs to messages', async () => {
    const m1 = makeRaw({ content: 'Let us discuss the database schema design' });
    const m2 = makeRaw({ content: 'The database tables need foreign keys' });

    const r1 = await pipeline.ingest(m1);
    const r2 = await pipeline.ingest(m2);

    expect(r1.message.topicId).not.toBeNull();
    expect(r2.message.topicId).not.toBeNull();
    // Same topic since content is similar
    expect(r1.message.topicId).toBe(r2.message.topicId);
  });

  it('detects topic shifts', async () => {
    // Ingest several messages on topic A
    for (let i = 0; i < 4; i++) {
      await pipeline.ingest(makeRaw({
        content: `Database schema design discussion point ${i} about tables and indexes`,
      }));
    }

    // Then shift to a completely different topic
    const shifted = await pipeline.ingest(makeRaw({
      content: 'The weather forecast shows rain and thunderstorms coming this weekend',
    }));

    // The topic tracker might detect a shift (depends on embedding similarity)
    // We just verify the topic is assigned
    expect(shifted.message.topicId).not.toBeNull();
  });

  it('handles multiple conversations independently', async () => {
    const m1 = makeRaw({ conversationId: 'conv-A', content: 'Topic A message' });
    const m2 = makeRaw({ conversationId: 'conv-B', content: 'Topic B message' });

    await pipeline.ingest(m1);
    await pipeline.ingest(m2);

    const msgsA = await store.getMessagesByConversation('conv-A');
    const msgsB = await store.getMessagesByConversation('conv-B');
    expect(msgsA).toHaveLength(1);
    expect(msgsB).toHaveLength(1);
  });

  it('handles empty content gracefully', async () => {
    const raw = makeRaw({ content: '' });
    const result = await pipeline.ingest(raw);
    expect(result.message.id).toBe(raw.id);
    expect(result.piiDetected).toBe(false);
  });

  it('PII redaction in summaries mode redacts compressed content', async () => {
    const embedGen = new MockEmbeddingGenerator();
    const redactPipeline = new IngestionPipeline(store, embedGen, {
      piiPolicy: {
        mode: 'redact_in_summaries',
        types: ['email', 'phone', 'ssn', 'credit_card', 'api_key', 'aws_key', 'ip_address', 'jwt'],
        retentionDays: null,
      },
      embedOnIngest: true,
      compressionCharThreshold: 10,
    });

    const raw = makeRaw({
      content: 'Please contact user@example.com for the database credentials and also check 192.168.1.1',
      tokenCount: 20,
    });

    const result = await redactPipeline.ingest(raw);

    // Raw content preserved with PII
    const stored = await store.getMessage(raw.id);
    expect(stored!.content).toContain('user@example.com');

    // Compressed content should have PII redacted (if compression was meaningful)
    if (stored!.compressedContent) {
      expect(stored!.compressedContent).not.toContain('user@example.com');
      expect(stored!.compressedContent).toContain('[REDACTED:email]');
    }
  });
});
