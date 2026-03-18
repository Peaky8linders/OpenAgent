/**
 * SecureIngestionPipeline — wraps LCM's IngestionPipeline with sentinel
 * pre-inspection. Content is scanned BEFORE it enters the pipeline.
 *
 * This closes the gap identified in the OpenClaw analysis: tool results
 * and external content must be treated as untrusted before they reach
 * the agent's memory or context.
 */
import { randomUUID } from 'node:crypto';
import type { RawMessage, IngestionResult, PiiAnnotation } from '../types/index.js';
import { IngestionPipeline, type IngestionPipelineConfig, DEFAULT_INGESTION_CONFIG } from '../ingestion/pipeline.js';
import type { EmbeddingGenerator } from '../ingestion/embedding-generator.js';
import type { LcmStore } from '../store/lcm-store.js';
import type { SentinelInspector, AuditLedgerWriter } from './secure-store.js';
import { detectPii } from '../ingestion/pii-detector.js';

export interface SecureIngestionConfig extends IngestionPipelineConfig {
  /** Block messages that sentinel flags (default: true) */
  blockOnThreat: boolean;
  /** Run dual PII detection: LCM regex + VaultClaw PHI patterns (default: true) */
  dualPiiDetection: boolean;
}

export const DEFAULT_SECURE_INGESTION_CONFIG: SecureIngestionConfig = {
  ...DEFAULT_INGESTION_CONFIG,
  blockOnThreat: true,
  dualPiiDetection: true,
};

export interface SecureIngestionResult extends IngestionResult {
  sentinelCleared: boolean;
  sentinelFindings: number;
  blockedReason?: string;
}

export class SecureIngestionPipeline {
  private readonly inner: IngestionPipeline;
  private readonly sentinel: SentinelInspector | null;
  private readonly audit: AuditLedgerWriter | null;
  private readonly config: SecureIngestionConfig;

  constructor(
    store: LcmStore,
    embedGen: EmbeddingGenerator,
    sentinel: SentinelInspector | null,
    audit: AuditLedgerWriter | null,
    config: Partial<SecureIngestionConfig> = {},
  ) {
    this.config = { ...DEFAULT_SECURE_INGESTION_CONFIG, ...config };
    this.inner = new IngestionPipeline(store, embedGen, this.config);
    this.sentinel = sentinel;
    this.audit = audit;
  }

  /**
   * Securely ingest a message:
   * 1. Sentinel inspection (block injection/exfiltration)
   * 2. LCM ingestion pipeline (PII detect → compress → topic → embed → store)
   * 3. Audit logging
   */
  async ingest(raw: RawMessage): Promise<SecureIngestionResult> {
    // Stage 0: Sentinel pre-inspection
    if (this.sentinel) {
      const inspection = this.sentinel.inspect(raw.content);

      if (inspection.threatLevel === 'blocked' || (inspection.threatLevel === 'suspicious' && this.config.blockOnThreat)) {
        const reason = inspection.findings.map(f => f.description).join('; ');

        this.audit?.record({
          type: 'sentinel_block',
          details: {
            messageId: raw.id,
            conversationId: raw.conversationId,
            findings: inspection.findings.map(f => f.category),
            reason,
          },
          outcome: 'blocked',
        });

        // Return a rejection result without persisting
        const rejectedMessage = {
          ...raw,
          pii: [] as PiiAnnotation[],
          topicId: null,
          topicLabel: null,
          compressedContent: null,
          compressedTokenCount: null,
        };

        return {
          message: rejectedMessage,
          piiDetected: false,
          topicChanged: false,
          embeddingGenerated: false,
          sentinelCleared: false,
          sentinelFindings: inspection.findings.length,
          blockedReason: reason,
        };
      }

      // Content cleared sentinel - log it
      if (inspection.findings.length > 0) {
        this.audit?.record({
          type: 'sentinel_flag',
          details: {
            messageId: raw.id,
            findings: inspection.findings.map(f => ({ category: f.category, confidence: f.confidence })),
          },
          outcome: 'success',
        });
      }
    }

    // Stage 1-6: LCM ingestion pipeline
    const result = await this.inner.ingest(raw);

    // Dual PII detection: check if VaultClaw's broader PHI patterns find anything
    // that LCM's regex-only detector missed
    if (this.config.dualPiiDetection && this.sentinel) {
      const vaultInspection = this.sentinel.inspect(raw.content);
      const phiFindings = vaultInspection.findings.filter(
        f => f.category === 'phi_exposure' || f.category === 'pii_exposure',
      );
      if (phiFindings.length > 0 && result.message.pii.length === 0) {
        // VaultClaw found PHI/PII that LCM missed — log for compliance review
        this.audit?.record({
          type: 'phi_detection_delta',
          details: {
            messageId: raw.id,
            lcmPiiCount: result.message.pii.length,
            vaultClawPiiCount: phiFindings.length,
            vaultClawFindings: phiFindings.map(f => f.category),
          },
          outcome: 'success',
        });
      }
    }

    return {
      ...result,
      sentinelCleared: true,
      sentinelFindings: 0,
    };
  }
}
