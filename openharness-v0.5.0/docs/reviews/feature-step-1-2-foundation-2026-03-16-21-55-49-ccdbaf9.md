# Deep Code Review: feature/step-1-2-foundation

**Date:** 2026-03-16 21:55:49
**Branch:** feature/step-1-2-foundation -> main
**Commit:** ccdbaf9b7b51f4cf881f175fb181a4fbe644193f
**Files changed:** 21 | **Lines changed:** +4604 / -0
**Diff size category:** Large

## Executive Summary

Solid architectural foundation with clean type contracts and comprehensive test coverage (68/68 pass). However, the review found 3 critical bugs: FTS index entries are never cleaned up on message deletion (ordering bug), SQL injection in the backup path, and regex mode silently returns no results. Additionally, embeddings are leaked on deletion, and the pre-compressor's tool-use regex can greedily consume non-tool content between two tool blocks.

## Critical Issues

### [C1] FTS entries never deleted — subquery references already-deleted row
- **File:** `src/store/sqlite-store.ts:252`
- **Bug:** `deleteMessages()` deletes the message on line 247, then on line 252 attempts `DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = ?)`. The subquery returns NULL because the message row is already gone. FTS entries accumulate forever.
- **Impact:** FTS index grows unboundedly. Stale entries pollute search results. Over time, FTS search returns ghost results for deleted messages.
- **Suggested fix:** Capture the rowid *before* deleting the message, then use the captured rowid for FTS deletion. Or reorder: delete FTS first, then delete message.
- **Confidence:** High
- **Found by:** Logic & Correctness, Contract & Integration

### [C2] SQL injection in backup() via string interpolation
- **File:** `src/store/sqlite-store.ts:101`
- **Bug:** `this.db.exec(`VACUUM INTO '${destinationPath.replace(/'/g, "''")}'`)` uses string interpolation into `exec()`. The single-quote escaping is insufficient — it doesn't handle null bytes, backslashes, or Unicode escapes that SQLite may interpret. Any untrusted path input can inject arbitrary SQL.
- **Impact:** If backup path comes from user input (e.g., agent-provided), arbitrary SQL execution is possible. In a multi-tenant context, this is a privilege escalation vector.
- **Suggested fix:** There's no parameterized way to pass the path to VACUUM INTO in node:sqlite. Validate the path with a strict allowlist regex (alphanumeric, hyphens, underscores, dots, slashes only) and reject anything else.
- **Confidence:** High
- **Found by:** Security

### [C3] searchMessages() silently returns empty for regex mode on messages
- **File:** `src/store/sqlite-store.ts:169`
- **Bug:** The messages search block is gated by `if (query.mode === 'fts')`. When `mode === 'regex'`, the entire messages block is skipped. The summary search (line 202) uses LIKE which works for both modes, but messages with regex mode return zero results with no error.
- **Impact:** Callers requesting `{ mode: 'regex', scope: 'messages' }` or `{ mode: 'regex', scope: 'both' }` silently get incomplete results. This violates the SearchQuery contract which defines `'regex'` as a valid mode.
- **Suggested fix:** Add an `else` branch for regex mode that queries messages using `content REGEXP ?` (requires loading SQLite's regexp extension) or falls back to LIKE with escaped wildcards.
- **Confidence:** High
- **Found by:** Logic & Correctness, Contract & Integration

## Important Issues

### [I1] deleteMessages() never cleans up embeddings
- **File:** `src/store/sqlite-store.ts:227-265`
- **Bug:** When messages are deleted, the `embeddings` table is never touched. Orphaned embedding records accumulate. The `embeddingsRemoved` field in `DeletionReport` is hardcoded to 0.
- **Impact:** Embedding storage grows monotonically even after retention enforcement. Orphaned embeddings may return in similarity search results, pointing to non-existent messages.
- **Suggested fix:** Add `DELETE FROM embeddings WHERE entity_type = 'message' AND entity_id = ?` before the message delete. Increment `embeddingsRemoved` counter.
- **Confidence:** High
- **Found by:** Contract & Integration

### [I2] LIKE wildcard injection in summary search
- **File:** `src/store/sqlite-store.ts:204`
- **Bug:** `query.pattern` is wrapped in `%...%` for LIKE matching but `%` and `_` characters in the pattern are not escaped. A pattern like `%` matches everything; `_` matches any single character. User-controlled search patterns can produce unexpectedly broad results.
- **Impact:** Information disclosure — a malicious pattern can enumerate all summaries regardless of intended search scope.
- **Suggested fix:** Escape `%` → `\%` and `_` → `\_` in the pattern, then add `ESCAPE '\'` to the LIKE clause.
- **Confidence:** Medium
- **Found by:** Security

### [I3] Pre-compressor tool-use regex can greedily match across non-tool content
- **File:** `src/ingestion/pre-compressor.ts:12`
- **Bug:** The regex `/^<tool_(?:use|result)>[^]*?<\/tool_(?:use|result)>$/gm` uses `[^]*?` which matches any character including newlines. Despite `^...$` anchors with multiline mode, `[^]*?` can match across line boundaries. If text contains `<tool_use>...` on one line and `</tool_result>` many lines later with non-tool content in between, the regex consumes everything including the non-tool content.
- **Impact:** Legitimate conversation content between tool blocks gets silently removed during pre-compression. This degrades summary quality — the core value proposition of the system.
- **Suggested fix:** Replace `[^]*?` with `[^\n]*` (single-line match) or use a non-regex approach that parses tool blocks structurally.
- **Confidence:** Medium
- **Found by:** Logic & Correctness, Error Handling & Edge Cases

### [I4] compressionThreshold compares chars vs config name says tokens
- **File:** `src/ingestion/pipeline.ts:36,136`
- **Bug:** `compressionThreshold` is documented as "Minimum token count for pre-compression to activate" (line 36) but line 136 compares `raw.content.length` (character count) against it. Chars ≠ tokens (~4:1 ratio). The default of 100 means compression activates for messages > 100 chars (~25 tokens), much earlier than the name implies.
- **Impact:** Compression runs on messages that are too small to benefit, wasting CPU. Or if a user sets `compressionThreshold: 500` expecting 500 tokens, it actually means 500 chars (~125 tokens).
- **Suggested fix:** Either rename the config to `compressionCharThreshold` and update the comment, or compare against `raw.tokenCount` instead of `raw.content.length`.
- **Confidence:** High
- **Found by:** Contract & Integration

## Suggestions

- `deleteMessages()` runs N iterations of 4+ prepared statements without a transaction wrapper. Wrapping in `BEGIN/COMMIT` would be faster and atomic.
- `cosineSimilarity()` is duplicated in 3 files (sqlite-store.ts, topic-segmenter.ts, pipeline.ts). Extract to a shared utility.
- `applyMigrations()` types its `db` parameter with inline object type instead of using `DatabaseSync`. The `as never` cast in sqlite-store.ts line 58 is a symptom.
- `RawMessage` imported in `lcm-store.ts` but unused (interface only uses `EnrichedMessage`).
- Phone regex in pii-detector.ts matches 7-digit sequences without area code, which produces false positives on numeric IDs and timestamps.

## Review Metadata

- **Agents dispatched:** Logic & Correctness, Error Handling & Edge Cases, Contract & Integration, Security, Concurrency & State
- **Scope:** 10 source files + 5 test files (all changed)
- **Raw findings:** 14 (before verification)
- **Verified findings:** 9 (after verification)
- **Filtered out:** 5 (style nits, non-bugs, low confidence)
- **Steering files consulted:** none found
- **Plan/design docs consulted:** tasks/todo.md
