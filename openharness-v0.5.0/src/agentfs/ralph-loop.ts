/**
 * Ralph Loop — stateless-but-iterative task execution.
 *
 * Drives a GovernedSwarm in a loop, spawning fresh agents per task.
 * Implements stuck detection: if the last N tool calls from an agent
 * have identical error strings, the agent is killed and the task is
 * reassigned to a fresh agent.
 *
 * Memory surviving agent reset:
 *   - Audit ledger (append-only, never reset)
 *   - Task state in GovernedSwarm (task board persists)
 *   - AGENTS.md sections in CompoundMemory (backed by a separate shared store)
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │                     Ralph Loop                       │
 *   │                                                      │
 *   │  while pending tasks && iterations < maxIterations:  │
 *   │    1. Pick highest-priority pending task             │
 *   │    2. Spawn fresh worker agent                       │
 *   │    3. assignTask(taskId, agentId)                   │
 *   │    4. [caller executes task externally]              │
 *   │    5. completeTask(taskId)                           │
 *   │       ├── PASS → mark done, shutdownAgent           │
 *   │       ├── RETRY → increment retries, reset agent    │
 *   │       └── BLOCK/FAIL → mark failed, shutdownAgent   │
 *   │    6. Stuck check: same error N times → kill+reassign│
 *   └─────────────────────────────────────────────────────┘
 */
import type { GovernedSwarm } from './swarm.js';
import type { SwarmTask, SwarmRole } from './types.js';
import type { LcmStore } from '../store/lcm-store.js';

export interface RalphConfig {
  /** Maximum loop iterations before aborting (prevents infinite loops) */
  readonly maxIterations: number;
  /** Role to use for spawned worker agents */
  readonly workerRole: SwarmRole;
  /** Model to use for workers (overrides swarm routing) */
  readonly workerModel?: string;
  /**
   * How many consecutive identical errors before declaring agent stuck.
   * Default: 3. Exact string match on tool call output.error.
   */
  readonly stuckThreshold: number;
}

export const DEFAULT_RALPH_CONFIG: RalphConfig = {
  maxIterations: 50,
  workerRole: 'worker',
  stuckThreshold: 3,
};

export interface RalphResult {
  readonly completedTasks: string[];
  readonly failedTasks: string[];
  readonly stuckTasks: string[];
  readonly totalIterations: number;
  readonly abortedByLimit: boolean;
}

/**
 * Task executor callback. The caller is responsible for actually running the
 * agent's work (LLM calls, tool use). Ralph Loop manages spawning, assignment,
 * eval, and retry — the executor implements the actual task logic.
 *
 * The executor receives the task and the agentId of the spawned worker.
 * It should call swarm.recordTokenUsage() after each LLM response.
 */
export type TaskExecutor = (task: SwarmTask, agentId: string) => Promise<void>;

export class RalphLoop {
  private readonly swarm: GovernedSwarm;
  private readonly config: RalphConfig;

  constructor(swarm: GovernedSwarm, config: Partial<RalphConfig> = {}) {
    this.swarm = swarm;
    this.config = { ...DEFAULT_RALPH_CONFIG, ...config };
  }

  /**
   * Run the loop until all tasks complete, a limit is hit, or tasks are stuck.
   *
   * @param executor - Callback that runs the actual agent work for a task.
   * @param store - Optional LcmStore for L1 eval gates in completeTask().
   */
  async run(executor: TaskExecutor, store?: LcmStore): Promise<RalphResult> {
    const completed: string[] = [];
    const failed: string[] = [];
    const stuck: string[] = [];
    /** Retry counter per task: taskId → retry count */
    const retryCount = new Map<string, number>();
    /** Last error string per task for stuck detection */
    const errorHistory = new Map<string, string[]>();

    let iterations = 0;

    while (iterations < this.config.maxIterations) {
      const pending = this.swarm.getAllTasks().filter(t => t.status === 'pending');
      if (pending.length === 0) break;

      // Pick highest-priority pending task (lower priority number = higher priority)
      const task = pending.sort((a, b) => a.priority - b.priority)[0]!;
      iterations++;

      // Spawn fresh worker for this iteration
      const agent = this.swarm.spawnAgent(
        `ralph-worker-${iterations}`,
        this.config.workerRole,
        this.config.workerModel,
      );

      // Assign task
      const assigned = this.swarm.assignTask(task.id, agent.id);
      if (!assigned) {
        // Dependencies not met — skip and let another iteration handle it
        this.swarm.shutdownAgent(agent.id);
        continue;
      }

      // Execute task (caller does the actual LLM work)
      try {
        await executor(task, agent.id);
      } catch (err) {
        // Executor threw — record error, treat as failed iteration
        const errMsg = err instanceof Error ? err.message : String(err);
        this.trackError(errorHistory, task.id, errMsg);
        this.swarm.shutdownAgent(agent.id);

        if (this.isStuck(errorHistory, task.id)) {
          stuck.push(task.id);
          failed.push(task.id);
          errorHistory.delete(task.id);
        } else {
          // Re-queue so the next iteration can pick it up
          this.swarm.requeueTask(task.id);
        }
        continue;
      }

      // Attempt to complete the task through eval gates
      const result = await this.swarm.completeTask(task.id, store);

      if (result.completed) {
        completed.push(task.id);
        this.swarm.shutdownAgent(agent.id);
        retryCount.delete(task.id);
        errorHistory.delete(task.id);
        continue;
      }

      // Task did not complete
      const hookAction = result.hookAction;

      if (hookAction === 'retry') {
        // Re-queue the task for retry
        const retries = (retryCount.get(task.id) ?? 0) + 1;
        retryCount.set(task.id, retries);

        this.swarm.shutdownAgent(agent.id);
        this.swarm.requeueTask(task.id);
      } else {
        // block or no hook action — task is failed
        failed.push(task.id);
        this.swarm.shutdownAgent(agent.id);
        retryCount.delete(task.id);
        errorHistory.delete(task.id);
      }
    }

    const abortedByLimit = iterations >= this.config.maxIterations &&
      this.swarm.getAllTasks().some(t => t.status === 'pending');

    return {
      completedTasks: completed,
      failedTasks: failed,
      stuckTasks: stuck,
      totalIterations: iterations,
      abortedByLimit,
    };
  }

  /** Track an error string for a task, keeping only the last stuckThreshold entries. */
  private trackError(history: Map<string, string[]>, taskId: string, error: string): void {
    const existing = history.get(taskId) ?? [];
    existing.push(error);
    if (existing.length > this.config.stuckThreshold) {
      existing.shift();
    }
    history.set(taskId, existing);
  }

  /**
   * Stuck detection: all tracked errors for the task are identical (exact string match).
   * Requires at least stuckThreshold entries.
   */
  private isStuck(history: Map<string, string[]>, taskId: string): boolean {
    const errors = history.get(taskId) ?? [];
    if (errors.length < this.config.stuckThreshold) return false;
    return errors.every(e => e === errors[0]);
  }
}
