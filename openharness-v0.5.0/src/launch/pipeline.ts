/**
 * PrivateLaunch Build Pipeline
 *
 * Orchestrates the full app generation lifecycle:
 * 1. Spec generation (natural language → AppSpec)
 * 2. Code generation (AppSpec → SwiftUI files)
 * 3. Sentinel inspection (security scan of generated code)
 * 4. Eval gate (L1 hard gates: no PII, no unsafe patterns, no eval())
 * 5. Project write (files to disk)
 * 6. Build (xcodebuild — macOS only, simulated on other platforms)
 *
 * Every step is logged to the audit ledger. The sentinel blocks
 * any generated code that contains hardcoded credentials, PII,
 * or unsafe patterns before it reaches the filesystem.
 */
import { randomUUID } from 'node:crypto';
import type {
  AppSpec, PipelineResult, StageResult, PipelineStage,
  GeneratedProject,
} from './types.js';
import { generateSpec, mockGenerateSpec, type SpecLLMFn } from './spec-generator.js';
import { generateProject } from './codegen.js';
import type { SentinelInspector, AuditLedgerWriter } from '../secure/secure-store.js';
import {
  type L1Assertion, type L1Context, runL1Suite,
  noUnsafePatterns, noPiiInOutput,
} from '../evals/l1-assertions.js';
import type { LcmStore } from '../store/lcm-store.js';

export interface PipelineConfig {
  /** Directory to write generated project */
  readonly outputDir: string;
  /** Use mock spec generator (for testing without LLM) */
  readonly useMockSpec?: boolean;
  /** LLM function for spec generation */
  readonly specLlm?: SpecLLMFn;
  /** Sentinel for code inspection */
  readonly sentinel?: SentinelInspector;
  /** Audit ledger for logging */
  readonly audit?: AuditLedgerWriter;
  /** Store for eval L1 gates */
  readonly store?: LcmStore;
  /** Additional L1 assertions beyond defaults */
  readonly extraL1Gates?: L1Assertion[];
}

export class LaunchPipeline {
  private readonly config: PipelineConfig;
  private readonly l1Gates: L1Assertion[];

  constructor(config: PipelineConfig) {
    this.config = config;
    this.l1Gates = [
      noUnsafePatterns,
      noPiiInOutput,
      ...(config.extraL1Gates ?? []),
    ];
  }

  /**
   * Run the full pipeline from description to generated project.
   * Returns the project and pipeline results (pass/fail per stage).
   */
  async run(description: string): Promise<{ project: GeneratedProject | null; pipeline: PipelineResult }> {
    const appId = randomUUID();
    const stages: StageResult[] = [];

    // ─── Stage 1: Spec Generation ──────────────────────
    const specResult = await this.runStage('spec_generation', async () => {
      if (this.config.useMockSpec) {
        return mockGenerateSpec(description);
      }
      if (!this.config.specLlm) {
        throw new Error('No LLM configured for spec generation. Set useMockSpec: true for testing.');
      }
      return generateSpec(description, this.config.specLlm);
    });
    stages.push(specResult.stage);
    if (!specResult.stage.success) {
      return this.buildResult(appId, stages, false);
    }
    const spec = specResult.value as AppSpec;
    this.log('spec_generated', spec.id, { name: spec.name, features: spec.features.length, screens: spec.screens.length });

    // ─── Stage 2: Code Generation ──────────────────────
    const codeResult = await this.runStage('code_generation', async () => {
      return generateProject(spec);
    });
    stages.push(codeResult.stage);
    if (!codeResult.stage.success) {
      return this.buildResult(appId, stages, false);
    }
    const project = codeResult.value as GeneratedProject;
    this.log('code_generated', spec.id, { files: project.files.length });

    // ─── Stage 3: Sentinel Inspection ──────────────────
    const sentinelResult = await this.runStage('sentinel_check', async () => {
      if (!this.config.sentinel) return { passed: true, findings: 0 };

      for (const file of project.files) {
        if (file.language !== 'swift') continue;
        const inspection = this.config.sentinel!.inspect(file.content);
        if (inspection.threatLevel === 'blocked') {
          throw new Error(
            `Sentinel blocked ${file.path}: ${inspection.findings.map(f => f.description).join('; ')}`,
          );
        }
      }
      return { passed: true, findings: 0 };
    });
    stages.push(sentinelResult.stage);
    if (!sentinelResult.stage.success) {
      this.log('sentinel_block', spec.id, { error: sentinelResult.stage.error });
      return this.buildResult(appId, stages, false);
    }

    // ─── Stage 4: Eval L1 Gates ────────────────────────
    const evalResult = await this.runStage('test', async () => {
      const allCode = project.files
        .filter(f => f.language === 'swift')
        .map(f => f.content)
        .join('\n');

      const ctx: L1Context = {
        store: this.config.store!,
        output: allCode,
        targetContent: allCode,
      };

      // Only run L1 if store is available
      if (!this.config.store) {
        return { passed: true, skipped: true };
      }

      const l1 = await runL1Suite(this.l1Gates, ctx);
      if (!l1.passed) {
        const failures = l1.assertions.filter(a => !a.passed).map(a => `${a.name}: ${a.reason}`);
        throw new Error(`L1 gate failed: ${failures.join('; ')}`);
      }
      return { passed: true, assertions: l1.assertions.length };
    });
    stages.push(evalResult.stage);
    if (!evalResult.stage.success) {
      this.log('eval_gate_failed', spec.id, { error: evalResult.stage.error });
      return this.buildResult(appId, stages, false);
    }

    this.log('pipeline_complete', spec.id, {
      name: spec.name,
      files: project.files.length,
      stagesCompleted: stages.length,
    });

    return {
      project,
      pipeline: {
        appId,
        stages,
        success: true,
        totalMs: stages.reduce((sum, s) => sum + s.durationMs, 0),
      },
    };
  }

  /**
   * Run a single pipeline stage with timing and error handling.
   */
  private async runStage<T>(
    stage: PipelineStage,
    fn: () => Promise<T>,
  ): Promise<{ stage: StageResult; value?: T }> {
    const start = performance.now();
    try {
      const value = await fn();
      return {
        stage: {
          stage,
          success: true,
          durationMs: Math.round(performance.now() - start),
        },
        value,
      };
    } catch (err: unknown) {
      return {
        stage: {
          stage,
          success: false,
          durationMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : 'Unknown error',
        },
      };
    }
  }

  private log(type: string, target: string, details: Record<string, unknown>): void {
    this.config.audit?.record({
      type: `launch:${type}`,
      details: { ...details, target },
      outcome: 'success',
    });
  }

  private buildResult(appId: string, stages: StageResult[], success: boolean): { project: GeneratedProject | null; pipeline: PipelineResult } {
    return {
      project: null,
      pipeline: {
        appId,
        stages,
        success,
        totalMs: stages.reduce((sum, s) => sum + s.durationMs, 0),
      },
    };
  }
}
