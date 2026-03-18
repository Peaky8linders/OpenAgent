# Private Agent Stack: Competitor Analysis & Build Opportunities
*March 18, 2026*

## The Core Insight

Harrison Chase (LangChain CEO) defined the winning formula: **Model + Runtime + Harness**.
- **Model**: The LLM doing the thinking
- **Runtime**: Where agents execute (sandboxed, policy-governed)
- **Harness**: The scaffolding that makes agents reliable (planning, memory, context management)

Key finding: Scaffolding matters as much as the model. In testing, three different frameworks running the same model scored 17 issues apart on 731 problems.

---

## Competitor Matrix

### Tier 1: Proprietary Cloud Agents
| Agent | Privacy | Sandbox | Model | Cost | Benchmark |
|-------|---------|---------|-------|------|-----------|
| **Devin** (Cognition) | Cloud only | Built-in | Proprietary | $20/mo + $2.25/ACU | 67% PR merge |
| **Claude Code** (Anthropic) | Cloud API | Local | Claude 4 | Token-based | 80.9% SWE-bench |
| **Cursor** | Cloud API | Local | Multi-model | $20/mo | N/A |
| **Windsurf** | Cloud API | Local | Multi-model | $15/mo | N/A |
| **Codex CLI** (OpenAI) | Cloud API | Sandboxed | GPT-5 | Token-based | N/A |

**Key weakness**: All send your code to cloud APIs. No data sovereignty.

### Tier 2: Open-Source Agents
| Agent | Privacy | Sandbox | Model | Stars |
|-------|---------|---------|-------|-------|
| **OpenClaw** | Model-dependent | None by default | Any | 247K |
| **OpenHands** (ex-OpenDevin) | Self-host | Docker/K8s | Any | 68K |
| **SWE-Agent** (Princeton) | Self-host | Partial | Any | 18K |
| **Aider** | Local | None | Any | N/A |

**Key weakness**: No built-in security/policy layer. OpenClaw is vulnerable to prompt injection (Cisco confirmed data exfiltration).

### Tier 3: Our Stack (NemoClaw + DeepAgents)
| Component | What | Advantage |
|-----------|------|-----------|
| **Nemotron 3 Super** | 120B/12B MoE, 1M context | Top open model on PinchBench (85.6%) |
| **OpenShell** | Policy-driven sandbox | Declarative YAML, deny-by-default, 4 enforcement domains |
| **DeepAgents** | LangChain harness | Planning, filesystem, subagents, context mgmt, 66.5% TerminalBench |
| **NemoClaw** | Turnkey bundle | One-command install, privacy router |

**Unique position**: Nobody else has all three (policy sandbox + open model + batteries-included harness).

### Also Notable (Open-Source CLI/IDE Agents)
| Agent | Stars | Type | Privacy | Sandbox |
|-------|-------|------|---------|---------|
| **OpenCode** (SST team) | 100K+ | CLI | BYO key, local models | None |
| **Cline** | 58K | VS Code ext | BYO key, Ollama | None |
| **Aider** | 13K+ commits | CLI | BYO key, Ollama | None |
| **Continue.dev** | N/A | VS Code/JetBrains | Local-first | None |

### Nemotron 3 Super vs Open Model Peers
| Metric | Nemotron 3 Super | Qwen 3/3.5 | DeepSeek R1/V3 | Llama 4 |
|--------|-----------------|-------------|----------------|---------|
| Throughput | Best (2.2x GPT-OSS, 7.5x Qwen 3.5) | Baseline | Strong | Moderate |
| Agentic tasks | #1 DeepResearch Bench | Strong coding | Strong reasoning | Moderate |
| 1M context | Outperforms peers (RULER) | Varies | Standard | 10M (Scout) |
| Chat quality | Below Qwen 3.5 on LM Arena | Top open-weight | Top tier | C tier |
| Self-hosting | RTX GPU optimized (NVFP4 native) | Wide HW support | Wide HW support | Wide HW support |

---

## Fully Private Stack Options (March 2026)
| Stack | Model | Harness | Sandbox | All Three? |
|-------|-------|---------|---------|------------|
| OpenCode + Ollama | Any local | OpenCode CLI | None | No |
| Aider + Ollama | Any local | Aider | None | No |
| Cline + Ollama | Any local | Cline (VS Code) | None | No |
| OpenHands + local | Any | OpenHands | Docker | Partial |
| **NemoClaw + DeepAgents** | **Nemotron 3 Super** | **DeepAgents** | **OpenShell (policy)** | **Yes** |

---

## OpenClaw Context

- Launched January 25, 2026 by Austrian developer Peter Steinberger
- Fastest-growing OSS project in history (247K+ GitHub stars)
- Jensen Huang: "OpenClaw is the operating system for personal AI"
- Model-agnostic: works with Claude, GPT, DeepSeek, local models
- 100+ built-in skills, persistent memory, messaging-platform UI
- Security concern: Cisco found prompt injection / data exfiltration in skills
- China banned it for government use (March 2026)
- Creator joined OpenAI in February 2026

