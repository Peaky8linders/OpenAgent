/**
 * Topic Segmenter — detects topic boundaries in message sequences.
 *
 * Uses cosine discontinuity between adjacent message groups.
 * A sharp drop in similarity between consecutive windows indicates
 * a topic shift. Zero LLM calls — fully deterministic.
 *
 * Production enhancement: LLM-based label generation for each segment.
 */
import { randomUUID } from 'node:crypto';
import type { RawMessage, TopicSegment } from '../types/index.js';
import type { EmbeddingGenerator } from './embedding-generator.js';

export interface TopicSegmenterConfig {
  /** Number of messages per sliding window for similarity computation */
  windowSize: number;
  /** Cosine similarity drop threshold to detect a boundary (0.0-1.0) */
  boundaryThreshold: number;
  /** Minimum messages per segment (prevents micro-segments) */
  minSegmentSize: number;
}

export const DEFAULT_SEGMENTER_CONFIG: TopicSegmenterConfig = {
  windowSize: 3,
  boundaryThreshold: 0.3,
  minSegmentSize: 2,
};

import { cosineSimilarity } from '../util/math.js';

/**
 * Compute mean embedding for a window of messages.
 */
function meanEmbedding(embeddings: Float64Array[]): Float64Array {
  if (embeddings.length === 0) return new Float64Array(0);
  const dim = embeddings[0].length;
  const result = new Float64Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    result[i] /= embeddings.length;
  }
  return result;
}

/**
 * Detect topic boundaries in a sequence of messages.
 * Returns boundary indices (positions where new topics start).
 */
export function detectBoundaries(
  embeddings: Float64Array[],
  config: TopicSegmenterConfig = DEFAULT_SEGMENTER_CONFIG,
): number[] {
  const { windowSize, boundaryThreshold, minSegmentSize } = config;

  if (embeddings.length < windowSize * 2) return []; // too few messages

  const boundaries: number[] = [];
  let lastBoundary = 0;

  for (let i = windowSize; i <= embeddings.length - windowSize; i++) {
    const before = embeddings.slice(i - windowSize, i);
    const after = embeddings.slice(i, i + windowSize);

    const meanBefore = meanEmbedding(before);
    const meanAfter = meanEmbedding(after);
    const sim = cosineSimilarity(meanBefore, meanAfter);

    // A low similarity indicates a topic shift
    if (sim < (1 - boundaryThreshold) && (i - lastBoundary) >= minSegmentSize) {
      boundaries.push(i);
      lastBoundary = i;
    }
  }

  return boundaries;
}

/**
 * Segment messages into topic groups using embedding discontinuity.
 */
export async function segmentTopics(
  messages: RawMessage[],
  embeddingGen: EmbeddingGenerator,
  config: TopicSegmenterConfig = DEFAULT_SEGMENTER_CONFIG,
): Promise<TopicSegment[]> {
  if (messages.length === 0) return [];

  // Generate embeddings for all messages
  const embeddings = await Promise.all(
    messages.map((m) => embeddingGen.embed(m.content))
  );

  // Detect boundaries
  const boundaries = detectBoundaries(embeddings, config);

  // Build segments from boundaries
  const segments: TopicSegment[] = [];
  const splitPoints = [0, ...boundaries, messages.length];

  for (let i = 0; i < splitPoints.length - 1; i++) {
    const start = splitPoints[i];
    const end = splitPoints[i + 1];
    const segmentMessages = messages.slice(start, end);

    if (segmentMessages.length === 0) continue;

    const tokenCount = segmentMessages.reduce((sum, m) => sum + m.tokenCount, 0);

    segments.push({
      topicId: randomUUID(),
      topicLabel: `topic-${i}`, // Placeholder; production would use LLM for labels
      messages: segmentMessages,
      tokenCount,
      startTime: segmentMessages[0].createdAt,
      endTime: segmentMessages[segmentMessages.length - 1].createdAt,
    });
  }

  return segments;
}
