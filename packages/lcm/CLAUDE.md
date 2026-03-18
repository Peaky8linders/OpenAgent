# LCM v2 — Hardened Lossless Context Management

## What This Is

Production-grade reimplementation of the LCM algorithm (Voltropy, Feb 2026) with security,
privacy, observability, and PostgreSQL support that the original lossless-claw plugin lacks.

## Quick Start

```bash
npm install
npm test          # 68 tests, all must pass
npm run build     # TypeScript compilation
npm run lint      # tsc --noEmit (type check only)
```

### With PostgreSQL (requires Docker)

```bash
docker compose up -d     # Starts Postgres 16 + pgvector
npm test                 # SQLite tests (no PG needed)
```

## Architecture

```
src/
  types/index.ts           — All data models (messages, summaries, DAG, audit, scopes, embeddings)
  store/
    lcm-store.ts           — Abstract async LcmStore interface
    sqlite-store.ts        — SQLite implementation (node:sqlite, WAL mode)
    pg-store.ts            — PostgreSQL implementation (pg Pool, pgvector HNSW, tsvector FTS)
    factory.ts             — createStore(config) factory
  db/
    migrations.ts          — SQLite schema migrations (3 versions)
    pg-migrations.ts       — PostgreSQL migrations (4 versions: core, audit, pgvector, RLS)
  ingestion/
    pipeline.ts            — Full ingestion pipeline (PII → compress → topic → embed → store)
    pii-detector.ts        — Regex-based PII detection (8 types)
    pre-compressor.ts      — Heuristic content compression
    topic-segmenter.ts     — Embedding cosine discontinuity topic detection
    embedding-generator.ts — Interface + mock (64-dim char-freq vectors)
  secure/
    secure-store.ts        — Governance wrapper: RBAC + sentinel + audit over any LcmStore
    secure-pipeline.ts     — Sentinel-protected ingestion pipeline
  util/
    math.ts                — Shared cosine similarity (single source of truth)
```

## Key Design Decisions

- **Async interface**: All `LcmStore` methods return Promises. SQLite wraps sync calls.
  PostgreSQL uses native async pg.Pool. This means every store call needs `await`.
- **Immutable store invariant**: Raw message content is NEVER modified. PII annotations,
  compressed content, and topic labels are metadata overlays.
- **Embeddings**: SQLite uses brute-force cosine search. PostgreSQL uses pgvector HNSW
  index with `<=>` cosine distance operator for O(log n) ANN search.

## Conventions

- No `any` types except in test mocks. Use `Record<string, unknown>` for untyped rows.
- All SQL uses parameterized queries. Zero string interpolation into SQL.
- Every store mutation emits an audit log entry.
- Tests use `:memory:` SQLite — no disk, no cleanup needed.
- PostgreSQL tests require `DATABASE_URL` env var or Docker.

## Common Tasks

### Add a new store method
1. Add to `LcmStore` interface in `src/store/lcm-store.ts`
2. Implement in `SqliteStore` (sync logic, async wrapper)
3. Implement in `PgStore` (native async)
4. Add test in `test/sqlite-store.test.ts`
5. Run `npm run lint && npm test`

### Add a new migration
1. Append to `MIGRATIONS` array in `src/db/migrations.ts` (SQLite)
2. Append to `PG_MIGRATIONS` array in `src/db/pg-migrations.ts` (PostgreSQL)
3. Increment version number
4. Test: `npm test` (migrations auto-apply on init)

### Change the embedding model
1. Implement `EmbeddingGenerator` interface in `src/ingestion/embedding-generator.ts`
2. Update `embeddingDimensions` in PgStore config (default 384)
3. Update pgvector column: `ALTER TABLE embeddings ALTER COLUMN vector TYPE vector(NEW_DIM)`

## Environment Variables

See `.env.example` for all config. Key ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_STORE_DRIVER` | `sqlite` | `sqlite` or `postgres` |
| `LCM_SQLITE_PATH` | `:memory:` | SQLite database file path |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `LCM_PG_MAX_CONNECTIONS` | `10` | Connection pool size |
| `LCM_EMBEDDING_DIMENSIONS` | `384` | pgvector column width |
