/**
 * OpenHarness Eval Harness — Orchestrates all eval levels.
 *
 * Fuses Karpathy's experiment loop with Hamel's eval gates:
 *   L1: Fast deterministic assertions (hard gate)
 *   L2: LLM binary judges per failure mode (soft gate with threshold)
 *   Composite: ALL L1 must pass + L2 pass rate >= threshold + primary metric must improve
 *
 * This file is READ-ONLY to the autonomous agent.
 * The agent cannot modify eval infrastructure.
 */
import type { LcmStore } from '../store/lcm-store.js';
import {
  type L1Assertion, type L1Context, type L1SuiteResult,
  SECURITY_L1_SUITE, runL1Suite,
} from './l1-assertions.js';
import {
  type JudgeSpec, type LLMScorerFn, type L2SuiteResult,
  BUILT_IN_JUDGES, runL2Suite,
} from './l2-judges.js';

// ─── Experiment Types ────────────────────────────────────────────

export interface ExperimentConfig {
  /** Unique experiment ID */
  readonly id: string;
  /** Human-readable hypothesis */
  readonly hypothesis: string;
  /** The file the agent modified */
  readonly targetFile: string;
  /** Maximum time budget in ms */
  readonly timeBudgetMs: number;
  /** Primary metric name (e.g., 'spearman_rho', 'recall_at_10') */
  readonly primaryMetricName: string;
  /** Baseline value of primary metric (must improve to commit) */
  readonly baselineMetric: number;
  /** L2 required pass rate (default 0.85) */
  readonly l2PassRate?: number;
}

export interface ExperimentResult {
  readonly experimentId: string;
  readonly hypothesis: string;
  readonly timestamp: string;

  // Gate results
  readonly l1: L1SuiteResult;
  readonly l2: L2SuiteResult | null; // null if L1 failed (short-circuit)
  readonly primaryMetric: number;
  readonly baselineMetric: number;
  readonly metricImproved: boolean;

  // Composite decision
  readonly allGatesPassed: boolean;
  readonly decision: 'commit' | 'revert';
  readonly revertReason?: string;

  // Timing
  readonly totalMs: number;
  readonly withinBudget: boolean;
}

export interface ExperimentLog {
  readonly experimentId: string;
  readonly timestamp: string;
  readonly hypothesis: string;
  readonly targetFile: string;
  readonly diff?: string;
  readonly result: ExperimentResult;
}

// ─── Harness ─────────────────────────────────────────────────────

export interface HarnessConfig {
  /** L1 assertions to run (default: security suite) */
  readonly l1Assertions?: L1Assertion[];
  /** L2 judge specs (default: built-in judges) */
  readonly l2Judges?: JudgeSpec[];
  /** LLM scorer function for L2 judges */
  readonly scorer?: LLMScorerFn;
  /** Store instance for L1 checks */
  readonly store: LcmStore;
  /** Append-only log writer */
  readonly logWriter?: (entry: ExperimentLog) => void;
}

export class EvalHarness {
  private readonly l1Assertions: L1Assertion[];
  private readonly l2Judges: JudgeSpec[];
  private readonly scorer: LLMScorerFn | null;
  private readonly store: LcmStore;
  private readonly logWriter: ((entry: ExperimentLog) => void) | null;

  constructor(config: HarnessConfig) {
    this.l1Assertions = config.l1Assertions ?? SECURITY_L1_SUITE;
    this.l2Judges = config.l2Judges ?? BUILT_IN_JUDGES;
    this.scorer = config.scorer ?? null;
    this.store = config.store;
    this.logWriter = config.logWriter ?? null;
  }

  /**
   * Run the full evaluation pipeline for an experiment.
   *
   * Order:
   * 1. L1 assertions (hard gate — any fail = revert)
   * 2. L2 judges (soft gate — pass rate must meet threshold)
   * 3. Primary metric comparison (must improve)
   * 4. Time budget check
   *
   * Short-circuits: if L1 fails, L2 is skipped.
   */
  async evaluate(
    config: ExperimentConfig,
    input: { output: string; targetContent?: string; primaryMetric: number },
    l2Variables?: { input: string; output: string; context: string },
  ): Promise<ExperimentResult> {
    const start = performance.now();
    const timestamp = new Date().toISOString();

    // ─── L1: Hard Gate ─────────────────────────────────
    const l1Ctx: L1Context = {
      store: this.store,
      output: input.output,
      targetContent: input.targetContent,
    };
    const l1 = await runL1Suite(this.l1Assertions, l1Ctx);

    if (!l1.passed) {
      const result = this.buildResult(config, timestamp, l1, null, input.primaryMetric, start,
        `L1 gate failed: ${l1.assertions.filter(a => !a.passed).map(a => a.name).join(', ')}`);
      this.log(config, result);
      return result;
    }

    // ─── L2: Soft Gate ─────────────────────────────────
    let l2: L2SuiteResult | null = null;
    if (this.scorer && l2Variables) {
      l2 = await runL2Suite(
        this.l2Judges,
        this.scorer,
        l2Variables,
        config.l2PassRate ?? 0.85,
      );

      if (!l2.passed) {
        const failedJudges = l2.judges.filter(j => !j.passed).map(j => j.judgeName);
        const result = this.buildResult(config, timestamp, l1, l2, input.primaryMetric, start,
          `L2 gate failed (${l2.passRate.toFixed(2)} < ${config.l2PassRate ?? 0.85}): ${failedJudges.join(', ')}`);
        this.log(config, result);
        return result;
      }
    }

    // ─── Primary Metric Gate ───────────────────────────
    const metricImproved = input.primaryMetric > config.baselineMetric;
    if (!metricImproved) {
      const result = this.buildResult(config, timestamp, l1, l2, input.primaryMetric, start,
        `Primary metric did not improve: ${input.primaryMetric} <= ${config.baselineMetric}`);
      this.log(config, result);
      return result;
    }

    // ─── All Gates Passed ──────────────────────────────
    const result = this.buildResult(config, timestamp, l1, l2, input.primaryMetric, start);
    this.log(config, result);
    return result;
  }

  private buildResult(
    config: ExperimentConfig,
    timestamp: string,
    l1: L1SuiteResult,
    l2: L2SuiteResult | null,
    primaryMetric: number,
    startTime: number,
    revertReason?: string,
  ): ExperimentResult {
    const totalMs = Math.round(performance.now() - startTime);
    const metricImproved = primaryMetric > config.baselineMetric;
    const allGatesPassed = l1.passed && (l2?.passed ?? true) && metricImproved;

    return {
      experimentId: config.id,
      hypothesis: config.hypothesis,
      timestamp,
      l1,
      l2,
      primaryMetric,
      baselineMetric: config.baselineMetric,
      metricImproved,
      allGatesPassed,
      decision: allGatesPassed ? 'commit' : 'revert',
      revertReason,
      totalMs,
      withinBudget: totalMs <= config.timeBudgetMs,
    };
  }

  private log(config: ExperimentConfig, result: ExperimentResult): void {
    if (!this.logWriter) return;
    this.logWriter({
      experimentId: config.id,
      timestamp: result.timestamp,
      hypothesis: config.hypothesis,
      targetFile: config.targetFile,
      result,
    });
  }
}
