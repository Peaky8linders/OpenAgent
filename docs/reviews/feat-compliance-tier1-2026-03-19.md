# Code Review: feat/compliance-tier1 (Full Multi-Agent Results)

**Date:** 2026-03-19
**Branch:** feat/compliance-tier1 -> main
**Commits:** PRs #1-#4
**Diff:** 5 files | +477 / -12 lines | Medium
**Agents:** 5 specialists (Logic, Contract, Security, Error Handling, Concurrency) + Opus verifier

## Summary

Compliance engine is well-structured with correct policy packs. Deep review found 7 security bugs
across all 5 specialists. All fixable bugs were resolved in PRs #2-#4. Remaining items are
architectural improvements for Phase 2.

## Fixed (PRs #2-#4)

| # | Severity | Issue | PR |
|---|----------|-------|-----|
| I1 | Important | Sentinel block leaked spurious findings; encryption had no finding | #1 fix |
| I2 | Important | Duplicate audit findings for high-risk actions | #1 fix |
| C1 | Important | Mutable policy singletons (shared state corruption) | #2 |
| C2 | Important | Config mutation via direct field assignment | #2 |
| E1 | Critical | CLI --compliance silently overwrote YAML config (security downgrade) | #3 |
| E3 | Critical | PII under REDACT_ALL not blocked (score=0.3 but blocked=False) | #3 |
| E4 | Important | Invalid compliance in YAML accepted silently, crashed at runtime | #3 |
| E2 | Important | get_policy(None) crashed with AttributeError | #3 |
| CT3 | Critical | Policy sentinel_extra_patterns never enforced | #4 |

## Remaining (Phase 2 backlog)

### Security findings (from Security specialist)

| # | Severity | Issue | Notes |
|---|----------|-------|-------|
| S1 | Critical | `network_loopback_only` is advisory only — no runtime enforcement | Needs OpenShell sandbox detection at startup |
| S3 | High | Sentinel regex bypassed by Unicode/zero-width/encoding | Add NFKC normalization + zero-width stripping |
| S4 | Critical | `score_action` trusts caller-supplied flags — gameable | Needs content-based scoring, not self-reported |
| S6 | High | Audit hash chain: 64-bit truncated, incomplete input, in-memory only | Use full SHA-256, persist to SQLite |
| S7 | High | LCM HTTP server has no authentication | Add Bearer token via LCM_API_KEY env var |

### Contract findings (remaining)

| # | Severity | Issue |
|---|----------|-------|
| CT4 | Important | LCM tools are policy-blind for PII handling mode and audit retention |
| CT6 | Important | `sentinelCleared` key assumed from LCM response with no contract |

## Test Coverage

- 62 Python tests passing (up from 32 at start of review)
- 92 LCM TypeScript tests passing
- 154 total tests

## Review Metadata

- Agents dispatched: 5 (Logic, Contract, Security, Error Handling, Concurrency)
- Verifier: Opus (confirmed 6/6 Logic findings)
- Raw findings across all agents: ~30
- Fixed in this cycle: 9
- Remaining for Phase 2: 7
- Files reviewed: 12 (5 changed + 7 adjacent/downstream)
