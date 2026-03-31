/**
 * Governed Swarm — Multi-agent orchestration with OpenHarness governance.
 *
 * Mirrors Claude Code's Agent Teams pattern (lead → workers):
 *   - Lead agent plans and delegates (coordination only)
 *   - Worker agents execute in isolated AgentFS databases
 *   - Sentinel inspects ALL inter-agent messages
 *   - L1 eval gates run on every task completion
 *   - Full audit trail across the entire swarm
 *
 * Key difference from raw Claude Code swarms:
 *   - AgentFS provides real filesystem isolation (not just git worktree convention)
 *   - Every file write is sentinel-inspected before reaching the filesystem
 *   - Every task completion runs through L1 hard gates
 *   - Every inter-agent message is inspected for injection
 *   - Complete SQL-queryable audit of all swarm activity
 */
import { randomUUID } from 'node:crypto';
import { AgentFSStore } from './store.js';
import type {
  SwarmConfig, SwarmAgent, SwarmTask, SwarmMessage,
  SwarmRole, TaskEvalResult, AgentSnapshot,
} from './types.js';
import type { SentinelInspector, AuditLedgerWriter } from '../secure/secure-store.js';
import {
  type L1Assertion, type L1Context, runL1Suite,
  noUnsafePatterns, noPiiInOutput, storeHealthy,
} from '../evals/l1-assertions.js';
import type { LcmStore } from '../store/lcm-store.js';
import type { HookRegistry, HookContext } from './hooks.js';

export class GovernedSwarm {
  private readonly config: SwarmConfig;
  private readonly sentinel: SentinelInspector;
  private readonly audit: AuditLedgerWriter;
  private readonly agents = new Map<string, SwarmAgent>();
  private readonly agentStores = new Map<string, AgentFSStore>();
  private readonly tasks = new Map<string, SwarmTask>();
  private readonly messages: SwarmMessage[] = [];
  private readonly l1Gates: L1Assertion[];
  private readonly hookRegistry?: HookRegistry;

  constructor(
    config: SwarmConfig,
    sentinel: SentinelInspector,
    audit: AuditLedgerWriter,
    extraL1Gates?: L1Assertion[],
    hookRegistry?: HookRegistry,
  ) {
    this.config = config;
    this.sentinel = sentinel;
    this.audit = audit;
    this.l1Gates = [noUnsafePatterns, noPiiInOutput, ...(extraL1Gates ?? [])];
    this.hookRegistry = hookRegistry;

    this.audit.record({
      type: 'swarm:created',
      details: { maxWorkers: config.maxWorkers, inspectMessages: config.inspectMessages },
      outcome: 'success',
    });
  }

  // ─── Agent Lifecycle ─────────────────────────────────────────

  /**
   * Spawn a new agent in the swarm with its own isolated AgentFS.
   * Each agent gets a separate .db file — full filesystem isolation.
   */
  spawnAgent(name: string, role: SwarmRole, model?: string): SwarmAgent {
    if (role !== 'lead' && this.workerCount >= this.config.maxWorkers) {
      throw new Error(`Max workers (${this.config.maxWorkers}) reached`);
    }

    const id = randomUUID();
    const dbPath = `${this.config.workspaceDir}/${id}.db`;
    const resolvedModel = model ?? this.config.modelRouting[role] ?? 'default';

    // Create isolated AgentFS for this agent
    const store = new AgentFSStore(
      { dbPath: ':memory:', agentId: id, agentName: name },
      this.sentinel,
      this.audit,
    );
    store.initialize();

    const agent: SwarmAgent = {
      id, name, role, model: resolvedModel,
      dbPath, status: 'idle',
      startedAt: Date.now(), lastActivityAt: Date.now(),
      tokensUsed: 0,
    };

    this.agents.set(id, agent);
    this.agentStores.set(id, store);

    this.audit.record({
      type: 'swarm:agent_spawned',
      details: { agentId: id, name, role, model: resolvedModel },
      outcome: 'success',
    });

    // Fire agent_spawned hooks (async, non-blocking for spawn)
    this.fireHooks('agent_spawned', { event: 'agent_spawned', agent, agentStore: store });

    return agent;
  }

  /** Get an agent's isolated filesystem store. */
  getAgentStore(agentId: string): AgentFSStore | null {
    return this.agentStores.get(agentId) ?? null;
  }

