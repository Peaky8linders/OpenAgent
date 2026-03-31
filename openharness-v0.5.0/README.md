# LCM v2 — Hardened Lossless Context Management

A production-grade implementation of the [LCM algorithm](https://papers.voltropy.com/LCM) for AI agent context management, addressing the security, privacy, and scalability gaps in the original [lossless-claw](https://github.com/Martian-Engineering/lossless-claw) plugin.

## What's Different from lossless-claw

| Feature | lossless-claw | LCM v2 |
|---------|---------------|--------|
| **Encryption at rest** | None | pgcrypto + path validation |
| **PII handling** | None | 8-type detection, 3 redaction modes |
| **Access control** | None | Memory scopes with RBAC |
| **Audit logging** | None | Append-only audit on every mutation |
| **Data retention** | None | TTL policies with DAG cascade |
| **Full-text search** | SQLite FTS5 | FTS5 + PostgreSQL tsvector/GIN |
| **Vector search** | None | pgvector HNSW (O(log n) ANN) |
| **Concurrency** | SQLite single-writer | PostgreSQL connection pooling |
| **Pre-compression** | None | Heuristic boilerplate removal |
| **Topic segmentation** | None | Embedding cosine discontinuity |
| **Summary quality** | None | Quality score tracking + resummary flags |

## Quick Start

```bash
npm install
npm test          # 68 tests, SQLite in-memory
npm run lint      # Type check
npm run build     # Compile

# With PostgreSQL
cp .env.example .env
docker compose up -d
```

## Usage

```typescript
import { createStore, IngestionPipeline, MockEmbeddingGenerator } from '@lcm-v2/core';

const store = await createStore({ driver: 'sqlite', path: ':memory:' });
const pipeline = new IngestionPipeline(store, new MockEmbeddingGenerator());

const result = await pipeline.ingest({
  id: crypto.randomUUID(),
  conversationId: 'conv-1',
  role: 'user',
  content: 'Deploy the database migration to staging',
  tokenCount: 7,
  createdAt: new Date().toISOString(),
});
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for full architecture docs and Claude Code conventions.

## License

MIT
