import { describe, it, expect } from 'vitest';
import { detectBoundaries } from '../src/ingestion/topic-segmenter.js';
import { MockEmbeddingGenerator } from '../src/ingestion/embedding-generator.js';

describe('MockEmbeddingGenerator', () => {
  const gen = new MockEmbeddingGenerator();

  it('produces vectors of correct dimensionality', async () => {
    const vec = await gen.embed('Hello world');
    expect(vec.length).toBe(64);
  });

  it('produces unit vectors', async () => {
    const vec = await gen.embed('Test input text');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });

  it('produces similar vectors for similar text', async () => {
    const v1 = await gen.embed('The database migration was completed successfully');
    const v2 = await gen.embed('The database migration completed with success');
    const v3 = await gen.embed('Weather forecast shows rain tomorrow afternoon');

    const sim12 = cosine(v1, v2);
    const sim13 = cosine(v1, v3);
    expect(sim12).toBeGreaterThan(sim13);
  });

  it('produces deterministic results', async () => {
    const v1 = await gen.embed('Same input');
    const v2 = await gen.embed('Same input');
    expect(Array.from(v1)).toEqual(Array.from(v2));
  });

  it('handles empty string', async () => {
    const vec = await gen.embed('');
    expect(vec.length).toBe(64);
    // All zeros normalized = still zeros
    for (let i = 0; i < vec.length; i++) {
      expect(vec[i]).toBe(0);
    }
  });
});

describe('Topic Boundary Detection', () => {
  it('returns no boundaries for too-few messages', () => {
    const embeddings = [
      new Float64Array([1, 0, 0]),
      new Float64Array([1, 0, 0]),
    ];
    const boundaries = detectBoundaries(embeddings, {
      windowSize: 3,
      boundaryThreshold: 0.3,
      minSegmentSize: 2,
    });
    expect(boundaries).toHaveLength(0);
  });

  it('detects a clear topic shift', () => {
    // 6 messages about topic A, then 6 about topic B
    const topicA = new Float64Array([1, 0, 0, 0]);
    const topicB = new Float64Array([0, 0, 1, 0]);

    const embeddings = [
      topicA, topicA, topicA, topicA, topicA, topicA,
      topicB, topicB, topicB, topicB, topicB, topicB,
    ];

    const boundaries = detectBoundaries(embeddings, {
      windowSize: 3,
      boundaryThreshold: 0.3,
      minSegmentSize: 2,
    });

    expect(boundaries.length).toBeGreaterThanOrEqual(1);
    // Boundary should be near index 6 (the transition point)
    const nearTransition = boundaries.some((b) => b >= 4 && b <= 8);
    expect(nearTransition).toBe(true);
  });

  it('returns no boundaries for uniform topics', () => {
    const same = new Float64Array([1, 0, 0, 0]);
    const embeddings = Array(12).fill(same);

    const boundaries = detectBoundaries(embeddings, {
      windowSize: 3,
      boundaryThreshold: 0.3,
      minSegmentSize: 2,
    });

    expect(boundaries).toHaveLength(0);
  });

  it('respects minSegmentSize', () => {
    const topicA = new Float64Array([1, 0, 0, 0]);
    const topicB = new Float64Array([0, 0, 1, 0]);

    // Rapid alternation: should not create micro-segments
    const embeddings = [
      topicA, topicA, topicA, topicB, topicA, topicA,
      topicA, topicA, topicA, topicA, topicA, topicA,
    ];

    const boundaries = detectBoundaries(embeddings, {
      windowSize: 2,
      boundaryThreshold: 0.3,
      minSegmentSize: 4, // high min prevents frequent boundaries
    });

    // Should have at most 1 boundary due to high minSegmentSize
    expect(boundaries.length).toBeLessThanOrEqual(1);
  });
});

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const d = Math.sqrt(nA) * Math.sqrt(nB);
  return d === 0 ? 0 : dot / d;
}
