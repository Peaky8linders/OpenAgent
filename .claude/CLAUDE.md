# OpenAgent / VaultClaw — Private Compliance Agent

## Project Overview
A fully private coding agent with compliance-grade security for regulated industries.
Built on Harrison Chase's open stack + LCM v2 encrypted memory + compliance engine.
- **Model**: NVIDIA Nemotron 3 Super (120B/12B MoE, 1M context) via cloud API
- **Runtime**: NVIDIA OpenShell (sandboxed, policy-driven isolation)
- **Harness**: LangChain DeepAgents 0.4.x (planning, filesystem, sub-agents)
- **Memory**: Brainiac (cross-project knowledge graph) + LCM v2 (encrypted per-session)
- **Compliance**: HIPAA, SOC 2, PCI-DSS, GDPR policy packs with sentinel enforcement
- **Product**: VaultClaw — developer tool → enterprise (open-source core)

## Architecture
```
┌─────────────────────────────────────────────┐
│  CLI (openagent/cli.py)                      │
│  --compliance hipaa|soc2|pci|gdpr|none       │
│  --airgap (offline mode with Ollama)         │
├─────────────────────────────────────────────┤
│  Agent (openagent/agent.py)                  │
│  DeepAgents + 18 tools + compliance context  │
├────────────────────┬────────────────────────┤
│  Brainiac Memory   │  LCM v2 Secure Memory  │
│  Cross-project     │  Per-session encrypted  │
│  Knowledge graph   │  RBAC + sentinel + audit│
├────────────────────┴────────────────────────┤
│  Compliance Engine (openagent/compliance.py)  │
│  Frozen policy packs, scoring, enforcement   │
├─────────────────────────────────────────────┤
│  Dashboard (openagent/dashboard.py)           │
│  REST API for compliance monitoring + export │
├─────────────────────────────────────────────┤
│  Contract Tools (openagent/contract_tools.py) │
│  PDF/DOCX ingestion, PII scan, clause review │
├─────────────────────────────────────────────┤
│  Model: ChatNVIDIA → Nemotron 3 Super        │
│  Air-gap: Ollama for offline inference       │
│  Config: Pydantic v2 + YAML (Literal-typed)  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  ClawGuard iOS (openharness-swift/ios/)       │
│  Swift 6 / iOS 17+ native client             │
│  Keychain vault, sentinel, audit ledger      │
├─────────────────────────────────────────────┤
│  ClawGuard Backend (openharness-swift/app/)   │
│  FastAPI: chat, sentinel, audit, compliance  │
│  Mobile API: connect, chat, session          │
└─────────────────────────────────────────────┘
```

## Key Files
- `main.py` — Thin entry point → `openagent.cli.main()`
- `openagent/cli.py` — Interactive REPL + single-task + --compliance + --airgap flags
- `openagent/agent.py` — Agent factory (model + backend + memory + compliance)
- `openagent/compliance.py` — Policy packs, scoring, enforcement (frozen, immutable)
- `openagent/config.py` — Pydantic v2 config (Literal-validated compliance field)
- `openagent/model.py` — ChatNVIDIA model factory
- `openagent/backend.py` — LocalShellBackend factory
- `openagent/memory.py` — Brainiac knowledge graph integration
- `openagent/tools.py` — 6 custom tools (3 brainiac + 3 LCM) + policy enforcement
- `openagent/lcm_client.py` — Python HTTP client for LCM server
- `openagent/airgap.py` — Air-gap mode: offline operation with Ollama local LLMs
- `openagent/contract_tools.py` — Contract review: PDF/DOCX ingestion, PII scan, clause analysis
- `openagent/dashboard.py` — Compliance dashboard REST API (scoring history, audit export)
- `packages/lcm/` — LCM v2 TypeScript (SecureStore, sentinel, PII, audit chain)
- `packages/lcm/server.ts` — LCM HTTP server (loopback-only)
- `openharness-v0.3.0/` — LCM v2 + OpenHarness eval framework (superset of packages/lcm)
- `openharness-v0.3.0/src/evals/` — L1 assertions, L2 judges, EvalHarness orchestrator
- `openharness-swift/` — ClawGuard: iOS native client + FastAPI backend
- `openharness-swift/ios/` — Swift 6 package (ClawGuardCore library)
- `openharness-swift/app/main.py` — FastAPI backend (app gen, sentinel, audit, mobile API)
- `config/agent-config.yaml` — Agent + model + compliance config
- `config/sandbox-policy.yaml` — OpenShell security policies
- `scripts/quickstart.sh` — One-command installer for OpenAgent/VaultClaw

