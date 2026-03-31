# CLAUDE.md — OpenHarness Project Brief

## What This Is

OpenHarness is a compliance-first, privacy-first AI agent harness for regulated industries. It wraps agent runtimes (OpenClaw, DeerFlow, Claude Code swarms) in a cryptographically governed trust envelope with sentinel content inspection, RBAC, tamper-proof audit logging, and eval gates.

**The stack has 5 layers:**

1. **LCM v2 (Memory Engine)** — SQLite/PostgreSQL stores, summarization DAG, topic segmentation, hybrid FTS+vector search, PII detection, retention enforcement
2. **VaultClaw Secure (Governance)** — SecureStore decorator with RBAC (4 roles, 6 permissions), sentinel pipeline, dual audit logging, withUser() for multi-tenant
3. **OpenHarness Evals (Karpathy Loop + Hamel Gates)** — L1 deterministic assertions (hard gates), L2 binary LLM judges, EvalHarness orchestrator with composite commit/revert
4. **PrivateLaunch (Xcode Agent)** — NL description → AppSpec → SwiftUI codegen → sentinel check → L1 eval gate → Xcode project. Targets fully local App Store pipeline
5. **AgentFS Integration (Governed Swarms)** — SQLite-backed agent filesystem with sentinel on every write, GovernedSwarm multi-agent orchestration with per-agent isolation, task board, inter-agent messaging inspection

## Current State

- **25 source files** (src/), **9 test files** (test/)
- **165 tests, all passing**
- Clean TypeScript compilation (strict mode)
- Python FastAPI backend (9 files, 29 tests) serving the stack to frontend

## Tech Stack

- TypeScript (ESM, Node 22+, built-in SQLite)
- Vitest for testing
- Pydantic v2 + FastAPI for Python backend
- SQLite (node:sqlite) for all persistence
- AES-256-GCM encryption in VaultClaw standalone

## Architecture Invariants

- **Sentinel inspects ALL content before persistence** — no write reaches the store uninspected
- **RBAC checked BEFORE every operation** — SecureStore decorator pattern
- **Eval harness is READ-ONLY to autonomous agents** — agents cannot modify eval infrastructure
- **Audit ledger is append-only, hash-chained** — tamper-evident via SHA-256 chain
- **Every AgentFS write is governed** — sentinel + audit on file operations AND tool calls
- **Inter-agent messages are sentinel-inspected** — catches prompt injection in swarm communication

## File Structure

```
src/
├── agentfs/           # AgentFS integration + governed swarms
│   ├── types.ts       # Agent filesystem, swarm, tool call types
│   ├── store.ts       # AgentFSStore — SQLite FS with sentinel governance
│   └── swarm.ts       # GovernedSwarm — multi-agent orchestration
├── evals/             # Karpathy Loop + Hamel Eval system
│   ├── l1-assertions.ts  # 6 deterministic hard gates
│   ├── l2-judges.ts      # 5 binary LLM judge prompts
│   └── harness.ts        # EvalHarness orchestrator
├── launch/            # PrivateLaunch — Xcode agent pipeline
│   ├── types.ts       # AppSpec, pipeline stages, App Store metadata
│   ├── spec-generator.ts # NL → structured AppSpec via LLM
│   ├── codegen.ts     # AppSpec → SwiftUI source files
│   └── pipeline.ts    # LaunchPipeline orchestrator
├── secure/            # VaultClaw governance layer
│   ├── secure-store.ts   # SecureStore decorator (RBAC + sentinel + audit)
│   └── secure-pipeline.ts # SecureIngestionPipeline
├── ingestion/         # LCM v2 ingestion pipeline
│   ├── pipeline.ts    # IngestionPipeline
│   ├── pii-detector.ts
│   ├── topic-segmenter.ts
│   ├── pre-compressor.ts
│   └── embedding-generator.ts
├── store/             # Storage backends
│   ├── lcm-store.ts   # LcmStore interface (40+ methods)
│   ├── sqlite-store.ts # SQLite implementation
│   ├── pg-store.ts    # PostgreSQL implementation
│   └── factory.ts     # Store factory
├── types/index.ts     # Shared types
├── db/                # Migration scripts
└── util/math.ts       # Cosine similarity, etc.

backend/               # Python FastAPI backend
├── app/
│   ├── main.py        # FastAPI routes (8 endpoints)
│   ├── models/schemas.py  # Pydantic v2 models
│   ├── security/__init__.py # Sentinel + RBAC + Audit (Python port)
│   └── services/app_service.py # Pipeline orchestrator
└── tests/test_api.py  # 29 tests
```

## Commands

```bash
# TypeScript
npm test                    # Run all 165 tests
npx tsc --noEmit           # Type check

# Python backend
cd backend
python -m pytest tests/ -v  # Run all 29 tests
uvicorn app.main:app --reload --port 8000  # Start dev server
```

## Known Bugs Fixed (From Deep Code Reviews)

All found and fixed — reference docs/reviews/ for details:
- C1: Swift code injection via unsanitized identifiers → sanitizeSwiftId() + sanitizeDefault()
- C2: Sentinel stage mislabeled as 'build' → added sentinel_check to PipelineStage
- I1: latencyGate measured its own overhead → reads ctx.latencyMs
- I2: No runtime enum validation in spec generator → validate against allowed sets
- I3: Empty project on pipeline failure → return null
- JSON-breaking redaction (hit twice) → operate on values by key name, not raw JSON

