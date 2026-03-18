# OpenAgent - Private Coding Agent

## Project Overview
A fully private coding agent built on Harrison Chase's open stack architecture:
- **Model**: NVIDIA Nemotron 3 Super (120B params, 12B active, 1M context) via NVIDIA cloud API
- **Runtime**: NVIDIA OpenShell (sandboxed execution with policy-driven isolation)
- **Harness**: LangChain DeepAgents (planning, filesystem, sub-agents, code execution)
- **Memory**: Brainiac knowledge graph (persistent cross-session memory with semantic search)

## Architecture
```
┌─────────────────────────────────────────┐
│  CLI (openagent/cli.py)                 │
│  Interactive REPL + single-task mode    │
├─────────────────────────────────────────┤
│  Agent (openagent/agent.py)             │
│  create_deep_agent() with:              │
│  - LocalShellBackend (filesystem+shell) │
│  - MemorySaver (multi-turn checkpoints) │
│  - Brainiac tools (search/save/stats)   │
│  - Auto: todos, subagents, summarize    │
├─────────────────────────────────────────┤
│  Memory (openagent/memory.py)           │
│  Brainiac knowledge graph integration   │
│  ~/.claude/knowledge/graph/             │
├─────────────────────────────────────────┤
│  Model (openagent/model.py)             │
│  ChatNVIDIA → Nemotron 3 Super          │
│  Via NVIDIA cloud API                   │
├─────────────────────────────────────────┤
│  Config (openagent/config.py)           │
│  Pydantic v2 YAML-driven config        │
└─────────────────────────────────────────┘
```

## Key Files
- `main.py` — Thin entry point → `openagent.cli.main()`
- `openagent/cli.py` — Interactive REPL + single-task mode
- `openagent/agent.py` — Agent factory (wires model + backend + memory + tools)
- `openagent/config.py` — Pydantic v2 config models + YAML loader
- `openagent/model.py` — ChatNVIDIA model factory
- `openagent/backend.py` — LocalShellBackend factory
- `openagent/memory.py` — Brainiac knowledge graph integration
- `openagent/tools.py` — memory_search, memory_save, memory_stats tools
- `config/agent-config.yaml` — Agent, model, harness, and runtime settings
- `config/sandbox-policy.yaml` — OpenShell sandbox security policies
- `scripts/setup-wsl.sh` — OpenShell + NemoClaw installation (Linux/WSL)
- `scripts/run-sandbox.sh` — Launch agent inside OpenShell sandbox

## Agent Tools (auto-wired by DeepAgents)
| Tool | Source | Purpose |
|------|--------|---------|
| `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep` | DeepAgents | Filesystem |
| `execute` | DeepAgents + LocalShellBackend | Shell commands |
| `write_todos` | DeepAgents | Planning / task tracking |
| `task` | DeepAgents | Sub-agent spawning |
| `memory_search` | OpenAgent | Search knowledge graph |
| `memory_save` | OpenAgent | Save learnings to graph |
| `memory_stats` | OpenAgent | Graph statistics |

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
# Run agent locally (no sandbox)
NVIDIA_API_KEY=nvapi-xxx python main.py

# Run single task
python main.py --task "Create a FastAPI server with health endpoint"

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

## References
- OpenShell: https://github.com/NVIDIA/OpenShell
- NemoClaw: https://github.com/NVIDIA/NemoClaw
- DeepAgents: https://github.com/langchain-ai/deepagents
- Nemotron 3 Super: https://build.nvidia.com
- Harrison Chase post: Model + Runtime + Harness architecture