NemoClaw = OpenClaw + enterprise security (OpenShell sandbox + Nemotron).

---

## Buildable Products

### 1. Enterprise Private Coding Agent (Priority: A)
- Deploy on customer DGX/RTX infrastructure
- Policy YAML guarantees no data leaves network
- Target: Finance, defense, healthcare
- Revenue: $30-50/dev/month + $50K-200K/yr platform license
- TAM: $500M-1B in regulated industries

### 2. Compliance & Audit Agent Infrastructure (Priority: A-)
- Signed audit trails proving data sovereignty
- EU AI Act, SOC2, HIPAA compliance
- Policy version tracking, data flow attestation
- Revenue: $100K-500K/yr platform license
- TAM: $200M+ in AI governance

### 3. CI/CD Agent Pipeline (Priority: A)
- Sandboxed agent in GitHub Actions / GitLab CI
- Per-PR code review, test gen, security scanning
- Policy-governed, ephemeral, auditable
- Revenue: $0.05-0.50/run + $500-5K/mo platform
- TAM: 10-20% of $2B CI/CD market

### 4. Multi-Agent Orchestration (Priority: B+)
- DeepAgents coordinates multiple sandboxed agents
- Each agent gets own OpenShell sandbox with distinct policies
- Agent A plans, Agent B implements, Agent C tests, Agent D reviews
- Revenue: $50K-200K/yr + compute billing

### 5. Vertical SaaS Agents (Priority: B+)
- Fine-tuned Nemotron on domain codebases
- FinTech (FIX, SOX), Healthcare (FHIR, HIPAA), Defense (ITAR)
- Domain policies baked into sandbox config
- Revenue: $50-100/dev/month premium

### 6. Developer Tools - IDE/CLI/PR Bots (Priority: A)
- VS Code / JetBrains plugin with local OpenShell agent
- CLI tool (deepagents-cli already scores on par with Claude Code)
- Self-hosted PR review bot
- Revenue: Freemium, $15-25/mo Pro

### 7. Fine-Tuning Platform (Priority: B)
- Turnkey Nemotron fine-tuning on proprietary codebases
- NeMo pipeline integration (LoRA/SFT, GRPO/DAPO)
- One-click deploy to OpenShell
- Revenue: $1K-10K/fine-tune run + $50K-200K/yr platform

---

## Recommended Go-to-Market Sequence

| Phase | Timeline | Focus | Goal |
|-------|----------|-------|------|
| 1 | Months 0-6 | Developer tools (OSS) | Capture mindshare, build community |
| 2 | Months 3-9 | CI/CD pipeline service | First monetization (usage-based) |
| 3 | Months 6-12 | Enterprise platform + compliance | Highest-value sales |
| 4 | Months 12-18 | Vertical agents + fine-tuning | Deepen moats |

---

## Key Risks

1. **NemoClaw is alpha** - Interfaces may change. Build abstractions that can swap runtimes.
2. **OpenClaw ecosystem fragmentation** - ClawHub plugin ecosystem may compete with NemoClaw tooling.
3. **Cloud vendor response** - GitHub Copilot/Cursor may add self-hosted options. Window is 12-18 months.
4. **Model quality gap** - Nemotron strong but frontier proprietary models still lead some benchmarks.
5. **Security surface** - OpenClaw had ClawJacked vulnerability. Must invest in hardening.

---

## Sources

- NVIDIA NemoClaw: https://nvidianews.nvidia.com/news/nvidia-announces-nemoclaw
- TechCrunch on NemoClaw: https://techcrunch.com/2026/03/16/nvidias-version-of-openclaw-could-solve-its-biggest-problem-security/
- Harrison Chase Framework/Runtime/Harness: https://blog.langchain.com/agent-frameworks-runtimes-and-harnesses-oh-my/
- LangChain DeepAgents: https://github.com/langchain-ai/deepagents
- LangChain Harness Engineering: https://blog.langchain.com/improving-deep-agents-with-harness-engineering/
- OpenClaw: https://en.wikipedia.org/wiki/OpenClaw
- OpenHands vs SWE-Agent: https://openalternative.co/compare/openhands/vs/swe-agent
- NVIDIA Nemotron 3 Super: https://developer.nvidia.com/blog/introducing-nemotron-3-super-an-open-hybrid-mamba-transformer-moe-for-agentic-reasoning/
- OpenShell Technical: https://developer.nvidia.com/blog/run-autonomous-self-evolving-agents-more-safely-with-nvidia-openshell/
- LangChain + NVIDIA Partnership: https://blog.langchain.com/nvidia-enterprise/
- CB Insights AI Agent Predictions: https://www.cbinsights.com/research/ai-agent-predictions-2026/
- YC S25 AI Agent Trends: https://pitchbook.com/news/articles/y-combinator-is-going-all-in-on-ai-agents-making-up-nearly-50-of-latest-batch
