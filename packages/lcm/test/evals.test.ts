/**
 * Tests for OpenHarness eval system (L1 assertions, L2 judges, harness).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteStore } from '../src/store/sqlite-store.js';
import {
  noPiiInOutput, noCrossTenantLeakage, storeHealthy, noUnsafePatterns,
  scoreInRange, SECURITY_L1_SUITE, runL1Suite, type L1Context,
} from '../src/evals/l1-assertions.js';
import {
  BUILT_IN_JUDGES, runJudge, runL2Suite, validateJudge,
  type LLMScorerFn, type GoldLabel,
} from '../src/evals/l2-judges.js';
import { EvalHarness, type ExperimentConfig } from '../src/evals/harness.js';
import { randomUUID } from 'node:crypto';

// ─── L1 Tests ────────────────────────────────────────────────────

describe('L1 Assertions', () => {
  let store: SqliteStore;
  beforeEach(async () => {
    store = new SqliteStore({ path: ':memory:' });
    await store.initialize();
  });

  it('noPiiInOutput passes for clean content', async () => {
    const result = await noPiiInOutput({ store, output: 'The meeting is scheduled for 2pm.' });
    expect(result.passed).toBe(true);
  });

  it('noPiiInOutput fails for content with SSN', async () => {
    const result = await noPiiInOutput({ store, output: 'Your SSN is 123-45-6789.' });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('ssn');
  });

  it('noPiiInOutput fails for content with email', async () => {
    const result = await noPiiInOutput({ store, output: 'Contact john@example.com for details.' });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('email');
  });

  it('storeHealthy passes for initialized store', async () => {
    const result = await storeHealthy({ store });
    expect(result.passed).toBe(true);
  });

  it('noUnsafePatterns passes for clean code', async () => {
    const result = await noUnsafePatterns({
      store,
      targetContent: 'const x: string = "hello";\nfunction add(a: number, b: number) { return a + b; }',
    });
    expect(result.passed).toBe(true);
  });

  it('noUnsafePatterns fails for eval()', async () => {
    const result = await noUnsafePatterns({
      store,
      targetContent: 'const result = eval("2 + 2");',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('eval');
  });

  it('noUnsafePatterns fails for any type', async () => {
    const result = await noUnsafePatterns({
      store,
      targetContent: 'const data: any = fetchData();',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('any');
  });

  it('scoreInRange passes for valid scores', async () => {
    const result = await scoreInRange({ store, output: 'Score: 0.85' });
    expect(result.passed).toBe(true);
  });

  it('noCrossTenantLeakage passes when no conversation specified', async () => {
    const result = await noCrossTenantLeakage({ store });
    expect(result.passed).toBe(true);
  });

  it('SECURITY_L1_SUITE runs all assertions', async () => {
    const ctx: L1Context = { store, output: 'Clean output with no issues.' };
    const result = await runL1Suite(SECURITY_L1_SUITE, ctx);
    expect(result.passed).toBe(true);
    expect(result.assertions.length).toBe(SECURITY_L1_SUITE.length);
  });

  it('SECURITY_L1_SUITE fails if any assertion fails', async () => {
    const ctx: L1Context = { store, output: 'Contact me at user@secret.com' };
    const result = await runL1Suite(SECURITY_L1_SUITE, ctx);
    expect(result.passed).toBe(false);
    expect(result.failCount).toBeGreaterThan(0);
  });
});

// ─── L2 Tests ────────────────────────────────────────────────────

describe('L2 Judges', () => {
  // Mock scorer that returns deterministic results based on content analysis
  const mockScorer: LLMScorerFn = async (prompt: string) => {
    // Simple heuristic: if output contains "I don't know" or contradicts context, fail
    const outputMatch = prompt.match(/OUTPUT[^]*?:(.*?)(?:\n\n|$)/s);
    const output = outputMatch?.[1]?.trim() ?? '';

    if (output.includes('FAIL_THIS')) {
      return { passed: false, reasoning: 'Intentional failure marker', confidence: 0.95 };
    }
    return { passed: true, reasoning: 'Content appears correct', confidence: 0.9 };
  };

  it('runs a single judge successfully', async () => {
    const result = await runJudge(
      BUILT_IN_JUDGES[0]!, // context_loss_judge
      mockScorer,
      { input: 'What time is the meeting?', output: 'The meeting is at 2pm.', context: 'Meeting scheduled for 2pm.' },
    );
    expect(result.passed).toBe(true);
    expect(result.judgeName).toBe('context_loss_judge');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('judge fails when output contains failure marker', async () => {
    const result = await runJudge(
      BUILT_IN_JUDGES[0]!,
      mockScorer,
      { input: 'test', output: 'FAIL_THIS response', context: 'context' },
    );
    expect(result.passed).toBe(false);
  });

  it('handles scorer errors gracefully', async () => {
    const failScorer: LLMScorerFn = async () => { throw new Error('API down'); };
    const result = await runJudge(BUILT_IN_JUDGES[0]!, failScorer, { input: '', output: '', context: '' });
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain('API down');
  });

  it('L2 suite calculates pass rate correctly', async () => {
    const alwaysPassScorer: LLMScorerFn = async () => ({ passed: true, reasoning: 'ok', confidence: 0.9 });
    const result = await runL2Suite(BUILT_IN_JUDGES, alwaysPassScorer, { input: 'x', output: 'y', context: 'z' });
    expect(result.passRate).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('L2 suite fails when pass rate below threshold', async () => {
    // Scorer that fails every other judge
    let callCount = 0;
    const halfFailScorer: LLMScorerFn = async () => {
      callCount++;
      return callCount % 2 === 0
        ? { passed: false, reasoning: 'fail', confidence: 0.9 }
        : { passed: true, reasoning: 'pass', confidence: 0.9 };
    };
    const result = await runL2Suite(BUILT_IN_JUDGES, halfFailScorer, { input: 'x', output: 'y', context: 'z' }, 0.85);
    expect(result.passRate).toBeLessThan(0.85);
    expect(result.passed).toBe(false);
  });

  it('validateJudge tracks precision and recall', async () => {
    const perfectScorer: LLMScorerFn = async (prompt) => {
      // Simulate a perfect judge — pass when expected, fail when not
      return { passed: !prompt.includes('FAIL_THIS'), reasoning: 'analysis', confidence: 0.9 };
    };

    const goldLabels: GoldLabel[] = [
      { input: 'good input', output: 'good output', context: 'ctx', expectedPass: true },
      { input: 'bad input', output: 'FAIL_THIS output', context: 'ctx', expectedPass: false },
    ];

    const validation = await validateJudge(BUILT_IN_JUDGES[0]!, perfectScorer, goldLabels);
    expect(validation.precision).toBe(1);
    expect(validation.recall).toBe(1);
    expect(validation.aligned).toBe(true);
  });
});

// ─── Harness Integration Tests ───────────────────────────────────

describe('EvalHarness', () => {
  let store: SqliteStore;
  const logs: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    store = new SqliteStore({ path: ':memory:' });
    await store.initialize();
    logs.length = 0;
  });

  const baseConfig: ExperimentConfig = {
    id: randomUUID(),
    hypothesis: 'Improving coherence scoring',
    targetFile: 'src/analyzers/coherence.ts',
    timeBudgetMs: 30000,
    primaryMetricName: 'spearman_rho',
    baselineMetric: 0.72,
  };

  it('commits when all gates pass and metric improves', async () => {
    const harness = new EvalHarness({
      store,
      logWriter: (entry) => logs.push(entry as unknown as Record<string, unknown>),
    });

    const result = await harness.evaluate(
      baseConfig,
      { output: 'Clean output.', primaryMetric: 0.78 },
    );

    expect(result.decision).toBe('commit');
    expect(result.allGatesPassed).toBe(true);
    expect(result.metricImproved).toBe(true);
    expect(logs.length).toBe(1);
  });

  it('reverts when L1 fails (PII in output)', async () => {
    const harness = new EvalHarness({ store });

    const result = await harness.evaluate(
      baseConfig,
      { output: 'Send to john@secret.com', primaryMetric: 0.99 },
    );

    expect(result.decision).toBe('revert');
    expect(result.l1.passed).toBe(false);
    expect(result.l2).toBeNull(); // Short-circuited
    expect(result.revertReason).toContain('L1 gate failed');
  });

  it('reverts when metric does not improve', async () => {
    const harness = new EvalHarness({ store });

    const result = await harness.evaluate(
      baseConfig,
      { output: 'Clean output.', primaryMetric: 0.70 }, // Below baseline 0.72
    );

    expect(result.decision).toBe('revert');
    expect(result.l1.passed).toBe(true);
    expect(result.revertReason).toContain('did not improve');
  });

  it('reverts when L2 pass rate below threshold', async () => {
    const failScorer: LLMScorerFn = async () => ({ passed: false, reasoning: 'fail', confidence: 0.9 });

    const harness = new EvalHarness({ store, scorer: failScorer });

    const result = await harness.evaluate(
      baseConfig,
      { output: 'Clean output.', primaryMetric: 0.78 },
      { input: 'test', output: 'Clean output.', context: 'ctx' },
    );

    expect(result.decision).toBe('revert');
    expect(result.l2?.passed).toBe(false);
    expect(result.revertReason).toContain('L2 gate failed');
  });

  it('records experiment timing', async () => {
    const harness = new EvalHarness({ store });
    const result = await harness.evaluate(
      baseConfig,
      { output: 'Clean.', primaryMetric: 0.80 },
    );
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.withinBudget).toBe(true);
  });

  it('handles all L1 + L2 gates in sequence', async () => {
    const passScorer: LLMScorerFn = async () => ({ passed: true, reasoning: 'ok', confidence: 0.9 });

    const harness = new EvalHarness({ store, scorer: passScorer });

    const result = await harness.evaluate(
      { ...baseConfig, l2PassRate: 0.8 },
      { output: 'Clean output with score 0.85.', primaryMetric: 0.80 },
      { input: 'test', output: 'Clean output with score 0.85.', context: 'ctx' },
    );

    expect(result.decision).toBe('commit');
    expect(result.l1.passed).toBe(true);
    expect(result.l2?.passed).toBe(true);
    expect(result.metricImproved).toBe(true);
  });
});