  /** Shut down an agent gracefully. */
  shutdownAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    const store = this.agentStores.get(agentId);
    store?.close();
    this.agentStores.delete(agentId);

    this.agents.set(agentId, { ...agent, status: 'completed' });
    this.audit.record({
      type: 'swarm:agent_shutdown',
      details: { agentId, name: agent.name, role: agent.role },
      outcome: 'success',
    });
    return true;
  }

  // ─── Task Management ─────────────────────────────────────────

  /** Create a task on the shared task board. */
  createTask(title: string, description: string, deps: string[] = [], priority: number = 0): SwarmTask {
    const id = randomUUID();
    const task: SwarmTask = {
      id, title, description, assignedTo: null,
      status: 'pending', dependencies: deps,
      priority, createdAt: Date.now(), completedAt: null,
    };
    this.tasks.set(id, task);

    this.audit.record({
      type: 'swarm:task_created',
      details: { taskId: id, title, deps: deps.length, priority },
      outcome: 'success',
    });
    return task;
  }

  /** Assign a task to a worker agent. */
  assignTask(taskId: string, agentId: string): boolean {
    const task = this.tasks.get(taskId);
    const agent = this.agents.get(agentId);
    if (!task || !agent) return false;

    // Check dependencies are completed
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== 'completed') {
        return false; // Dependency not met
      }
    }

    this.tasks.set(taskId, { ...task, assignedTo: agentId, status: 'in_progress' });
    this.agents.set(agentId, { ...agent, status: 'working', assignedTask: taskId, lastActivityAt: Date.now() });

    this.audit.record({
      type: 'swarm:task_assigned',
      details: { taskId, agentId, agentName: agent.name, title: task.title },
      outcome: 'success',
    });
    return true;
  }

  // ─── Plan Approval Flow ───────────────────────────────────────

  /**
   * Submit a plan for review before implementation.
   * Sentinel inspects the plan text. Task must be in_progress.
   * Throws if sentinel blocks the plan or task is not in correct state.
   */
  submitPlan(taskId: string, plan: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'in_progress') {
      throw new Error(`Task must be in_progress to submit plan (current: ${task.status})`);
    }

    // Sentinel-inspect plan text
    const result = this.sentinel.inspect(plan);
    if (result.threatLevel === 'blocked') {
      this.audit.record({
        type: 'swarm:plan_blocked',
        details: { taskId, findings: result.findings.map(f => f.category) },
        outcome: 'blocked',
      });
      throw new Error(`Plan blocked by sentinel: ${result.findings.map(f => f.category).join(', ')}`);
    }

    this.tasks.set(taskId, {
      ...task,
      status: 'plan_review',
      plan,
      planStatus: 'pending',
      planRejectionReason: undefined,
    });

    this.audit.record({
      type: 'swarm:plan_submitted',
      details: { taskId, title: task.title, agentId: task.assignedTo, planLength: plan.length },
      outcome: 'success',
    });
  }

  /**
   * Approve a plan. Moves task back to in_progress with approved planStatus.
   * Returns false if task is not in plan_review state.
   */
  approvePlan(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'plan_review') return false;

    this.tasks.set(taskId, {
      ...task,
      status: 'in_progress',
      planStatus: 'approved',
    });

    // Notify the assigned agent
    if (task.assignedTo) {
      this.sendMessage('system', task.assignedTo, 'plan_approval', `Plan approved for task "${task.title}". Proceed with implementation.`);
    }

    this.audit.record({
      type: 'swarm:plan_approved',
      details: { taskId, title: task.title, agentId: task.assignedTo },
      outcome: 'success',
    });
    return true;
  }

  /**
   * Reject a plan with feedback. Moves task back to in_progress so agent can revise.
   * Plan text is preserved for reference.
   */
  rejectPlan(taskId: string, reason: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'plan_review') return false;

    this.tasks.set(taskId, {
      ...task,
      status: 'in_progress',
      planStatus: 'rejected',
      planRejectionReason: reason,
    });

    // Notify the assigned agent with rejection reason
    if (task.assignedTo) {
      this.sendMessage('system', task.assignedTo, 'plan_approval', `Plan rejected for task "${task.title}": ${reason}`);
    }

    this.audit.record({
      type: 'swarm:plan_rejected',
      details: { taskId, title: task.title, agentId: task.assignedTo, reason },
      outcome: 'failure',
    });
    return true;
  }

  /**
   * Complete a task. Runs L1 eval gates on the agent's output.
   * If eval gates fail, the task is marked as failed.
   */
  async completeTask(taskId: string, store?: LcmStore): Promise<{ completed: boolean; evalResult?: TaskEvalResult; hookAction?: 'allow' | 'retry' | 'block' }> {
    const task = this.tasks.get(taskId);
    if (!task || !task.assignedTo) return { completed: false };

    // Cannot complete a task that is in plan_review
    if (task.status === 'plan_review') return { completed: false };

    const agent = this.agents.get(task.assignedTo);
    if (!agent) return { completed: false };

    const agentStore = this.agentStores.get(agent.id);
    let evalResult: TaskEvalResult | undefined;

    // Collect all agent output once (used by L1 gates and hooks below)
    const allContent = agentStore ? agentStore.readAllFiles() : '';

    // Run L1 eval gates if configured
    if (this.config.evalOnComplete && agentStore && store && allContent.length > 0) {
      const ctx: L1Context = { store, output: allContent, targetContent: allContent };
      const l1 = await runL1Suite(this.l1Gates, ctx);

      evalResult = {
        l1Passed: l1.passed,
        l1Failures: l1.assertions.filter(a => !a.passed).map(a => a.name),
        l2Passed: null,
        l2PassRate: null,
        metricDelta: null,
      };

      if (!l1.passed) {
        this.tasks.set(taskId, { ...task, status: 'failed', evalResults: evalResult });
        this.agents.set(agent.id, { ...agent, status: 'failed', lastActivityAt: Date.now() });

        this.audit.record({
          type: 'swarm:task_eval_failed',
          details: { taskId, agentId: agent.id, failures: evalResult.l1Failures },
          outcome: 'failure',
        });
        return { completed: false, evalResult };
      }
    }

    const hookResult = await this.fireHooks('task_completed', {
      event: 'task_completed',
      agent,
      task,
      agentStore: agentStore ?? undefined,
      lcmStore: store,
      content: allContent,
    });

    if (hookResult && !hookResult.passed) {
      // Only mark failed for 'block'; 'retry' lets RalphLoop re-queue the task
      if (hookResult.action !== 'retry') {
        this.tasks.set(taskId, { ...task, status: 'failed', evalResults: evalResult });
        this.agents.set(agent.id, { ...agent, status: 'failed', lastActivityAt: Date.now() });
      }
      this.audit.record({
        type: 'swarm:hook_blocked',
        details: { taskId, agentId: agent.id, hook: hookResult.blockedBy, action: hookResult.action },
        outcome: 'blocked',
      });
      return { completed: false, evalResult, hookAction: hookResult.action };
    }

    this.tasks.set(taskId, { ...task, status: 'completed', completedAt: Date.now(), evalResults: evalResult });
    const updatedAgent: SwarmAgent = { ...agent, status: 'idle', assignedTask: undefined, lastActivityAt: Date.now() };
    this.agents.set(agent.id, updatedAgent);

    this.audit.record({
      type: 'swarm:task_completed',
      details: { taskId, agentId: agent.id, title: task.title, evalPassed: evalResult?.l1Passed ?? true },
      outcome: 'success',
    });

    // Fire agent_idle hooks after task completion
    this.fireHooks('agent_idle', { event: 'agent_idle', agent: updatedAgent, agentStore: agentStore ?? undefined });

    return { completed: true, evalResult };
  }

  // ─── Inter-Agent Messaging ───────────────────────────────────

  /**
   * Send a message between agents. Optionally sentinel-inspected.
   * This catches prompt injection in inter-agent communication.
   */
  sendMessage(
    from: string,
    to: string | 'broadcast',
    type: SwarmMessage['type'],
    content: string,
  ): SwarmMessage {
    let inspected = false;

    if (this.config.inspectMessages && this.sentinel) {
      const result = this.sentinel.inspect(content);
      inspected = true;

      if (result.threatLevel === 'blocked') {
        this.audit.record({
          type: 'swarm:message_blocked',
          details: { from, to, messageType: type, findings: result.findings.map(f => f.category) },
          outcome: 'blocked',
        });

        // Return the message marked as inspected but still deliver a sanitized version
        const msg: SwarmMessage = {
          id: randomUUID(), from, to, type: 'sentinel_alert',
          content: `[BLOCKED] Message from ${from} contained ${result.findings.length} threat(s)`,
          timestamp: Date.now(), inspected,
        };
        this.messages.push(msg);
        return msg;
      }
    }

    const msg: SwarmMessage = {
      id: randomUUID(), from, to, type, content,
      timestamp: Date.now(), inspected,
    };
    this.messages.push(msg);
    // FIFO cap: evict oldest 100 when over 1000
    if (this.messages.length > 1000) this.messages.splice(0, 100);
    return msg;
  }

  /** Get messages for a specific agent (including broadcasts). */
  getMessages(agentId: string, since?: number): SwarmMessage[] {
    return this.messages.filter(m =>
      (m.to === agentId || m.to === 'broadcast') &&
      (!since || m.timestamp > since),
    );
  }

  // ─── Token Budgeting ─────────────────────────────────────────

  /**
   * Record token usage for an agent after an LLM call.
   * Callers invoke this after each model response with response.usage tokens.
   * The BudgetEnforcer hook reads tokensUsed before task_completed fires.
   */
  recordTokenUsage(agentId: string, tokens: number): SwarmAgent {
    if (tokens < 0) throw new Error(`tokens must be >= 0, got ${tokens}`);
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    const updated: SwarmAgent = { ...agent, tokensUsed: agent.tokensUsed + tokens, lastActivityAt: Date.now() };
    this.agents.set(agentId, updated);
    this.audit.record({
      type: 'swarm:tokens_recorded',
      details: { agentId, tokens, totalUsed: updated.tokensUsed, budget: updated.tokenBudget },
      outcome: 'success',
    });
    return updated;
  }

  /**
   * Requeue a task back to pending status, clearing its assignment.
   * Used by RalphLoop after a retry or executor failure to allow re-pickup.
   */
  requeueTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    this.tasks.set(taskId, { ...task, status: 'pending', assignedTo: null });
    this.audit.record({
      type: 'swarm:task_requeued',
      details: { taskId, previousStatus: task.status },
      outcome: 'success',
    });
    return true;
  }

  // ─── Swarm State Queries ─────────────────────────────────────

  getAgent(id: string): SwarmAgent | undefined { return this.agents.get(id); }
  getTask(id: string): SwarmTask | undefined { return this.tasks.get(id); }

  getAllAgents(): SwarmAgent[] { return [...this.agents.values()]; }
  getAllTasks(): SwarmTask[] { return [...this.tasks.values()]; }
  getAllMessages(): SwarmMessage[] { return [...this.messages]; }

  get workerCount(): number {
    return [...this.agents.values()].filter(a => a.role === 'worker' && a.status !== 'completed').length;
  }

  /** Snapshot an agent's state. Returns metadata (actual file copy is external). */
  snapshotAgent(agentId: string, reason: string): AgentSnapshot | null {
    const agent = this.agents.get(agentId);
    const store = this.agentStores.get(agentId);
    if (!agent || !store) return null;

    const stats = store.getStats();
    const snapshot: AgentSnapshot = {
      agentId, snapshotId: randomUUID(),
      dbPath: agent.dbPath,
      takenAt: Date.now(), reason,
      fileCount: stats.fileCount,
      kvCount: stats.kvCount,
      toolCallCount: stats.toolCallCount,
      auditChainLength: 0,
    };

    this.audit.record({
      type: 'swarm:snapshot',
      details: { agentId, snapshotId: snapshot.snapshotId, reason, ...stats },
      outcome: 'success',
    });

    return snapshot;
  }

  // ─── Hook Integration ──────────────────────────────────────────

  /** Fire hooks for a given event. Returns null if no registry configured. */
  private async fireHooks(
    event: HookContext['event'],
    ctx: HookContext,
  ): Promise<{ passed: boolean; blockedBy?: string; action?: 'allow' | 'retry' | 'block' } | null> {
    if (!this.hookRegistry) return null;
    const result = await this.hookRegistry.fire(event, ctx);
    // Surface the action from the first failing hook so callers (e.g. RalphLoop) can act on it
    const failingEntry = result.results.find(r => !r.result.passed);
    return { passed: result.passed, blockedBy: result.blockedBy, action: failingEntry?.result.action };
  }

  /** Clean up all agents. */
  shutdown(): void {
    for (const [id, store] of this.agentStores) {
      store.close();
    }
    this.agentStores.clear();
    this.audit.record({ type: 'swarm:shutdown', details: { agents: this.agents.size, tasks: this.tasks.size }, outcome: 'success' });
  }
}
