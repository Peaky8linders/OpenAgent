# Task Plan: Fix remaining bugs + Postgres migration + Claude Code readiness

## Phase 1: Fix remaining review bugs (C2, C3, I2, I3, I4)
- [ ] C2: SQL injection in backup() — add strict path validation
- [ ] C3: regex mode returns empty for messages — add LIKE fallback
- [ ] I2: LIKE wildcard injection — escape % and _ in pattern
- [ ] I3: greedy tool-use regex — replace with line-bounded match
- [ ] I4: compressionThreshold chars vs tokens — rename + fix comment
- [ ] Extract shared cosineSimilarity() to src/util/math.ts
- [ ] Run tests, verify all pass

## Phase 2: PostgreSQL store implementation
- [ ] Add pg + pgvector dependencies
- [ ] Create src/db/pg-migrations.ts with PostgreSQL-native schema
      - pgvector extension for embeddings
      - GIN index on messages content (tsvector FTS)
      - HNSW index on embeddings for ANN similarity search
      - Row-level security policies for multi-tenant scoping
      - Column-level encryption via pgcrypto for PII
- [ ] Create src/store/pg-store.ts implementing LcmStore
      - Async via pg Pool with connection pooling
      - Parameterized queries everywhere (no string interpolation)
      - Native tsvector search replaces FTS5
      - pgvector cosine distance operator <=> replaces brute-force
      - NOTIFY/LISTEN hooks for async compaction triggers
- [ ] Make LcmStore interface async (Promise-returning) 
- [ ] Update SqliteStore to match async interface (wrap sync calls)
- [ ] Create store factory: createStore(config) → LcmStore
- [ ] Update pipeline to work with async store
- [ ] Tests: pg-store tests with mock (no real PG needed in CI)

## Phase 3: Claude Code project scaffold
- [ ] CLAUDE.md — project conventions, architecture, how to run
- [ ] AGENTS.md — agent delegation rules
- [ ] .env.example — all config vars documented
- [ ] docker-compose.yml — Postgres + pgvector for local dev
- [ ] Proper README.md with setup instructions
- [ ] npm scripts: build, test, lint, dev, db:migrate
- [ ] .gitignore, .prettierrc, eslint config

## Verification
- [ ] npm run build — zero errors
- [ ] npm test — all tests pass
- [ ] tsc --noEmit — zero type errors
- [ ] Claude Code can clone + run immediately
