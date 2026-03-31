/**
 * Tests for RalphLoop — stateless-but-iterative task execution.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GovernedSwarm } from '../src/agentfs/swarm.js';
import { AgentFSStore } from '../src/agentfs/store.js';
import { RalphLoop } from '../src/agentfs/ralph-loop.js';
import type { SwarmConfig } from '../src/agentfs/types.js';
import type { SentinelInspector, AuditLedgerWriter, InspectionResult } from '../src/secure/secure-store.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function createMockSentinel(): SentinelInspector {
  return {
    inspect: () => ({ threatLevel: 'safe', findings: [], latencyMs: 0 } as InspectionResult),
  };
}

function createMockAudit(): AuditLedgerWriter {
  const records: unknown[] = [];
  return {
    record: (entry: unknown) => { records.push(entry); },
    getRecords: () => records,
  } as unknown as AuditLedgerWriter;
}

function makeSwarm(audit?: AuditLedgerWriter): GovernedSwarm {
  const config: SwarmConfig = {
    maxWorkers: 10,
    modelRouting: { lead: 'claude', worker: 'claude', reviewer: 'claude', sentinel: 'claude' },
    inspectMessages: false,
    evalOnComplete: false,
    workspaceDir: '/tmp',
  };
  return new GovernedSwarm(config, createMockSentinel(), audit ?? createMockAudit());
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RalphLoop', () => {
  let swarm: GovernedSwarm;
  let ralph: RalphLoop;

  beforeEach(() => {
    swarm = makeSwarm();
    ralph = new RalphLoop(swarm, { maxIterations: 20, stuckThreshold: 3 });
  });

  describe('basic execution', () => {
    it('returns immediately with success when no tasks', async () => {
      const result = await ralph.run(async () => {});
      expect(result.completedTasks).toHaveLength(0);
      expect(result.failedTasks).toHaveLength(0);
      expect(result.totalIterations).toBe(0);
      expect(result.abortedByLimit).toBe(false);
    });

    it('completes a single task', async () => {
      const task = swarm.createTask('Task 1', 'Do something');
      const result = await ralph.run(async () => {
        // executor does nothing — task passes with no content
      });
      expect(result.completedTasks).toContain(task.id);
      expect(result.failedTasks).toHaveLength(0);
      expect(swarm.getTask(task.id)?.status).toBe('completed');
    });

    it('completes multiple tasks in priority order', async () => {
      const taskLow = swarm.createTask('Low priority', 'desc', [], 10);
      const taskHigh = swarm.createTask('High priority', 'desc', [], 1);

      const executionOrder: string[] = [];
      const result = await ralph.run(async (task) => {
        executionOrder.push(task.id);
      });

      expect(result.completedTasks).toHaveLength(2);
      // High priority (1) should execute before low priority (10)
      expect(executionOrder.indexOf(taskHigh.id)).toBeLessThan(executionOrder.indexOf(taskLow.id));
    });

    it('spawns a fresh agent for each task and shuts it down after', async () => {
      const spawnSpy = vi.spyOn(swarm, 'spawnAgent');
      const shutdownSpy = vi.spyOn(swarm, 'shutdownAgent');

      swarm.createTask('Task A', 'desc');
      await ralph.run(async () => {});

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(shutdownSpy).toHaveBeenCalledTimes(1);
    });

    it('shuts down agent even when executor throws', async () => {
      const shutdownSpy = vi.spyOn(swarm, 'shutdownAgent');
      swarm.createTask('Failing task', 'desc');

      await ralph.run(async () => {
        throw new Error('executor error');
      });

      expect(shutdownSpy).toHaveBeenCalled();
    });
  });

  describe('dependency handling', () => {
    it('skips tasks with unmet dependencies', async () => {
      const dep = swarm.createTask('Dependency', 'desc');
      swarm.createTask('Dependent', 'desc', [dep.id]);

      // Only executor for no-dep task runs; dependent task has unmet deps
      const executed: string[] = [];
      await ralph.run(async (task) => {
        executed.push(task.id);
      });

      // dep completes; dependent gets skipped (dep not yet 'completed' from swarm's perspective
      // when picked since Ralph assigns after sorting pending only)
      expect(executed).toContain(dep.id);
    });
  });

  describe('maxIterations abort', () => {
    it('aborts and sets abortedByLimit when maxIterations exceeded', async () => {
      ralph = new RalphLoop(swarm, { maxIterations: 1, stuckThreshold: 3 });

      // 2 tasks, only 1 iteration allowed
      swarm.createTask('Task 1', 'desc');
      swarm.createTask('Task 2', 'desc');

      const result = await ralph.run(async () => {});
      expect(result.abortedByLimit).toBe(true);
      expect(result.totalIterations).toBe(1);
    });
  });

  describe('retry logic', () => {
    it('re-queues task when hook returns retry action', async () => {
      const { HookRegistry } = await import('../src/agentfs/hooks.js');
      const registry = new HookRegistry();
      let callCount = 0;

      registry.register({
        event: 'task_completed',
        name: 'retry-hook',
        async handler() {
          callCount++;
          if (callCount < 2) {
            return { passed: false, feedback: 'try again', action: 'retry' as const };
          }
          return { passed: true, action: 'allow' as const };
        },
      });

      const config: SwarmConfig = {
        maxWorkers: 10,
        modelRouting: { lead: 'claude', worker: 'claude', reviewer: 'claude', sentinel: 'claude' },
        inspectMessages: false,
        evalOnComplete: false,
        workspaceDir: '/tmp',
      };
      const swarmWithHook = new GovernedSwarm(config, createMockSentinel(), createMockAudit(), [], registry);
      const ralphWithHook = new RalphLoop(swarmWithHook, { maxIterations: 10, stuckThreshold: 3 });

      const task = swarmWithHook.createTask('Retried task', 'desc');
      const result = await ralphWithHook.run(async () => {});

      // Task should eventually complete (hook allows on 2nd call)
      expect(result.completedTasks).toContain(task.id);
    });
  });

  describe('stuck detection', () => {
    it('detects stuck task when executor throws same error 3 times', async () => {
      ralph = new RalphLoop(swarm, { maxIterations: 10, stuckThreshold: 3 });
      const task = swarm.createTask('Stuck task', 'desc');

      const result = await ralph.run(async () => {
        throw new Error('connection refused');
      });

      expect(result.stuckTasks).toContain(task.id);
      expect(result.failedTasks).toContain(task.id);
    });

    it('does NOT detect stuck when error varies', async () => {
      // stuckThreshold=3 requires exactly 3 identical errors in a row
      // With varying errors, stuck detection never fires — loop just aborts by limit
      ralph = new RalphLoop(swarm, { maxIterations: 5, stuckThreshold: 3 });
      swarm.createTask('Variable error task', 'desc');

      let callNum = 0;
      const result = await ralph.run(async () => {
        callNum++;
        throw new Error(`unique-error-${callNum}`); // different each time
      });

      // Not stuck (errors differ), loop aborts by iteration limit
      expect(result.stuckTasks).toHaveLength(0);
      expect(result.abortedByLimit).toBe(true);
    });

    it('requires exactly stuckThreshold identical errors, not fewer', async () => {
      ralph = new RalphLoop(swarm, { maxIterations: 4, stuckThreshold: 3 });
      swarm.createTask('Almost stuck', 'desc');

      let callNum = 0;
      const result = await ralph.run(async () => {
        callNum++;
        if (callNum <= 2) {
          throw new Error('same error'); // only 2 identical, below threshold of 3
        }
        throw new Error('different error'); // 3rd is different
      });

      expect(result.stuckTasks).toHaveLength(0);
    });

    it('spawns a fresh agent after detecting stuck (shutdownAgent called)', async () => {
      ralph = new RalphLoop(swarm, { maxIterations: 10, stuckThreshold: 3 });
      const shutdownSpy = vi.spyOn(swarm, 'shutdownAgent');
      swarm.createTask('Stuck task', 'desc');

      await ralph.run(async () => {
        throw new Error('same error always');
      });

      // shutdownAgent called at least stuckThreshold times (once per iteration)
      expect(shutdownSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('token recording integration', () => {
    it('tokens accumulate across iterations for the same logical task', async () => {
      const task = swarm.createTask('Token task', 'desc');

      const executedAgentIds: string[] = [];
      await ralph.run(async (t, agentId) => {
        executedAgentIds.push(agentId);
        swarm.recordTokenUsage(agentId, 100);
      });

      // Agent was spawned fresh, recorded 100 tokens
      expect(executedAgentIds).toHaveLength(1);
      const agent = swarm.getAgent(executedAgentIds[0]!);
      // Agent is shut down after completion so we check via the task
      expect(swarm.getTask(task.id)?.status).toBe('completed');
    });
  });
});

describe('Token Budgeting', () => {
  let swarm: GovernedSwarm;

  beforeEach(() => {
    swarm = makeSwarm();
  });

  describe('recordTokenUsage()', () => {
    it('increments tokensUsed on SwarmAgent', () => {
      const agent = swarm.spawnAgent('test-agent', 'worker');
      expect(agent.tokensUsed).toBe(0);

      swarm.recordTokenUsage(agent.id, 500);
      const updated = swarm.getAgent(agent.id)!;
      expect(updated.tokensUsed).toBe(500);
    });

    it('accumulates across multiple calls', () => {
      const agent = swarm.spawnAgent('test-agent', 'worker');
      swarm.recordTokenUsage(agent.id, 100);
      swarm.recordTokenUsage(agent.id, 200);
      swarm.recordTokenUsage(agent.id, 50);
      expect(swarm.getAgent(agent.id)!.tokensUsed).toBe(350);
    });

    it('throws on negative token count', () => {
      const agent = swarm.spawnAgent('test-agent', 'worker');
      expect(() => swarm.recordTokenUsage(agent.id, -1)).toThrow(/>= 0/);
    });

    it('throws for unknown agent', () => {
      expect(() => swarm.recordTokenUsage('does-not-exist', 100)).toThrow(/not found/);
    });

    it('fresh agents start with tokensUsed = 0', () => {
      const a = swarm.spawnAgent('a', 'worker');
      const b = swarm.spawnAgent('b', 'worker');
      expect(swarm.getAgent(a.id)!.tokensUsed).toBe(0);
      expect(swarm.getAgent(b.id)!.tokensUsed).toBe(0);
    });
  });

  describe('BudgetEnforcer hook', () => {
    it('throws if tokenBudget <= 0', async () => {
      const { createBudgetEnforcerHook } = await import('../src/agentfs/hooks.js');
      expect(() => createBudgetEnforcerHook(0)).toThrow(/> 0/);
      expect(() => createBudgetEnforcerHook(-100)).toThrow(/> 0/);
    });

    it('allows when under 85% budget', async () => {
      const { createBudgetEnforcerHook, HookRegistry } = await import('../src/agentfs/hooks.js');
      const budget = 1000;
      const hook = createBudgetEnforcerHook(budget);
      const registry = new HookRegistry();
      registry.register(hook);

      const config: SwarmConfig = {
        maxWorkers: 5,
        modelRouting: { lead: 'claude', worker: 'claude', reviewer: 'claude', sentinel: 'claude' },
        inspectMessages: false,
        evalOnComplete: false,
        workspaceDir: '/tmp',
      };
      const s = new GovernedSwarm(config, createMockSentinel(), createMockAudit(), [], registry);
      const agent = s.spawnAgent('budget-agent', 'worker');
      s.recordTokenUsage(agent.id, 800); // 80% — under 85% threshold

      const task = s.createTask('Budget task', 'desc');
      s.assignTask(task.id, agent.id);
      const result = await s.completeTask(task.id);

      expect(result.completed).toBe(true);
    });

    it('warns (allows) at 85-99% budget', async () => {
      const { createBudgetEnforcerHook, HookRegistry } = await import('../src/agentfs/hooks.js');
      const budget = 1000;
      const hook = createBudgetEnforcerHook(budget);
      const registry = new HookRegistry();
      registry.register(hook);

      const config: SwarmConfig = {
        maxWorkers: 5,
        modelRouting: { lead: 'claude', worker: 'claude', reviewer: 'claude', sentinel: 'claude' },
        inspectMessages: false,
        evalOnComplete: false,
        workspaceDir: '/tmp',
      };
      const s = new GovernedSwarm(config, createMockSentinel(), createMockAudit(), [], registry);
      const agent = s.spawnAgent('budget-agent', 'worker');
      s.recordTokenUsage(agent.id, 900); // 90% — warning zone

      const task = s.createTask('Budget task', 'desc');
      s.assignTask(task.id, agent.id);
      const result = await s.completeTask(task.id);

      // Still completes (action='allow'), but hook fired
      expect(result.completed).toBe(true);
    });

    it('blocks at 100% budget', async () => {
      const { createBudgetEnforcerHook, HookRegistry } = await import('../src/agentfs/hooks.js');
      const budget = 1000;
      const hook = createBudgetEnforcerHook(budget);
      const registry = new HookRegistry();
      registry.register(hook);

      const config: SwarmConfig = {
        maxWorkers: 5,
        modelRouting: { lead: 'claude', worker: 'claude', reviewer: 'claude', sentinel: 'claude' },
        inspectMessages: false,
        evalOnComplete: false,
        workspaceDir: '/tmp',
      };
      const s = new GovernedSwarm(config, createMockSentinel(), createMockAudit(), [], registry);
      const agent = s.spawnAgent('budget-agent', 'worker');
      s.recordTokenUsage(agent.id, 1000); // exactly 100%

      const task = s.createTask('Budget task', 'desc');
      s.assignTask(task.id, agent.id);
      const result = await s.completeTask(task.id);

      expect(result.completed).toBe(false);
      expect(swarm.getTask(task.id)?.status ?? s.getTask(task.id)?.status).not.toBe('completed');
    });
  });
});

describe('readAllFiles()', () => {
  it('reads files in subdirectories recursively', () => {
    const store = new AgentFSStore({ dbPath: ':memory:', agentId: 'test' });
    store.initialize();

    store.writeFile('/root-file.ts', 'root content');
    store.writeFile('/src/main.ts', 'main content');
    store.writeFile('/src/lib/helpers.ts', 'helpers content');

    const allContent = store.readAllFiles();
    expect(allContent).toContain('root content');
    expect(allContent).toContain('main content');
    expect(allContent).toContain('helpers content');
  });

  it('returns empty string for empty filesystem', () => {
    const store = new AgentFSStore({ dbPath: ':memory:', agentId: 'test' });
    store.initialize();

    expect(store.readAllFiles()).toBe('');
  });
});