## Agent Tools (18 total)
| Tool | Source | Purpose |
|------|--------|---------|
| `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep` | DeepAgents | Filesystem |
| `execute` | DeepAgents + LocalShellBackend | Shell commands |
| `write_todos` | DeepAgents | Planning / task tracking |
| `task` | DeepAgents | Sub-agent spawning |
| `memory_search` | Brainiac | Cross-project knowledge search |
| `memory_save` | Brainiac | Save learnings to graph |
| `memory_stats` | Brainiac | Graph statistics |
| `secure_store` | LCM | Encrypted message storage + policy enforcement |
| `secure_search` | LCM | PII-aware conversation search |
| `audit_trail` | LCM | Tamper-proof compliance audit chain |
| `contract_ingest` | Contract Tools | PDF/DOCX/TXT document ingestion |
| `contract_pii_scan` | Contract Tools | PII detection in documents |
| `contract_clause_review` | Contract Tools | Clause analysis for legal review |
| `compliance_dashboard` | Dashboard | Compliance scoring + audit export API |

## Compliance
- `--compliance hipaa|soc2|pci|gdpr|none` (CLI flag or YAML config)
- Frozen policy packs (MappingProxyType, model_config frozen)
- Real-time scoring (0.0-1.0) per agent action
- PII under REDACT_ALL = hard block (blocked=True)
- Sentinel extra patterns enforced locally before LCM
- YAML compliance validated as Literal type at load time

## Development Rules
- OpenShell is Linux-only; use WSL or Docker on Windows
- Never hardcode API keys — always use `NVIDIA_API_KEY` env var
- DeepAgents is model-agnostic; swap models via `init_chat_model()`
- Test agent changes with `--task` flag before interactive mode
- Sandbox policies are hot-reloadable — no container restart needed
- Run `uv run pytest tests/ -v` before and after changes
- Run `uv run ruff check openagent/ tests/` for lint

## Dependencies
- Python 3.14+ with `uv` package manager
- Docker Desktop (required for OpenShell sandboxes)
- `deepagents` 0.4.x — agent harness
- `langchain-nvidia-ai-endpoints` — NVIDIA model integration
- `numpy` + `sentence-transformers` — for brainiac embeddings
- OpenShell CLI (installed via WSL/Linux)
- NemoClaw CLI (bundles OpenShell + Nemotron setup)

## Environment Variables
```
NVIDIA_API_KEY     — Required. Get free at https://build.nvidia.com
LANGSMITH_API_KEY  — Optional. For LangSmith tracing
```

## Common Commands
```bash
# Quick start (one-command installer)
bash scripts/quickstart.sh

# Start PostgreSQL + pgvector (required for LCM memory)
cd packages/lcm && docker compose up -d

# Run agent locally (no sandbox)
NVIDIA_API_KEY=nvapi-xxx python main.py

# Run in air-gap mode (offline, Ollama)
python main.py --airgap

# Run single task
python main.py --task "Create a FastAPI server with health endpoint"

# Run LCM tests (uses in-memory SQLite, no Postgres needed)
cd packages/lcm && npm test

# Run ClawGuard backend
cd openharness-swift && uvicorn app.main:app --reload

# Setup OpenShell (in WSL/Linux)
bash scripts/setup-wsl.sh

# Launch sandboxed agent
bash scripts/run-sandbox.sh
```

## OpenShell CLI Reference (verified March 2026)
```bash
# All commands run in WSL: wsl -d Ubuntu-24.04 -- bash -c '...'
export PATH="/root/.local/bin:$PATH"

# Gateway management
openshell gateway start --name nemoclaw           # Start gateway (uses port 8080)
openshell gateway start --name nemoclaw --port 9090  # Custom port
openshell gateway stop --name nemoclaw            # Stop (preserves state)
openshell gateway destroy --name nemoclaw         # Full teardown
openshell gateway info                            # Show active gateway
openshell gateway select <name>                   # Switch active gateway

# Sandbox management
openshell sandbox create --name <name> --from python  # Create from template
openshell sandbox list                            # List all sandboxes
openshell sandbox connect <name>                  # SSH into sandbox
openshell sandbox delete <name>                   # Delete (positional arg, no --name flag!)
openshell sandbox upload <name> --local <path>    # Upload files
openshell sandbox download <name> --remote <path> # Download files

# NemoClaw
nemoclaw onboard                                  # Interactive setup wizard
nemoclaw <sandbox> connect                        # Connect to sandbox
```

## Sandbox Templates
| Template | Contents |
|----------|---------|
| `base` (default) | Claude, OpenCode, Codex agents; Python 3.13, Node 22; git, gh, vim, nano |
| `python` | Python-focused (larger image, slower pull) |
| `openclaw` | OpenClaw agent from community catalog |
| `ollama` | Local LLM inference via Ollama |
| Custom | Local Dockerfile dirs or registry URIs |