---

## NEXT STEPS — What To Build

### Priority 1: Plan Approval Flow (src/agentfs/swarm.ts)

Add a plan-review step between task assignment and execution:

```
task created → assigned → agent writes plan → lead reviews → approve/reject → implement
```

Changes needed:
- Add `plan?: string` and `planStatus?: 'pending' | 'approved' | 'rejected'` to `SwarmTask` type
- Add `status: 'plan_review'` to task status union
- New methods on GovernedSwarm:
  - `submitPlan(taskId: string, plan: string): void` — sentinel inspects plan, sets status to plan_review
  - `approvePlan(taskId: string): boolean` — moves to in_progress
  - `rejectPlan(taskId: string, reason: string): boolean` — moves back to pending with feedback
- Task cannot move to in_progress without approved plan
- Audit log: plan_submitted, plan_approved, plan_rejected
- Tests: plan submission, approval flow, rejection + revision, sentinel blocks injection in plans

### Priority 2: Lifecycle Hooks System (src/agentfs/hooks.ts — NEW FILE)

Extensible hook system firing on swarm lifecycle events:

```typescript
type SwarmEvent = 'agent_spawned' | 'task_assigned' | 'plan_submitted' |
  'task_completed' | 'agent_idle' | 'message_sent' | 'snapshot_taken';

interface SwarmHook {
  event: SwarmEvent;
  name: string;
  handler: (ctx: HookContext) => Promise<HookResult>;
}

interface HookResult {
  passed: boolean;
  feedback?: string;
  action: 'allow' | 'retry' | 'block';
}
```

- Register hooks on GovernedSwarm construction
- Fire hooks at appropriate points in existing methods
- Built-in hooks: sentinelHook, l1EvalHook, reflectionHook
- Hook failure with action='retry' → agent retries (up to maxRetries)
- Hook failure with action='block' → task fails, audit logged
- Tests: hook registration, firing order, retry logic, block propagation

### Priority 3: Ralph Loop (src/agentfs/ralph-loop.ts — NEW FILE)

Stateless-but-iterative task execution:

```typescript
class RalphLoop {
  constructor(config: RalphConfig) {}
  async run(): Promise<RalphResult> {
    while (tasks remain) {
      1. Pick next task from queue
      2. Spawn fresh agent (clean context)
      3. Execute task
      4. Run L1 + L2 eval gates
      5. If pass → commit + mark complete
      6. If fail → revert + increment retry counter
      7. If stuck (3+ retries on same error) → kill agent, reassign task
      8. Reset agent context (close AgentFSStore, open fresh one)
      9. Log iteration to audit
    }
  }
}
```

- Kill criteria: maxIterations, maxTokens, stuckThreshold
- Memory channels surviving reset: audit ledger, task state (kv store), AGENTS.md (compound memory)
- Stuck detection: query last N tool calls for identical error patterns
- Tests: full loop with mock tasks, stuck detection + reassignment, eval gate failures

### Priority 4: Compound Memory / AGENTS.md (src/agentfs/compound-memory.ts — NEW FILE)

Human-curated shared knowledge that compounds across sessions:

```typescript
class CompoundMemory {
  constructor(store: AgentFSStore) {}
  loadContext(): string
  proposeUpdate(section: string, entry: string, agentId: string): string
  approveUpdate(proposalId: string): boolean
  rejectUpdate(proposalId: string, reason: string): boolean
}
```

- Sections: STYLE, GOTCHAS, ARCH_DECISIONS, TEST_STRATEGY
- Agents NEVER write directly (per ETH Zurich research)
- All updates go through proposal → approval pipeline
- Backed by AgentFS kv store with `agents_md:` prefix

### Priority 5: Token Budgeting (extend SwarmAgent + AgentFSStore)

- Add `tokenBudget` and `tokensUsed` to SwarmAgent
- BudgetEnforcer hook: pause at 85%, kill at 100%
- Stuck detector: query tool calls for identical error patterns

### Priority 6: Python Backend Endpoints for New Features

After each TypeScript feature ships, port to FastAPI:
- `POST /api/swarm/tasks/{id}/plan` — submit plan
- `POST /api/swarm/tasks/{id}/plan/approve` — approve plan
- `POST /api/swarm/tasks/{id}/plan/reject` — reject plan
- `GET /api/swarm/hooks` — list registered hooks
- `POST /api/swarm/ralph/start` — start a Ralph Loop
- `GET /api/swarm/memory` — compound memory sections
- `POST /api/swarm/memory/propose` — propose AGENTS.md update

---

## Claude Code Session Commands

Copy-paste these to start working:

```bash
# Start a new session — read this file first
cat CLAUDE.md

# Verify everything works before making changes
npm test && npx tsc --noEmit

# After making changes, always run
npm test && npx tsc --noEmit

# Package a release
tar czf openharness-v0.X.0.tar.gz --exclude=node_modules --exclude=.git --exclude=dist src/ test/ index.ts package.json tsconfig.json vitest.config.ts CLAUDE.md README.md docs/ tasks/
```

## Style

- Functional where possible, classes for stateful components
- `readonly` on all interface fields
- Explicit return types on all public functions
- No `any` — use `unknown` with type guards
- Tests co-located in test/ matching src/ structure
- Every new feature needs tests BEFORE declaring done
