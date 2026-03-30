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

// Evals (OpenHarness — Karpathy Loop + Hamel Eval gates)
export {
  noPiiInOutput, noCrossTenantLeakage, storeHealthy, noUnsafePatterns,
  scoreInRange, latencyGate, SECURITY_L1_SUITE, runL1Suite,
} from './src/evals/l1-assertions.js';
export type { L1Result, L1SuiteResult, L1Assertion, L1Context } from './src/evals/l1-assertions.js';
export {
  BUILT_IN_JUDGES, runJudge, runL2Suite, validateJudge,
} from './src/evals/l2-judges.js';
export type {
  JudgeResult, L2SuiteResult, LLMScorerFn, JudgeSpec, GoldLabel, JudgeValidationResult,
} from './src/evals/l2-judges.js';
export { EvalHarness } from './src/evals/harness.js';
export type { ExperimentConfig, ExperimentResult, ExperimentLog, HarnessConfig } from './src/evals/harness.js';

// PrivateLaunch (Xcode agent pipeline)
export { generateSpec, mockGenerateSpec } from './src/launch/spec-generator.js';
export type { SpecLLMFn } from './src/launch/spec-generator.js';
export { generateProject } from './src/launch/codegen.js';
export { LaunchPipeline } from './src/launch/pipeline.js';
export type { PipelineConfig } from './src/launch/pipeline.js';
export type {
  AppSpec, FeatureSpec, ScreenSpec, DataModelSpec, DesignSystemSpec,
  PipelineStage, StageResult, PipelineResult,
  AppStoreMetadata, AppStoreCategory, GeneratedFile, GeneratedProject,
} from './src/launch/types.js';

// Secure (VaultClaw governance integration)
export { SecureStore } from './src/secure/secure-store.js';

// AgentFS (governed agent filesystem + swarm orchestration)
export { AgentFSStore } from './src/agentfs/store.js';
export { GovernedSwarm } from './src/agentfs/swarm.js';
export { HookRegistry, createSentinelHook, createL1EvalHook } from './src/agentfs/hooks.js';
export type {
  SwarmEvent, SwarmHook, HookContext, HookResult, HookFireResult, HookResultEntry,
} from './src/agentfs/hooks.js';
export type {
  AgentFSConfig, AgentInode, AgentDentry, AgentKVEntry, AgentToolCall,
  SwarmConfig, SwarmAgent, SwarmTask, SwarmMessage, SwarmRole,
  TaskStatus, PlanStatus,
  TaskEvalResult, GovernedWrite, AgentSnapshot,
} from './src/agentfs/types.js';
export type {
  SecureUser, SecureRole, SecureStoreConfig,
  SentinelInspector, AuditLedgerWriter,
  InspectionResult, ThreatFinding, ThreatLevel,
} from './src/secure/secure-store.js';
export { SecureIngestionPipeline } from './src/secure/secure-pipeline.js';
export type { SecureIngestionConfig, SecureIngestionResult } from './src/secure/secure-pipeline.js';