**Tip**: Use `--from base` for fastest setup. Use `--gpu` flag for GPU-enabled sandboxes.

## OpenShell Policy Model (deny-by-default)
| Domain | Purpose | Mutability |
|--------|---------|-----------|
| Filesystem | Restrict read/write paths | Locked at creation |
| Network | Control outbound connections | Hot-reloadable |
| Process | Block privilege escalation | Locked at creation |
| Inference | Route LLM API calls | Hot-reloadable |

- Agent cannot disable its own guardrails (enforcement is outside the agent process)
- Credentials injected as env vars at runtime, never written to sandbox filesystem
- Under the hood: K3s Kubernetes cluster inside a single Docker container
- Update live policies: `openshell policy set <name> --policy FILE --wait`

## Known Issues / Gotchas
- **Port conflicts**: Gateway defaults to 8080. Kill anything on that port first or use `--port`.
- **TLS cert errors**: If you get `invalid peer certificate: BadSignature`, destroy and recreate the gateway.
- **Image pull timeouts**: `python:latest` sandbox image is large. Use `--from base` instead, or pre-pull: `docker pull ghcr.io/nvidia/openshell-community/sandboxes/python:latest`
- **sandbox delete syntax**: Uses positional arg (`sandbox delete openagent`), NOT `--name` flag.
- **WSL PATH**: Always `export PATH="/root/.local/bin:$PATH"` before running openshell/nemoclaw.
- **Docker Desktop + WSL**: After `wsl --shutdown`, Docker Desktop must be fully restarted (Quit → relaunch) for WSL socket to reconnect.

## NemoClaw Status
NemoClaw is **alpha stage** (March 2026). Expect rough edges. Interfaces may change.

## OpenHarness v0.3.0 (LCM v2 + Eval Framework)

OpenHarness is LCM v2 with an integrated eval framework (Karpathy Loop + Hamel eval gates).
Located at `openharness-v0.3.0/` — superset of `packages/lcm/` with 3 new eval modules.

### What it adds over packages/lcm/
- **`src/evals/l1-assertions.ts`** — Deterministic hard gates (PII leak, cross-tenant, latency, unsafe patterns)
- **`src/evals/l2-judges.ts`** — LLM binary judges per failure mode (correctness, safety, hallucination)
- **`src/evals/harness.ts`** — Orchestrator: L1→L2→metric→decision (commit/revert)

### Key Abstractions
| Layer | Purpose | Gate Type |
|-------|---------|-----------|
| L1 Assertions | Security invariants (PII, isolation, health) | Hard — any fail = revert |
| L2 Judges | Quality checks via LLM scorer | Soft — pass rate ≥ threshold |
| EvalHarness | Orchestrates L1+L2+metric+budget | Composite decision |

### Integration with OpenAgent
- **Store**: `createStore({driver, path})` → SQLite or PostgreSQL
- **Ingestion**: `IngestionPipeline(store, embedGen, config)` — PII→compress→topic→embed→store
- **Security**: `SecureStore(store, user, sentinel, audit)` — RBAC + sentinel + audit chain
- **Evals**: `EvalHarness(config)` — validate agent outputs before commit
- **Python bridge**: `openagent/lcm_client.py` → HTTP → `packages/lcm/server.ts`

### Store Backends
- **PostgreSQL** (pg + pgvector HNSW) — **DEFAULT**, production-grade, multi-tenant, RLS
- **SQLite** (`node:sqlite`, WAL mode) — fallback for dev/testing only

### Known Bugs (from code review)
- **[C1]** FTS entries never deleted on message deletion
- **[C2]** SQL injection in backup() via string interpolation
- **[C3]** regex search returns empty for messages
- **[I1]** deleteMessages() never cleans up embeddings
- **[I2]** LIKE wildcard injection in summary search

### Package Info
- **Name**: `@lcm-v2/core` v0.2.0
- **Runtime**: Node 22+ (uses `node:sqlite`)
- **Dependencies**: `uuid` + optional `pg`
- **Tests**: 68 tests via vitest, all passing

## OpenHarness v0.5.0 (Foundation Release — AgentFS + Governed Swarms)

Located at `openharness-v0.5.0/` — full 5-layer stack with multi-agent orchestration.

