/**
 * Tests for Lifecycle Hooks System — registration, firing, built-in hooks, retry/block.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HookRegistry, createSentinelHook, createL1EvalHook,
  type SwarmHook, type HookContext, type HookResult,
} from '../src/agentfs/hooks.js';
import { GovernedSwarm } from '../src/agentfs/swarm.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import type { SentinelInspector, InspectionResult, AuditLedgerWriter, SecureAuditEntry } from '../src/secure/secure-store.js';
import { noPiiInOutput, noUnsafePatterns } from '../src/evals/l1-assertions.js';
import { randomUUID } from 'node:crypto';

// ─── Test Fixtures ───────────────────────────────────────────────

const mockSentinel: SentinelInspector = {
  inspect(content: string): InspectionResult {
    if (content.includes('ignore all previous instructions')) {
      return { threatLevel: 'blocked', findings: [{ category: 'prompt_injection', confidence: 90, description: 'Injection detected' }], latencyMs: 1 };
    }
    if (content.includes('sk-secret')) {
      return { threatLevel: 'blocked', findings: [{ category: 'credential_leak', confidence: 95, description: 'API key leak' }], latencyMs: 1 };
    }
    if (content.includes('suspicious-pattern')) {
      return { threatLevel: 'suspicious', findings: [{ category: 'unusual_content', confidence: 50, description: 'Unusual pattern' }], latencyMs: 1 };
    }
    return { threatLevel: 'safe', findings: [], latencyMs: 0 };
  },
};

function createMockAudit(): AuditLedgerWriter & { entries: SecureAuditEntry[] } {
  const entries: SecureAuditEntry[] = [];
  return {
    entries,
    record(event) {
      const entry: SecureAuditEntry = {
        id: randomUUID(), sequenceNumber: entries.length + 1,
        timestamp: new Date().toISOString(), type: event.type,
        userId: 'system', action: event.type, target: '',
        previousHash: 'prev', hash: 'hash',
        details: event.details, outcome: event.outcome,
      };
      entries.push(entry);
      return entry;
    },
    verifyChain() { return { valid: true }; },
  };
}

// ─── HookRegistry Tests ─────────────────────────────────────────

describe('HookRegistry', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('registers and retrieves hooks by event', () => {
    const hook: SwarmHook = {
      event: 'agent_spawned',
      name: 'test_hook',
      handler: async () => ({ passed: true, action: 'allow' }),
    };
    registry.register(hook);

    const hooks = registry.getHooks('agent_spawned');
    expect(hooks.length).toBe(1);
    expect(hooks[0].name).toBe('test_hook');
  });

  it('returns empty array for events with no hooks', () => {
    expect(registry.getHooks('task_completed')).toEqual([]);
  });

  it('registers multiple hooks for same event', () => {
    registry.register({ event: 'task_completed', name: 'hook_a', handler: async () => ({ passed: true, action: 'allow' }) });
    registry.register({ event: 'task_completed', name: 'hook_b', handler: async () => ({ passed: true, action: 'allow' }) });

    expect(registry.getHooks('task_completed').length).toBe(2);
  });

  it('getAllHooks returns hooks across all events', () => {
    registry.register({ event: 'agent_spawned', name: 'hook_1', handler: async () => ({ passed: true, action: 'allow' }) });
    registry.register({ event: 'task_completed', name: 'hook_2', handler: async () => ({ passed: true, action: 'allow' }) });
    registry.register({ event: 'agent_idle', name: 'hook_3', handler: async () => ({ passed: true, action: 'allow' }) });

    expect(registry.getAllHooks().length).toBe(3);
  });

  it('fires hooks in registration order', async () => {
    const order: string[] = [];
    registry.register({
      event: 'task_completed', name: 'first',
      handler: async () => { order.push('first'); return { passed: true, action: 'allow' }; },
    });
    registry.register({
      event: 'task_completed', name: 'second',
      handler: async () => { order.push('second'); return { passed: true, action: 'allow' }; },
    });

    const ctx: HookContext = { event: 'task_completed' };
    await registry.fire('task_completed', ctx);

    expect(order).toEqual(['first', 'second']);
  });

  it('fire returns passed=true when all hooks pass', async () => {
    registry.register({ event: 'agent_spawned', name: 'pass_hook', handler: async () => ({ passed: true, action: 'allow' }) });

    const result = await registry.fire('agent_spawned', { event: 'agent_spawned' });
    expect(result.passed).toBe(true);
    expect(result.results.length).toBe(1);
  });

  it('fire returns passed=true when no hooks registered', async () => {
    const result = await registry.fire('agent_spawned', { event: 'agent_spawned' });
    expect(result.passed).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('fire stops on block action', async () => {
    const order: string[] = [];
    registry.register({
      event: 'task_completed', name: 'blocker',
      handler: async () => { order.push('blocker'); return { passed: false, feedback: 'Blocked!', action: 'block' }; },
    });
    registry.register({
      event: 'task_completed', name: 'after_block',
      handler: async () => { order.push('after_block'); return { passed: true, action: 'allow' }; },
    });

    const result = await registry.fire('task_completed', { event: 'task_completed' });
    expect(result.passed).toBe(false);
    expect(result.blockedBy).toBe('blocker');
    // Second hook should NOT have run
    expect(order).toEqual(['blocker']);
  });

  it('fire continues on retry action (does not block)', async () => {
    const order: string[] = [];
    registry.register({
      event: 'task_completed', name: 'retrier',
      handler: async () => { order.push('retrier'); return { passed: false, feedback: 'Retry please', action: 'retry' }; },
    });
    registry.register({
      event: 'task_completed', name: 'after_retry',
      handler: async () => { order.push('after_retry'); return { passed: true, action: 'allow' }; },
    });

    const result = await registry.fire('task_completed', { event: 'task_completed' });
    expect(result.passed).toBe(false); // Overall failed because retrier failed
    expect(result.blockedBy).toBeUndefined(); // But not blocked
    expect(order).toEqual(['retrier', 'after_retry']); // Both ran
  });

  it('fire continues on allow action even when not passed', async () => {
    registry.register({
      event: 'agent_spawned', name: 'warning',
      handler: async () => ({ passed: false, feedback: 'Warning only', action: 'allow' }),
    });

    const result = await registry.fire('agent_spawned', { event: 'agent_spawned' });
    expect(result.passed).toBe(false);
    expect(result.blockedBy).toBeUndefined();
  });
});

// ─── Built-in Sentinel Hook Tests ───────────────────────────────

describe('Sentinel Hook', () => {
  it('passes on safe content', async () => {
    const hook = createSentinelHook(mockSentinel);
    const result = await hook.handler({ event: 'task_completed', content: 'Clean, safe output' });
    expect(result.passed).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('blocks on dangerous content', async () => {
    const hook = createSentinelHook(mockSentinel);
    const result = await hook.handler({ event: 'task_completed', content: 'sk-secret-leaked-here' });
    expect(result.passed).toBe(false);
    expect(result.action).toBe('block');
    expect(result.feedback).toContain('credential_leak');
  });

  it('allows but flags suspicious content', async () => {
    const hook = createSentinelHook(mockSentinel);
    const result = await hook.handler({ event: 'task_completed', content: 'Output with suspicious-pattern in it' });
    expect(result.passed).toBe(true);
    expect(result.action).toBe('allow');
    expect(result.feedback).toContain('suspicious');
  });

  it('passes when no content provided', async () => {
    const hook = createSentinelHook(mockSentinel);
    const result = await hook.handler({ event: 'task_completed' });
    expect(result.passed).toBe(true);
  });
});

// ─── Built-in L1 Eval Hook Tests ────────────────────────────────

describe('L1 Eval Hook', () => {
  let lcmStore: SqliteStore;

  beforeEach(async () => {
    lcmStore = new SqliteStore({ path: ':memory:' });
    await lcmStore.initialize();
  });

  it('passes on clean output', async () => {
    const hook = createL1EvalHook([noUnsafePatterns, noPiiInOutput]);
    const result = await hook.handler({
      event: 'task_completed',
      lcmStore,
      content: 'export function add(a: number, b: number) { return a + b; }',
    });
    expect(result.passed).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('blocks on unsafe patterns', async () => {
    const hook = createL1EvalHook([noUnsafePatterns]);
    const result = await hook.handler({
      event: 'task_completed',
      lcmStore,
      content: 'eval("dangerous code")',
    });
    expect(result.passed).toBe(false);
    expect(result.action).toBe('block');
    expect(result.feedback).toContain('no_unsafe_patterns');
  });

  it('passes when no content or store provided', async () => {
    const hook = createL1EvalHook([noUnsafePatterns]);
    const result = await hook.handler({ event: 'task_completed' });
    expect(result.passed).toBe(true);
  });
});

// ─── GovernedSwarm + Hooks Integration Tests ────────────────────

describe('GovernedSwarm with Hooks', () => {
  let swarm: GovernedSwarm;
  let audit: ReturnType<typeof createMockAudit>;
  let lcmStore: SqliteStore;
  let registry: HookRegistry;

  beforeEach(async () => {
    audit = createMockAudit();
    lcmStore = new SqliteStore({ path: ':memory:' });
    await lcmStore.initialize();
    registry = new HookRegistry();

    swarm = new GovernedSwarm(
      {
        maxWorkers: 3,
        modelRouting: { lead: 'opus', worker: 'sonnet', reviewer: 'sonnet', sentinel: 'haiku' },
        inspectMessages: true,
        evalOnComplete: true,
        workspaceDir: '/tmp/swarm-test',
      },
      mockSentinel, audit, undefined, registry,
    );
  });

  it('fires agent_spawned hooks when agent is created', async () => {
    let hookFired = false;
    registry.register({
      event: 'agent_spawned', name: 'spawn_tracker',
      handler: async (ctx) => { hookFired = true; expect(ctx.agent).toBeDefined(); return { passed: true, action: 'allow' }; },
    });

    swarm.spawnAgent('Worker', 'worker');
    // Give async hooks time to complete
    await new Promise(r => setTimeout(r, 10));
    expect(hookFired).toBe(true);
  });

  it('fires task_completed hooks on task completion', async () => {
    let hookFired = false;
    registry.register({
      event: 'task_completed', name: 'completion_tracker',
      handler: async (ctx) => { hookFired = true; return { passed: true, action: 'allow' }; },
    });

    const worker = swarm.spawnAgent('Worker', 'worker');
    const task = swarm.createTask('Build it', 'Build the thing');
    swarm.assignTask(task.id, worker.id);

    const store = swarm.getAgentStore(worker.id)!;
    store.writeFile('/code.ts', 'const x = 1;');

    await swarm.completeTask(task.id, lcmStore);
    expect(hookFired).toBe(true);
  });

  it('block hook prevents task completion', async () => {
    registry.register({
      event: 'task_completed', name: 'always_block',
      handler: async () => ({ passed: false, feedback: 'Blocked by hook', action: 'block' }),
    });

    const worker = swarm.spawnAgent('Worker', 'worker');
    const task = swarm.createTask('Build it', 'Build the thing');
    swarm.assignTask(task.id, worker.id);

    const store = swarm.getAgentStore(worker.id)!;
    store.writeFile('/code.ts', 'const x = 1;');

    const result = await swarm.completeTask(task.id, lcmStore);
    expect(result.completed).toBe(false);
    expect(swarm.getTask(task.id)!.status).toBe('failed');
  });

  it('audit logs hook failures', async () => {
    registry.register({
      event: 'task_completed', name: 'blocker_hook',
      handler: async () => ({ passed: false, feedback: 'Nope', action: 'block' }),
    });

    const worker = swarm.spawnAgent('Worker', 'worker');
    const task = swarm.createTask('Build it', 'Build the thing');
    swarm.assignTask(task.id, worker.id);

    const store = swarm.getAgentStore(worker.id)!;
    store.writeFile('/code.ts', 'const x = 1;');

    await swarm.completeTask(task.id, lcmStore);

    const auditTypes = audit.entries.map(e => e.type);
    expect(auditTypes).toContain('swarm:hook_blocked');
  });

  it('fires agent_idle hooks when agent becomes idle after task', async () => {
    let hookFired = false;
    registry.register({
      event: 'agent_idle', name: 'idle_tracker',
      handler: async (ctx) => { hookFired = true; expect(ctx.agent?.status).toBe('idle'); return { passed: true, action: 'allow' }; },
    });

    const worker = swarm.spawnAgent('Worker', 'worker');
    const task = swarm.createTask('Build it', 'Build the thing');
    swarm.assignTask(task.id, worker.id);

    const store = swarm.getAgentStore(worker.id)!;
    store.writeFile('/code.ts', 'const x = 1;');

    await swarm.completeTask(task.id, lcmStore);
    expect(hookFired).toBe(true);
  });
});
