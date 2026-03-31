/**
 * Ingestion Pipeline — transforms raw messages into enriched messages.
 *
 * Pipeline stages:
 * 1. PII Detection → annotations stored as metadata
 * 2. Pre-Compression → compressed version for summarization input
 * 3. Topic Assignment → assigns topic_id based on segmenter state
 * 4. Embedding Generation → vector for similarity search
 * 5. Persistence → store enriched message + embedding
 *
 * Critical invariant: the immutable store ALWAYS contains the raw,
 * unmodified message content. Enrichments are metadata overlays.
 */
import { randomUUID } from 'node:crypto';
import type {
  RawMessage,
  EnrichedMessage,
  IngestionResult,
  PiiPolicy,
  PiiAnnotation,
} from '../types/index.js';
import type { LcmStore } from '../store/lcm-store.js';
import type { EmbeddingGenerator } from './embedding-generator.js';
import { cosineSimilarity as cosineSim } from '../util/math.js';
import { detectPii, redactPii } from './pii-detector.js';
import { preCompress } from './pre-compressor.js';

export interface IngestionPipelineConfig {
  piiPolicy: PiiPolicy;
  /** Generate embeddings on ingest (can be deferred for async) */
  embedOnIngest: boolean;
  /** Minimum character count for pre-compression to activate (not tokens) */
  compressionCharThreshold: number;
}

export const DEFAULT_INGESTION_CONFIG: IngestionPipelineConfig = {
  piiPolicy: {
    mode: 'annotate',
    types: ['email', 'phone', 'ssn', 'credit_card', 'api_key', 'aws_key', 'ip_address', 'jwt'],
    retentionDays: null,
  },
  embedOnIngest: true,
  compressionCharThreshold: 200, // only compress messages > 200 characters
};

/**
 * Tracks the current topic state for incremental segmentation.
 * Full re-segmentation happens during compaction; this provides
 * a running topic assignment for incoming messages.
 */
export class TopicTracker {
  private currentTopicId: string;
  private currentTopicLabel: string;
  private lastEmbedding: Float64Array | null = null;
  private messageCount = 0;
  private similarityThreshold: number;

  constructor(similarityThreshold = 0.7) {
    this.currentTopicId = randomUUID();
    this.currentTopicLabel = 'topic-0';
    this.similarityThreshold = similarityThreshold;
  }

  /**
   * Update topic assignment for a new message.
   * Returns true if topic changed.
   */
  async update(
    embedding: Float64Array,
  ): Promise<{ topicId: string; topicLabel: string; changed: boolean }> {
    this.messageCount++;

    if (this.lastEmbedding === null) {
      this.lastEmbedding = embedding;
      return {
        topicId: this.currentTopicId,
        topicLabel: this.currentTopicLabel,
        changed: false,
      };
    }

    const sim = cosineSim(this.lastEmbedding, embedding);
    this.lastEmbedding = embedding;

    if (sim < this.similarityThreshold && this.messageCount > 2) {
      // Topic shift detected
      this.currentTopicId = randomUUID();
      this.currentTopicLabel = `topic-${this.messageCount}`;
      this.messageCount = 0;
      return {
        topicId: this.currentTopicId,
        topicLabel: this.currentTopicLabel,
        changed: true,
      };
    }

    return {
      topicId: this.currentTopicId,
      topicLabel: this.currentTopicLabel,
      changed: false,
    };
  }

  getCurrentTopic(): { topicId: string; topicLabel: string } {
    return { topicId: this.currentTopicId, topicLabel: this.currentTopicLabel };
  }
}

export class IngestionPipeline {
  private store: LcmStore;
  private embedGen: EmbeddingGenerator;
  private config: IngestionPipelineConfig;
  private topicTrackers: Map<string, TopicTracker> = new Map();

  constructor(
    store: LcmStore,
    embedGen: EmbeddingGenerator,
    config: IngestionPipelineConfig = DEFAULT_INGESTION_CONFIG,
  ) {
    this.store = store;
    this.embedGen = embedGen;
    this.config = config;
  }

  /**
   * Ingest a raw message through the full pipeline.
   */
  async ingest(raw: RawMessage): Promise<IngestionResult> {
    // Stage 1: PII Detection
    const piiAnnotations = this.detectPiiFiltered(raw.content);
    const piiDetected = piiAnnotations.length > 0;

    // Stage 2: Pre-Compression
    let compressedContent: string | null = null;
    let compressedTokenCount: number | null = null;

    if (raw.content.length >= this.config.compressionCharThreshold) {
      const compressed = preCompress(raw.content);
      if (compressed.compressionRatio > 1.1) {
        // Only store compressed if meaningfully smaller
        compressedContent = compressed.compressed;
        // Rough token estimate: chars / 4
        compressedTokenCount = Math.ceil(compressed.compressedLength / 4);

        // If policy says redact PII in summaries, redact in compressed version
        if (this.config.piiPolicy.mode === 'redact_in_summaries' && piiAnnotations.length > 0) {
          compressedContent = redactPii(compressedContent, detectPii(compressedContent));
        }
      }
    }

    // Stage 3: Topic Assignment
    let topicId: string | null = null;
    let topicLabel: string | null = null;
    let topicChanged = false;

    let embedding: Float64Array | null = null;

    if (this.config.embedOnIngest) {
      embedding = await this.embedGen.embed(raw.content);

      if (embedding !== null) {
        // Get or create topic tracker for this conversation
        let tracker = this.topicTrackers.get(raw.conversationId);
        if (!tracker) {
          tracker = new TopicTracker();
          this.topicTrackers.set(raw.conversationId, tracker);
        }

        const topicResult = await tracker.update(embedding);
        topicId = topicResult.topicId;
        topicLabel = topicResult.topicLabel;
        topicChanged = topicResult.changed;
      }
    }

    // Build enriched message
    const enriched: EnrichedMessage = {
      ...raw,
      pii: piiAnnotations,
      topicId,
      topicLabel,
      compressedContent,
      compressedTokenCount,
    };

    // Stage 4: Persist to store
    await this.store.persistMessage(enriched);

    // Stage 5: Persist embedding (async-safe, non-blocking)
    let embeddingGenerated = false;
    if (embedding) {
      try {
        await this.store.upsertEmbedding({
          id: randomUUID(),
          entityType: 'message',
          entityId: raw.id,
          vector: embedding,
          model: this.embedGen.modelName,
          createdAt: new Date().toISOString(),
        });
        embeddingGenerated = true;
      } catch {
        // Embedding persistence failure is non-fatal
      }
    }

    // Stage 6: Audit trail
    await this.store.appendAudit({
      actor: 'system',
      action: 'message_persisted',
      targetType: 'message',
      targetId: raw.id,
      conversationId: raw.conversationId,
      metadata: {
        piiDetected,
        piiTypes: piiAnnotations.map((a) => a.type),
        compressed: compressedContent !== null,
        topicChanged,
      },
    });

    return {
      message: enriched,
      piiDetected,
      topicChanged,
      embeddingGenerated,
    };
  }

  /**
   * Filter PII detections to only configured types.
   */
  private detectPiiFiltered(text: string): PiiAnnotation[] {
    const all = detectPii(text);
    return all.filter((a) => this.config.piiPolicy.types.includes(a.type));
  }
}