### 5-Layer Architecture
```
┌─────────────────────────────────────────┐
│  AgentFS (Governed Swarms)              │  Multi-agent orchestration
│  Per-agent SQLite isolation, task board │  Sentinel on writes & tool calls
├─────────────────────────────────────────┤
│  OpenHarness Evals (Karpathy Loop)      │  6 L1 hard gates + 5 L2 judges
├─────────────────────────────────────────┤
│  PrivateLaunch (Xcode Agent)            │  NL → AppSpec → SwiftUI codegen
├─────────────────────────────────────────┤
│  VaultClaw Secure (Governance)          │  RBAC (4 roles) + Sentinel + Audit
├─────────────────────────────────────────┤
│  LCM v2 (Memory Engine)                │  SQLite/PostgreSQL + FTS + pgvector
└─────────────────────────────────────────┘
```

### Key New Files (v0.5.0)
- `src/agentfs/types.ts` — SwarmTask, SwarmAgent, SwarmMessage, TaskEvalResult types
- `src/agentfs/store.ts` — AgentFSStore: per-agent SQLite with governed writes + tool call logging
- `src/agentfs/swarm.ts` — GovernedSwarm: multi-agent orchestration with sentinel + audit
- `src/launch/types.ts` — AppSpec, FeatureSpec, DataModelSpec, ScreenSpec, DesignSystem
- `src/launch/spec-generator.ts` — NL description → structured AppSpec
- `src/launch/codegen.ts` — AppSpec → SwiftUI source files
- `src/launch/pipeline.ts` — LaunchPipeline orchestrator (spec → code → sentinel → eval)
- `backend/` — FastAPI backend (17 endpoints: health, apps, sentinel, audit, evals, swarm)
- `backend/tests/test_swarm.py` — Swarm API tests

### Architectural Invariants
- Sentinel inspects ALL content before persistence (files, tool calls, messages)
- RBAC checked BEFORE every operation
- Eval harness is READ-ONLY to agents
- Audit ledger is append-only, hash-chained (SHA-256)
- Every AgentFS write is governed
- Inter-agent messages are sentinel-inspected

### Stats
- 25 TS source files, 9 test files, 165 passing tests
- 4 Python source files, 2 test files, 29 passing tests
- 0 TypeScript errors (strict mode)

### Implementation Roadmap (from Addy Osmani Orchestra integration)
1. **Plan Approval Flow** — `plan_review` status, submitPlan/approvePlan/rejectPlan
2. **Lifecycle Hooks** — SwarmEvent listeners (agent_spawned, task_completed, agent_idle)
3. **Ralph Loop** — Stateless-but-iterative task execution with stuck detection
4. **Compound Memory (AGENTS.md)** — Human-curated shared knowledge with proposal pipeline
5. **Token Budgeting** — Per-agent budget enforcement + BudgetEnforcer hook
6. **Reflection Proposals** — Post-task self-improvement with lead approval

## ClawGuard iOS Client

Native iOS/macOS client for OpenClaw/NemoClaw gateways. Located at `openharness-swift/ios/`.

### Architecture
- **Swift 6** with strict concurrency, **iOS 17+ / macOS 14+**
- **ClawGuardCore** library: networking, security, views
- **CredentialVault**: Keychain-backed credential storage (no plaintext persistence)
- **SentinelPipeline**: Client-side PII/secret detection before transmission
- **AuditLedger**: Local tamper-evident audit log with hash chains
- **GatewayClient**: mTLS-capable HTTPS client for gateway communication

### Key Swift Files
- `ios/Package.swift` — SPM package definition
- `ios/Sources/ClawGuardCore/Networking/GatewayClient.swift` — Gateway API client
- `ios/Sources/ClawGuardCore/Security/CredentialVault.swift` — Keychain vault
- `ios/Sources/ClawGuardCore/Security/SentinelPipeline.swift` — Client-side sentinel
- `ios/Sources/ClawGuardCore/Security/AuditLedger.swift` — Hash-chain audit log
- `ios/Sources/ClawGuardCore/Views/` — SwiftUI views (Chat, Connection, Audit, Settings, Privacy)

### ClawGuard Backend (FastAPI)
- `openharness-swift/app/main.py` — API routes
- `POST /api/mobile/connect` — Validate gateway connection
- `POST /api/mobile/chat` — Message with sentinel enforcement
- `GET /api/mobile/session` — Session info + security status
- `GET /api/compliance/report` — Full compliance report
- `POST /api/sentinel/inspect` — Content sentinel inspection
- `GET /api/audit` + `GET /api/audit/verify` — Audit log + chain verification

## References
- OpenShell: https://github.com/NVIDIA/OpenShell
- NemoClaw: https://github.com/NVIDIA/NemoClaw
- DeepAgents: https://github.com/langchain-ai/deepagents
- Nemotron 3 Super: https://build.nvidia.com
- Harrison Chase post: Model + Runtime + Harness architecture
- OpenHarness: LCM v2 eval framework (local, `openharness-v0.3.0/`)
