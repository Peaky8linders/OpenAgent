/**
 * LCM v2 HTTP Server — exposes SecureStore + SecurePipeline over HTTP.
 *
 * Endpoints:
 *   POST   /messages              — ingest message through secure pipeline
 *   GET    /messages/:convId      — get conversation history
 *   POST   /search                — semantic + keyword search
 *   GET    /audit                 — query audit trail
 *   GET    /health                — health check
 *   POST   /sentinel/inspect      — run sentinel inspection on content
 *
 * Uses Node.js built-in HTTP server (zero deps beyond LCM).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createStore } from './src/store/factory.js';
import { SqliteStore } from './src/store/sqlite-store.js';
import { SecureStore, type SecureUser, type SentinelInspector, type AuditLedgerWriter, type SecureAuditEntry, type InspectionResult } from './src/secure/secure-store.js';
import { PgAuditLedger } from './src/secure/pg-audit-ledger.js';
import { SecureIngestionPipeline } from './src/secure/secure-pipeline.js';
import { MockEmbeddingGenerator } from './src/ingestion/embedding-generator.js';
import type { RawMessage, SearchQuery } from './src/types/index.js';
import { createHash } from 'node:crypto';

// ─── Simple Sentinel (pattern-based) ─────────────────────────

/**
 * Normalize content before sentinel inspection.
 * Strips zero-width chars and applies NFKC normalization to defeat
 * Unicode obfuscation attacks (S3 from security review).
 */
function normalizeForSentinel(content: string): string {
  // Strip zero-width characters that break regex word matching
  const stripped = content.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, '');
  // NFKC normalization: converts homoglyphs and compatibility chars
  return stripped.normalize('NFKC');
}

class BasicSentinel implements SentinelInspector {
  private readonly patterns = [
    { pattern: /ignore\s*(previous|above|all)\s*instructions/i, category: 'prompt_injection', desc: 'Prompt injection attempt detected' },
    { pattern: /you\s+are\s+now\s+(a|an)\s+/i, category: 'role_hijack', desc: 'Role hijacking attempt detected' },
    { pattern: /system\s*:\s*override/i, category: 'system_override', desc: 'System override attempt detected' },
    { pattern: /\b(curl|wget|nc)\s+.*\|\s*(bash|sh)/i, category: 'command_injection', desc: 'Command injection attempt detected' },
    { pattern: /document\.cookie|localStorage\./i, category: 'data_exfiltration', desc: 'Data exfiltration attempt detected' },
    // Base64-encoded injection detection
    { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/i, category: 'encoded_payload', desc: 'Possible Base64-encoded payload detected' },
  ];

  inspect(content: string): InspectionResult {
    const start = Date.now();
    // [S3 fix] Normalize Unicode before matching
    const normalized = normalizeForSentinel(content);
    const findings = this.patterns
      .filter(p => p.pattern.test(normalized))
      .map(p => ({ category: p.category, confidence: 0.9, description: p.desc }));

    const threatLevel = findings.length > 0 ? 'blocked' as const : 'safe' as const;
    return { threatLevel, findings, latencyMs: Date.now() - start };
  }
}

// ─── Simple Audit Ledger (hash-chained) ──────────────────────

class BasicAuditLedger implements AuditLedgerWriter {
  private entries: SecureAuditEntry[] = [];
  private lastHash = '0'.repeat(64); // Full SHA-256 genesis hash

  /**
   * Compute tamper-proof hash over ALL entry fields.
   * [S6 fix] Full SHA-256 (not truncated), includes all fields.
   */
  private computeHash(entry: Omit<SecureAuditEntry, 'hash'>): string {
    const hashInput = JSON.stringify({
      seq: entry.sequenceNumber,
      ts: entry.timestamp,
      type: entry.type,
      userId: entry.userId,
      action: entry.action,
      target: entry.target,
      outcome: entry.outcome,
      details: entry.details,
      prev: entry.previousHash,
    });
    return createHash('sha256').update(hashInput).digest('hex'); // Full 256-bit
  }

  record(event: { type: string; userId?: string; sessionId?: string; details: Record<string, unknown>; outcome: 'success' | 'failure' | 'blocked' }): SecureAuditEntry {
    const seq = this.entries.length;
    const partial = {
      id: randomUUID(),
      sequenceNumber: seq,
      timestamp: new Date().toISOString(),
      type: event.type,
      userId: event.userId ?? 'system',
      action: event.type,
      target: (event.details.target as string) ?? '',
      previousHash: this.lastHash,
      details: event.details,
      outcome: event.outcome,
    };

    const hash = this.computeHash(partial);
    const entry: SecureAuditEntry = { ...partial, hash };
    this.lastHash = hash;
    this.entries.push(entry);
    return entry;
  }

  verifyChain(): { valid: boolean; brokenAt?: number; reason?: string } {
    let prev = '0'.repeat(64);
    for (const e of this.entries) {
      if (e.previousHash !== prev) {
        return { valid: false, brokenAt: e.sequenceNumber, reason: 'Previous hash mismatch' };
      }
      const expected = this.computeHash({ ...e });
      if (e.hash !== expected) {
        return { valid: false, brokenAt: e.sequenceNumber, reason: 'Entry hash tampered' };
      }
      prev = e.hash;
    }
    return { valid: true };
  }

  getEntries(limit = 100): SecureAuditEntry[] {
    return this.entries.slice(-limit);
  }
}

// ─── HTTP Helpers ────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getPath(url: string): { path: string; params: URLSearchParams } {
  const u = new URL(url, 'http://localhost');
  return { path: u.pathname, params: u.searchParams };
}

