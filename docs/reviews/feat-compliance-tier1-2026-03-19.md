# Code Review: feat/compliance-tier1

**Date:** 2026-03-19
**Branch:** feat/compliance-tier1 -> main
**Commit:** 2455075
**Diff:** 5 files | +477 / -12 lines | Medium

## Summary

Compliance engine is well-structured with correct policy packs and clean test coverage. Two important bugs in `score_action()`: sentinel block should short-circuit instead of leaking spurious findings, and the audit check produces duplicate findings for high-risk actions. The encryption penalty silently affects scores without generating an explanatory finding.

## Important Issues

### [I1] Sentinel block leaks findings + encryption penalty has no finding
- **Location:** `openagent/compliance.py:249-273`
- **Bug:** When sentinel blocks an action (score=0.0, blocked=True), execution continues through PII, audit, and encryption checks, accumulating irrelevant findings. Separately, the encryption deduction (min 0.95) never appends a finding, so "All compliance checks passed" is reported at score 0.95.
- **Impact:** Misleading findings on blocked actions; unexplained score deductions
- **Fix:** Early return on sentinel block; add finding for encryption deduction
- **Confidence:** High
- **Found by:** Logic & Correctness, verified by Opus

### [I2] High-risk audit check duplicates findings
- **Location:** `openagent/compliance.py:267-280`
- **Bug:** Generic audit check (line 267) and high-risk audit check (line 276) both fire on `audit_logged=False`, producing two findings about the same root cause
- **Impact:** Duplicate findings confuse compliance score consumers
- **Fix:** Consolidate into one block with high-risk distinction
- **Confidence:** High
- **Found by:** Logic & Correctness, verified by Opus

## Suggestions

- `test_compliance.py:66-70`: Assert exact score (0.95) instead of `>= 0.9`
- `test_compliance.py:86-89`: Assert exact score (0.7) instead of range `[0.5, 0.8]`
- `agent.py:55`: Use `ComplianceFramework.NONE` instead of raw `"none"` string
- `compliance.py:202-204`: `not in POLICY_PACKS` guard is unreachable dead code

## Review Metadata

- Agents dispatched: 5 (Logic, Contract, Security, Error Handling, Concurrency)
- Verifier: Opus
- Files reviewed: 7 (5 changed + 2 adjacent)
- Raw findings: 6 | Verified: 6 | Filtered: 0
- Critical: 0 | Important: 2 | Suggestion: 4
