// LCM v2 Core — Public API
export type * from './src/types/index.js';
export type { LcmStore, TimeRange } from './src/store/lcm-store.js';
export { SqliteStore } from './src/store/sqlite-store.js';
export type { SqliteStoreOptions } from './src/store/sqlite-store.js';
export { PgStore } from './src/store/pg-store.js';
export type { PgStoreOptions } from './src/store/pg-store.js';
export { createStore } from './src/store/factory.js';
export type { StoreConfig } from './src/store/factory.js';
export { detectPii, redactPii } from './src/ingestion/pii-detector.js';
export { preCompress } from './src/ingestion/pre-compressor.js';
export { detectBoundaries, segmentTopics } from './src/ingestion/topic-segmenter.js';
export type { TopicSegmenterConfig } from './src/ingestion/topic-segmenter.js';
export { MockEmbeddingGenerator } from './src/ingestion/embedding-generator.js';
export type { EmbeddingGenerator } from './src/ingestion/embedding-generator.js';
export { IngestionPipeline, TopicTracker } from './src/ingestion/pipeline.js';
export type { IngestionPipelineConfig } from './src/ingestion/pipeline.js';
export { cosineSimilarity } from './src/util/math.js';

// Secure (VaultClaw governance integration)
export { SecureStore } from './src/secure/secure-store.js';
export type {
  SecureUser, SecureRole, SecureStoreConfig,
  SentinelInspector, AuditLedgerWriter,
  InspectionResult, ThreatFinding, ThreatLevel,
} from './src/secure/secure-store.js';
export { SecureIngestionPipeline } from './src/secure/secure-pipeline.js';
export type { SecureIngestionConfig, SecureIngestionResult } from './src/secure/secure-pipeline.js';
