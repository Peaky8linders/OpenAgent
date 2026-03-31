/**
 * AgentFS Integration Types
 *
 * Models the Turso AgentFS schema (inode, dentry, kv, toolcall tables)
 * plus OpenHarness extensions for governed swarm orchestration.
 *
 * AgentFS handles: filesystem isolation, state portability, tool call recording
 * OpenHarness adds: sentinel inspection, RBAC, compliance audit, eval gates
 */

// ─── AgentFS Core (mirrors Turso schema) ─────────────────────────

export interface AgentFSConfig {
  /** Path to the .db file (or ':memory:' for tests) */
  readonly dbPath: string;
  /** Agent ID — unique per agent in a swarm */
  readonly agentId: string;
  /** Human-readable agent name */
  readonly agentName?: string;
  /** Whether this is a read-only base layer */
  readonly readOnly?: boolean;
}

/** File inode — mirrors AgentFS inode table */
export interface AgentInode {
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
  readonly mtime: number;
  readonly ctime: number;
  readonly data: Uint8Array | null;
}

/** Directory entry — mirrors AgentFS dentry table */
export interface AgentDentry {
  readonly parent_ino: number;
  readonly name: string;
  readonly ino: number;
  readonly file_type: 'file' | 'directory' | 'symlink';
}

/** Key-value entry — mirrors AgentFS kv table */
export interface AgentKVEntry {
  readonly key: string;
  readonly value: string; // JSON-serialized
  readonly updated_at: number;
}

/** Tool call record — mirrors AgentFS toolcall table (append-only) */
export interface AgentToolCall {
  readonly id: string;
  readonly agent_id: string;
  readonly tool_name: string;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown> | null;
  readonly status: 'pending' | 'success' | 'error' | 'blocked';
  readonly started_at: number;
  readonly completed_at: number | null;
  readonly duration_ms: number | null;
  /** OpenHarness extension: sentinel result for this tool call */
  readonly sentinel_result?: 'safe' | 'suspicious' | 'blocked';
  /** OpenHarness extension: which eval gates were checked */
  readonly eval_gates_checked?: string[];
}

// ─── Swarm Coordination ──────────────────────────────────────────

export type SwarmRole = 'lead' | 'worker' | 'reviewer' | 'sentinel';

export interface SwarmAgent {
  readonly id: string;
  readonly name: string;
  readonly role: SwarmRole;
  readonly model: string;
  /** Isolated AgentFS database path */
  readonly dbPath: string;
  readonly status: 'idle' | 'working' | 'blocked' | 'completed' | 'failed';
  readonly assignedTask?: string;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  /** Token budget for this agent (undefined = unlimited) */
  readonly tokenBudget?: number;
  /** Cumulative tokens used by this agent across all tasks */
  readonly tokensUsed: number;
}

export type TaskStatus = 'pending' | 'claimed' | 'in_progress' | 'plan_review' | 'review' | 'completed' | 'failed';
export type PlanStatus = 'pending' | 'approved' | 'rejected';

export interface SwarmTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly assignedTo: string | null;
  readonly status: TaskStatus;
  readonly dependencies: string[];
  readonly priority: number;
  readonly createdAt: number;
  readonly completedAt: number | null;
  /** Eval gate results for this task's output */
  readonly evalResults?: TaskEvalResult;
  /** Agent's implementation plan (submitted before execution) */
  readonly plan?: string;
  /** Plan review status */
  readonly planStatus?: PlanStatus;
  /** Reason for plan rejection (feedback for agent) */
  readonly planRejectionReason?: string;
}

export interface TaskEvalResult {
  readonly l1Passed: boolean;
  readonly l1Failures: string[];
  readonly l2Passed: boolean | null; // null if not run
  readonly l2PassRate: number | null;
  readonly metricDelta: number | null;
}

export interface SwarmMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string | 'broadcast';
  readonly type: 'task_assignment' | 'status_update' | 'review_request' | 'finding'
    | 'shutdown_request' | 'plan_approval' | 'sentinel_alert';
  readonly content: string;
  readonly timestamp: number;
  /** Whether sentinel inspected this message */
  readonly inspected: boolean;
}

export interface SwarmConfig {
  /** Maximum concurrent workers */
  readonly maxWorkers: number;
  /** Model routing: which model for which role */
  readonly modelRouting: Record<SwarmRole, string>;
  /** Whether to run sentinel on inter-agent messages */
  readonly inspectMessages: boolean;
  /** Whether to run eval gates on task completions */
  readonly evalOnComplete: boolean;
  /** Base directory for agent .db files */
  readonly workspaceDir: string;
}

// ─── Governed Operations ─────────────────────────────────────────

/**
 * A file write that has been inspected by the sentinel.
 * Only governed writes reach the AgentFS.
 */
export interface GovernedWrite {
  readonly path: string;
  readonly content: string;
  readonly agentId: string;
  readonly inspectionResult: 'safe' | 'suspicious' | 'blocked';
  readonly allowed: boolean;
  readonly timestamp: number;
}

/**
 * A snapshot of an agent's complete state.
 * `cp agent.db snapshot.db` equivalent, but with audit metadata.
 */
export interface AgentSnapshot {
  readonly agentId: string;
  readonly snapshotId: string;
  readonly dbPath: string;
  readonly takenAt: number;
  readonly reason: string;
  readonly fileCount: number;
  readonly kvCount: number;
  readonly toolCallCount: number;
  readonly auditChainLength: number;
}
