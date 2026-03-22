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
├─────────────────────────────────────────────┤
│  Agent (openagent/agent.py)                  │
│  DeepAgents + 15 tools + compliance context  │
├────────────────────┬────────────────────────┤
│  Brainiac Memory   │  LCM v2 Secure Memory  │
│  Cross-project     │  Per-session encrypted  │
│  Knowledge graph   │  RBAC + sentinel + audit│
├────────────────────┴────────────────────────┤
│  Compliance Engine (openagent/compliance.py)  │
│  Frozen policy packs, scoring, enforcement   │
├─────────────────────────────────────────────┤
│  Model: ChatNVIDIA → Nemotron 3 Super        │
│  Config: Pydantic v2 + YAML (Literal-typed)  │
└─────────────────────────────────────────────┘
```

## Key Files
- `main.py` — Thin entry point → `openagent.cli.main()`
- `openagent/cli.py` — Interactive REPL + single-task + --compliance flag
- `openagent/agent.py` — Agent factory (model + backend + memory + compliance)
- `openagent/compliance.py` — Policy packs, scoring, enforcement (frozen, immutable)
- `openagent/config.py` — Pydantic v2 config (Literal-validated compliance field)
- `openagent/model.py` — ChatNVIDIA model factory
- `openagent/backend.py` — LocalShellBackend factory
- `openagent/memory.py` — Brainiac knowledge graph integration
- `openagent/tools.py` — 6 custom tools (3 brainiac + 3 LCM) + policy enforcement
- `openagent/lcm_client.py` — Python HTTP client for LCM server
- `packages/lcm/` — LCM v2 TypeScript (SecureStore, sentinel, PII, audit chain)
- `packages/lcm/server.ts` — LCM HTTP server (loopback-only)
- `openharness-v0.3.0/` — LCM v2 + OpenHarness eval framework (superset of packages/lcm)
- `openharness-v0.3.0/src/evals/` — L1 assertions, L2 judges, EvalHarness orchestrator
- `config/agent-config.yaml` — Agent + model + compliance config
- `config/sandbox-policy.yaml` — OpenShell security policies

## Agent Tools (15 total)
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
# Start PostgreSQL + pgvector (required for LCM memory)
cd packages/lcm && docker compose up -d

# Run agent locally (no sandbox)
NVIDIA_API_KEY=nvapi-xxx python main.py

# Run single task
python main.py --task "Create a FastAPI server with health endpoint"

# Run LCM tests (uses in-memory SQLite, no Postgres needed)
cd packages/lcm && npm test

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

## References
- OpenShell: https://github.com/NVIDIA/OpenShell
- NemoClaw: https://github.com/NVIDIA/NemoClaw
- DeepAgents: https://github.com/langchain-ai/deepagents
- Nemotron 3 Super: https://build.nvidia.com
- Harrison Chase post: Model + Runtime + Harness architecture
- OpenHarness: LCM v2 eval framework (local, `openharness-v0.3.0/`)
