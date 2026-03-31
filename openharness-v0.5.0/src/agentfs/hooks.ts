/**
 * Lifecycle Hooks System — extensible event-driven hooks for GovernedSwarm.
 *
 * Fires hooks at key swarm lifecycle events (agent_spawned, task_completed, etc.).
 * Each hook receives full context and returns allow/retry/block decisions.
 *
 * Built-in hooks:
 *   - sentinelHook: inspects content at relevant events
 *   - l1EvalHook: runs L1 hard gates on task completion output
 */
import type { SwarmAgent, SwarmTask, SwarmMessage } from './types.js';
import type { AgentFSStore } from './store.js';
import type { SentinelInspector } from '../secure/secure-store.js';
import type { L1Assertion, L1Context } from '../evals/l1-assertions.js';
import { runL1Suite } from '../evals/l1-assertions.js';
import type { LcmStore } from '../store/lcm-store.js';

// ─── Types ──────────────────────────────────────────────────────

export type SwarmEvent =
  | 'agent_spawned'
  | 'task_assigned'
  | 'plan_submitted'
  | 'task_completed'
  | 'agent_idle'
  | 'message_sent'
  | 'snapshot_taken';

export interface HookContext {
  /** The event that triggered this hook */
  readonly event: SwarmEvent;
  /** Agent involved (if applicable) */
  readonly agent?: SwarmAgent;
  /** Task involved (if applicable) */
  readonly task?: SwarmTask;
  /** Message involved (if applicable) */
  readonly message?: SwarmMessage;
  /** Agent's filesystem store (if applicable) */
  readonly agentStore?: AgentFSStore;
  /** LCM store for eval gates */
  readonly lcmStore?: LcmStore;
  /** Content to inspect (event-dependent) */
  readonly content?: string;
}

export interface HookResult {
  /** Whether the hook passed */
  readonly passed: boolean;
  /** Feedback for the agent or lead */
  readonly feedback?: string;
  /** Action to take on failure: allow (warn), retry (agent retries), block (fail the operation) */
  readonly action: 'allow' | 'retry' | 'block';
}

export interface SwarmHook {
  /** Which event this hook fires on */
  readonly event: SwarmEvent;
  /** Human-readable hook name (for audit logging) */
  readonly name: string;
  /** Handler function. Receives context, returns result. */
  readonly handler: (ctx: HookContext) => Promise<HookResult>;
  /** Maximum retries when action is 'retry' (default: 3) */
  readonly maxRetries?: number;
}

// ─── Hook Registry ──────────────────────────────────────────────

export class HookRegistry {
  private readonly hooks = new Map<SwarmEvent, SwarmHook[]>();

  /** Register a hook for an event. */
  register(hook: SwarmHook): void {
    const list = this.hooks.get(hook.event) ?? [];
    list.push(hook);
    this.hooks.set(hook.event, list);
  }

  /** Get all hooks registered for an event. */
  getHooks(event: SwarmEvent): readonly SwarmHook[] {
    return this.hooks.get(event) ?? [];
  }

  /** Get all registered hooks across all events. */
  getAllHooks(): readonly SwarmHook[] {
    const all: SwarmHook[] = [];
    for (const hooks of this.hooks.values()) {
      all.push(...hooks);
    }
    return all;
  }

  /**
   * Fire all hooks for an event. Returns aggregated results.
   * Hooks run sequentially in registration order.
   * If any hook returns 'block', execution stops immediately.
   */
  async fire(event: SwarmEvent, ctx: HookContext): Promise<HookFireResult> {
    const hooks = this.getHooks(event);
    if (hooks.length === 0) return { passed: true, results: [] };

    const results: HookResultEntry[] = [];
    let allPassed = true;

    for (const hook of hooks) {
      const result = await hook.handler({ ...ctx, event });
      results.push({ hook: hook.name, result });

      if (!result.passed) {
        allPassed = false;
        if (result.action === 'block') {
          // Stop immediately on block
          return { passed: false, results, blockedBy: hook.name };
        }
      }
    }

    return { passed: allPassed, results };
  }
}

export interface HookResultEntry {
  readonly hook: string;
  readonly result: HookResult;
}

export interface HookFireResult {
  readonly passed: boolean;
  readonly results: readonly HookResultEntry[];
  /** Which hook blocked execution (if any) */
  readonly blockedBy?: string;
}

// ─── Built-in Hooks ─────────────────────────────────────────────

/**
 * Sentinel hook — inspects content via sentinel pipeline.
 * Blocks on 'blocked' threat level, allows on 'safe'/'suspicious'.
 */
export function createSentinelHook(sentinel: SentinelInspector): SwarmHook {
  return {
    event: 'task_completed',
    name: 'sentinel',
    async handler(ctx: HookContext): Promise<HookResult> {
      if (!ctx.content) {
        return { passed: true, action: 'allow' };
      }

      const result = sentinel.inspect(ctx.content);
      if (result.threatLevel === 'blocked') {
        return {
          passed: false,
          feedback: `Sentinel blocked: ${result.findings.map(f => f.category).join(', ')}`,
          action: 'block',
        };
      }
      if (result.threatLevel === 'suspicious') {
        return {
          passed: true,
          feedback: `Sentinel flagged suspicious content: ${result.findings.map(f => f.category).join(', ')}`,
          action: 'allow',
        };
      }
      return { passed: true, action: 'allow' };
    },
  };
}

/**
 * Budget enforcer hook — pauses (warns) at 85%, blocks at 100% token budget.
 * Fires on task_completed so the agent can't complete if over budget.
 *
 * Wire-up: call swarm.recordTokenUsage(agentId, tokens) after each LLM call.
 * tokenBudget must be > 0 (validate at hook creation time).
 */
export function createBudgetEnforcerHook(tokenBudget: number): SwarmHook {
  if (tokenBudget <= 0) throw new Error(`tokenBudget must be > 0, got ${tokenBudget}`);
  return {
    event: 'task_completed',
    name: 'budget_enforcer',
    async handler(ctx: HookContext): Promise<HookResult> {
      if (!ctx.agent) return { passed: true, action: 'allow' };
      const used = ctx.agent.tokensUsed;
      const pct = used / tokenBudget;
      if (pct >= 1.0) {
        return {
          passed: false,
          feedback: `Token budget exhausted: ${used}/${tokenBudget} tokens (${Math.round(pct * 100)}%)`,
          action: 'block',
        };
      }
      if (pct >= 0.85) {
        return {
          passed: true,
          feedback: `Token budget warning: ${used}/${tokenBudget} tokens (${Math.round(pct * 100)}%)`,
          action: 'allow',
        };
      }
      return { passed: true, action: 'allow' };
    },
  };
}

/**
 * L1 eval hook — runs L1 hard gates on task output.
 * Blocks if any L1 assertion fails.
 */
export function createL1EvalHook(l1Gates: L1Assertion[]): SwarmHook {
  return {
    event: 'task_completed',
    name: 'l1_eval',
    async handler(ctx: HookContext): Promise<HookResult> {
      if (!ctx.lcmStore || !ctx.content) {
        return { passed: true, action: 'allow' };
      }

      const l1Ctx: L1Context = {
        store: ctx.lcmStore,
        output: ctx.content,
        targetContent: ctx.content,
      };

      const result = await runL1Suite(l1Gates, l1Ctx);
      if (!result.passed) {
        const failures = result.assertions.filter(a => !a.passed).map(a => a.name);
        return {
          passed: false,
          feedback: `L1 eval failed: ${failures.join(', ')}`,
          action: 'block',
        };
      }
      return { passed: true, action: 'allow' };
    },
  };
}