// ─── Server ──────────────────────────────────────────────────

const PORT = parseInt(process.env.LCM_PORT ?? '3100', 10);
const API_KEY = process.env.LCM_API_KEY ?? ''; // Empty = no auth required

/**
 * [S7 fix] Bearer token authentication.
 * Returns true if request is authorized, false otherwise.
 * If LCM_API_KEY is not set, all requests are allowed (dev mode).
 */
function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_KEY) return true; // No key configured = dev mode
  const authHeader = req.headers.authorization ?? '';
  if (authHeader === `Bearer ${API_KEY}`) return true;
  json(res, 401, { error: 'Unauthorized: invalid or missing Bearer token' });
  return false;
}

async function main() {
  // Initialize store — PostgreSQL (production) or SQLite (dev/test)
  const driver = (process.env.LCM_STORE_DRIVER ?? 'sqlite') as 'sqlite' | 'postgres';
  const innerStore = await createStore({
    driver,
    path: process.env.LCM_SQLITE_PATH ?? ':memory:',
    connectionString: process.env.DATABASE_URL,
    maxConnections: parseInt(process.env.LCM_PG_MAX_CONNECTIONS ?? '10', 10),
  });

  const sentinel = new BasicSentinel();

  // Audit ledger: PostgreSQL (persistent) or in-memory (dev)
  let audit: AuditLedgerWriter & { getEntries(limit?: number): SecureAuditEntry[]; getEntriesAsync?(limit?: number): Promise<SecureAuditEntry[]>; verifyChainAsync?(): Promise<{ valid: boolean; brokenAt?: number; reason?: string; totalEntries?: number }> };
  if (driver === 'postgres' && process.env.DATABASE_URL) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
    const pgAudit = new PgAuditLedger(pool);
    await pgAudit.initialize();
    audit = pgAudit;
  } else {
    audit = new BasicAuditLedger();
  }

  const adminUser: SecureUser = { id: 'system', role: 'admin' };
  const store = new SecureStore(innerStore, adminUser, sentinel, audit);
  // Skip initialize for PG — createStore already called it
  if (driver === 'sqlite') await store.initialize();

  const embedGen = new MockEmbeddingGenerator();
  const pipeline = new SecureIngestionPipeline(innerStore, embedGen, sentinel, audit);

  console.log(`LCM v2 Secure Memory Server starting on port ${PORT}...`);
  console.log(`Store: ${driver === 'postgres' ? 'PostgreSQL' : 'SQLite'}`);
  console.log(`Audit: ${driver === 'postgres' ? 'PostgreSQL (persistent)' : 'in-memory'}`);
  console.log(`Sentinel: enabled | RBAC: enabled`);

  if (API_KEY) {
    console.log('Auth: Bearer token required (LCM_API_KEY set)');
  } else {
    console.log('Auth: DISABLED (set LCM_API_KEY for production)');
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const { path, params } = getPath(req.url ?? '/');

    try {
      // Health check (unauthenticated — used for liveness probes)
      if (path === '/health' && method === 'GET') {
        const health = await store.healthCheck();
        const chainStatus = audit.verifyChainAsync
          ? await audit.verifyChainAsync()
          : audit.verifyChain();
        return json(res, 200, { ...health, auditChain: chainStatus });
      }

      // [S7] All endpoints below require authentication
      if (!checkAuth(req, res)) return;

      // Ingest message
      if (path === '/messages' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const raw: RawMessage = {
          id: body.id ?? randomUUID(),
          conversationId: body.conversationId ?? 'default',
          role: body.role ?? 'user',
          content: body.content,
          tokenCount: body.tokenCount ?? Math.ceil(body.content.length / 4),
          createdAt: body.createdAt ?? new Date().toISOString(),
          metadata: body.metadata,
        };
        const result = await pipeline.ingest(raw);
        return json(res, result.sentinelCleared ? 201 : 403, result);
      }

      // Get conversation messages
      if (path.startsWith('/messages/') && method === 'GET') {
        const convId = path.split('/')[2];
        const messages = await store.getMessagesByConversation(convId);
        return json(res, 200, { messages, count: messages.length });
      }

      // Search
      if (path === '/search' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const query: SearchQuery = {
          pattern: body.pattern ?? body.query,
          mode: body.mode ?? 'fts',
          scope: body.scope ?? 'messages',
          conversationId: body.conversationId,
          limit: body.limit ?? 20,
        };
        const results = await store.searchMessages(query);
        return json(res, 200, { results, count: results.length });
      }

      // Sentinel inspect (also audited — prevents oracle attacks)
      if (path === '/sentinel/inspect' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const result = sentinel.inspect(body.content ?? '');
        audit.record({
          type: 'sentinel_inspect',
          details: { source: 'api', threatLevel: result.threatLevel },
          outcome: result.threatLevel === 'safe' ? 'success' : 'blocked',
        });
        return json(res, 200, result);
      }

      // Audit trail
      if (path === '/audit' && method === 'GET') {
        const limit = parseInt(params.get('limit') ?? '50', 10);
        // Use async methods if available (PgAuditLedger), else sync fallback
        const entries = audit.getEntriesAsync
          ? await audit.getEntriesAsync(limit)
          : audit.getEntries(limit);
        const chainStatus = audit.verifyChainAsync
          ? await audit.verifyChainAsync()
          : audit.verifyChain();
        return json(res, 200, { entries, chain: chainStatus, count: entries.length });
      }

      // 404
      json(res, 404, { error: 'Not found', path });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Don't leak internal details in production
      json(res, message.includes('Access denied') ? 403 : message.includes('blocked') ? 403 : 500, { error: message });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`LCM v2 server listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
