# TODOS

Deferred work captured during /plan-eng-review on 2026-03-31.

---

## TODO-1: Fix lingering phase2-plan bugs (C3, I3, I4)

**What:** Fix 3 open bugs from `tasks/phase2-plan.md` that were never addressed:
- C3: `sqlite-store.ts` regex search mode returns empty for messages — needs LIKE fallback when `mode === 'regex'`
- I3: Greedy tool-use regex in `src/ingestion/pii-detector.ts` — `/<tool>[\s\S]*?<\/tool>/` matches across unrelated blocks when input contains multiple tool elements
- I4: `compressionCharThreshold` in `IngestionPipelineConfig` is documented as chars but named inconsistently with the code comment ("min tokens")

**Why:** These are confusing to future contributors reading `tasks/phase2-plan.md`. C3 means regex search silently returns no results; I4 is a misleading comment that affects PII detection.

**Pros:** Small fixes, improves developer clarity, fixes a silent data gap in search.

**Cons:** None — 3 independent fixes ~30 lines total.

**Context:** C3 is in `src/store/sqlite-store.ts` `search()` method. I3 is in `src/ingestion/pii-detector.ts` in the tool-use detection regex. I4 is in `src/ingestion/pipeline.ts` `compressionCharThreshold` field.

**Depends on:** Nothing. Can be done as a standalone PR before or after P3-P6.

---

## TODO-2: GDPR right-to-erasure + cryptographic deletion pipeline

**What:** Implement `deleteConversation(conversationId, userId)` with cryptographic deletion: rotate the per-conversation encryption key so all existing ciphertext becomes unrecoverable without a separate plaintext delete sweep.

**Why:** Maps directly to GDPR Art. 17 (right to erasure) and HIPAA minimum necessary access. Required for enterprise positioning in regulated industries — this is a hard requirement for any HIPAA BAA.

**Pros:** Unlocks the HIPAA and GDPR compliance claims in the product. SecureStore already has the encryption envelope; this just adds key rotation + audit evidence.

**Cons:** Non-trivial: requires key rotation in `SecureStore`, a `deleteConversation()` method on `LcmStore`, a FastAPI endpoint, and an audit record proving the deletion occurred. Human: ~1 week / CC: ~1 hour.

**Context:** See `tasks/todo.md` Phase 3. The cryptographic deletion approach (key rotation > plaintext delete) is the only approach that survives forensic audits. Implementation path: `SecureStore.deleteConversation()` → rotate encryption key → emit `audit:gdpr_erasure` record → return evidence hash.

**Depends on:** No blocker. Can be built in parallel with P3-P6.

---

## TODO-3: Token budget validation at config time

**What:** Add validation that `tokenBudget > 0` when registering a BudgetEnforcer hook (or when configuring an agent with a budget). Add one test: `tokenBudget = 0` at construction time throws.

**Why:** A budget of 0 makes every task immediately block at 100% usage. Silent misconfiguration that's hard to debug.

**Pros:** 5-line guard, 1 test. Prevents confusing silent failures.

**Cons:** None.

**Context:** Will live in the BudgetEnforcer hook factory function (`createBudgetEnforcerHook(budget: number)` — throw if `budget <= 0`). See P5 implementation.

**Depends on:** P5 (Token Budgeting) must be implemented first.
