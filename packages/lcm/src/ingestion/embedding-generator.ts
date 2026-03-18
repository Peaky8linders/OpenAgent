/**
 * Embedding Generator — interface for producing vector embeddings.
 *
 * Production: calls sentence-transformers API (all-MiniLM-L6-v2) or similar.
 * Prototype/test: deterministic hash-based mock that produces stable embeddings
 * with the property that semantically similar text produces similar vectors.
 */

export interface EmbeddingGenerator {
  /** Generate an embedding vector for the given text. */
  embed(text: string): Promise<Float64Array>;

  /** Embedding dimensionality. */
  readonly dimensions: number;

  /** Model identifier for provenance tracking. */
  readonly modelName: string;
}

/**
 * Mock embedding generator for tests and prototype use.
 *
 * Produces deterministic 64-dimensional vectors from text content.
 * Uses character frequency distribution as a simple "semantic" signal —
 * texts with similar character distributions produce similar vectors.
 * Not suitable for production retrieval quality, but sufficient for
 * testing pipeline wiring and similarity search mechanics.
 */
export class MockEmbeddingGenerator implements EmbeddingGenerator {
  readonly dimensions = 64;
  readonly modelName = 'mock-char-freq-64d';

  async embed(text: string): Promise<Float64Array> {
    const vec = new Float64Array(this.dimensions);
    const lower = text.toLowerCase();

    // Character frequency in 26 buckets (a-z)
    for (let i = 0; i < lower.length; i++) {
      const code = lower.charCodeAt(i);
      if (code >= 97 && code <= 122) {
        vec[code - 97] += 1;
      }
    }

    // Bigram frequency in next 26 buckets
    for (let i = 0; i < lower.length - 1; i++) {
      const c1 = lower.charCodeAt(i) - 97;
      const c2 = lower.charCodeAt(i + 1) - 97;
      if (c1 >= 0 && c1 < 26 && c2 >= 0 && c2 < 26) {
        vec[26 + ((c1 + c2) % 26)] += 1;
      }
    }

    // Word count features in remaining buckets
    const words = text.split(/\s+/).filter(Boolean);
    vec[52] = words.length;
    vec[53] = text.length;
    vec[54] = words.length > 0 ? text.length / words.length : 0; // avg word length
    vec[55] = (text.match(/[.!?]/g) || []).length; // sentence count proxy

    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }
}
