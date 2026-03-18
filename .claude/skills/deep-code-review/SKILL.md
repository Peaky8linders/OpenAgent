---
name: deep-code-review
description: Use when reviewing current branch for bugs before pushing or merging, when wanting a thorough multi-agent review of local changes, or when preparing work for human review
user_invocable: true
---

# Deep Code Review

Multi-agent bug-hunting review of the current branch against a base branch. Dispatches specialist agents in parallel, verifies findings to filter false positives, ranks by severity, and produces a persistent report.

**This is a technique skill.** Follow the phases in order. Do not skip verification.

## Pre-flight Checks

Parse `$ARGUMENTS` for an optional base branch (default: `main`).

1. **Context window:** If conversation has substantive history beyond invoking this skill, tell the user: "This review consumes significant context. Start a fresh session with `/deep-code-review` for best results." Stop and wait for confirmation.
2. **Branch:** Run `git branch --show-current`. Must not be on main/master. If so, stop: "Nothing to review — you're on the base branch."
3. **Clean state:** Run `git status --short`. If uncommitted changes exist, ask: "Review committed state only, or wait to commit?"

## Phase 1: Reconnaissance

Collect context for the review:

1. `git diff --stat <base>...HEAD` — files and line counts
2. `git diff <base>...HEAD` — full diff
3. Classify diff size:
   - **Small:** <50 lines changed — use 3 agents (Logic, Contract, Security)
   - **Medium:** 50-500 lines — use 5 agents (all specialists)
   - **Large:** 500+ lines — use 5 agents, partition files across 2 instances each
   - **Mega:** 2000+ lines — STOP. Tell user: "Diff too large for reliable review. Break into smaller PRs or specify a file subset via arguments."
4. Scan for steering files: `CLAUDE.md`, `.claude/rules/`
5. For each changed file, grep for callers/callees one level deep (function/method names from the diff)
6. When the diff includes infrastructure files (CI pipelines, Dockerfiles, K8s manifests, schema migrations), check whether test-side counterparts exist. Add unmatched test infrastructure to the Contract agent's scope.
7. For **small** diffs: expand scope to full module/package for each changed file
8. Build manifest: files to review (changed + adjacent), grouped for specialists

**Steering file caveat** (include in every agent prompt): "Steering files (CLAUDE.md, rules/) describe conventions but may be stale. If you find a contradiction between steering files and actual code, flag it as a finding."

## Phase 2: Specialist Review (Parallel)

Dispatch agents simultaneously using the Agent tool. Each receives: the diff, manifest of files to review, steering file contents, and their specialist focus.

**All specialist agents use `model: sonnet`** for cost efficiency.

### Always dispatched

| Agent | Lens | Scope |
|-------|------|-------|
| **Logic & Correctness** | Wrong conditions, off-by-one, null paths, state transitions, algorithm errors, new code paths that skip processing/validation/cleanup present in sibling paths | Changed code + surrounding functions |
| **Contract & Integration** | Signature vs callers, type mismatches, broken API contracts, data shape drift, logic duplication, reimplemented utilities | Changed code + callers/callees one level |
| **Security** | Injection, auth gaps, data exposure, OWASP top 10 | Changed code + input/output boundaries |

### Medium+ diffs (add these)

| Agent | Lens | Scope |
|-------|------|-------|
| **Error Handling & Edge Cases** | Missing catches, swallowed exceptions, boundary validation, silent failures, external output parsing that fails on realistic variations (trailing punctuation, whitespace, casing) | Changed code + error paths in callers |
| **Concurrency & State** | Races, shared mutable state, cache invalidation, ordering assumptions, singleton misuse | Changed code + shared state access |

### Agent prompt requirements

Each specialist prompt must include:
- The full diff (or partition for large diffs)
- Contents of files in their review scope (read them)
- Steering file contents with the staleness caveat
- Instruction: "You are a specialist reviewer focused on **[LENS]**. Find bugs, not style issues. For each finding report: `file:line`, what's wrong, why it matters, suggested fix, and confidence (0-100). Only report findings with confidence >= 60."

**Contract & Integration extra instruction:** "Flag new code that reimplements logic already available in the codebase. Flag duplicated code blocks within the diff that could be parameterized. Frame as integration issues — duplicated logic diverges over time."

**For large diffs (500+ lines):** Partition files across 2 instances of each specialist (e.g., Logic-A gets half, Logic-B the rest). Do not send the entire diff to a single agent.

## Phase 3: Verification

After all specialists complete, dispatch a single **Verifier** agent (`model: opus`) with all findings.

The verifier:
1. For each finding, reads the actual current code at the referenced `file:line`
2. Confirms the bug exists and isn't handled elsewhere
3. Drops false positives and findings below 60% confidence post-verification
4. Assigns severity: **Critical** (data loss, security hole, crash) / **Important** (wrong behavior, silent failure) / **Suggestion** (improvement, not a bug)
5. Deduplicates findings flagged by multiple specialists (note which agreed — multi-specialist agreement raises confidence)

**Verifier prompt:** "You are verifying bug reports against actual code. Be skeptical — reject anything you cannot confirm by reading the code. A finding reported by multiple specialists is more likely real. Read every referenced file:line before making a judgment."

## Phase 4: Report

Write verified findings to `docs/reviews/<branch>-<YYYY-MM-DD-HH-MM-SS>.md`.

Create `docs/reviews/` if it doesn't exist.

```markdown
# Code Review: <branch-name>

**Date:** YYYY-MM-DD HH:MM:SS
**Branch:** <branch> -> <base>
**Commit:** <short-sha>
**Diff:** N files | +X / -Y lines | Size category

## Summary

2-3 sentences: overall assessment, highest-severity finding, confidence.

## Critical Issues

### [C1] <title>
- **Location:** `path/to/file:line`
- **Bug:** What's wrong
- **Impact:** Why it matters
- **Fix:** Concrete recommendation
- **Confidence:** High/Medium
- **Found by:** <specialist name(s)>

(Repeat, or "None found.")

## Important Issues

(Same structure, or "None found.")

## Suggestions

One-line entries. Omit section if none.

## Review Metadata

- Agents dispatched: <count and focus areas>
- Files reviewed: <changed + adjacent count>
- Raw findings: N | Verified: M | Filtered: N-M
- Steering files: <list or "none">
```

## Common Mistakes

| Mistake | Do instead |
|---------|-----------|
| Single-agent review | Always dispatch 3+ specialists in parallel |
| Skipping verification | Always run verifier — unverified findings have high false-positive rate |
| Reporting style nits | Hunt **bugs**, not code style |
| Not tracing callers | Best bugs hide at integration boundaries — trace one level |
| Not reading adjacent tests | Tests passing via catch-all mocks are real bugs |
| Findings without file:line | Every finding must reference exact location |
| Ignoring logic duplication | Contract agent must check for existing helpers |
| Same agent count for all diffs | Scale with diff size: 3 for small, 5 for medium, 10 for large |

## Post-Review

After writing the report:
1. Tell the user the report location and finding counts by severity
2. Do **not** auto-fix anything — the report is the deliverable
