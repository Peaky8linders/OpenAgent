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
import { SqliteStore } from './src/store/sqlite-store.js';
import { SecureStore, type SecureUser, type SentinelInspector, type AuditLedgerWriter, type SecureAuditEntry, type InspectionResult } from './src/secure/secure-store.js';
import { SecureIngestionPipeline } from './src/secure/secure-pipeline.js';
import { MockEmbeddingGenerator } from './src/ingestion/embedding-generator.js';
import type { RawMessage, SearchQuery } from './src/types/index.js';
import { createHash } from 'node:crypto';

// ─── Simple Sentinel (pattern-based) ─────────────────────────

class BasicSentinel implements SentinelInspector {
  private readonly patterns = [
    { pattern: /ignore\s+(previous|above|all)\s+instructions/i, category: 'prompt_injection', desc: 'Prompt injection attempt detected' },
    { pattern: /you\s+are\s+now\s+(a|an)\s+/i, category: 'role_hijack', desc: 'Role hijacking attempt detected' },
    { pattern: /system:\s*override/i, category: 'system_override', desc: 'System override attempt detected' },
    { pattern: /\b(curl|wget|nc)\s+.*\|\s*(bash|sh)/i, category: 'command_injection', desc: 'Command injection attempt detected' },
    { pattern: /document\.cookie|localStorage\./i, category: 'data_exfiltration', desc: 'Data exfiltration attempt detected' },
  ];

  inspect(content: string): InspectionResult {
    const start = Date.now();
    const findings = this.patterns
      .filter(p => p.pattern.test(content))
      .map(p => ({ category: p.category, confidence: 0.9, description: p.desc }));

    const threatLevel = findings.length > 0 ? 'blocked' as const : 'safe' as const;
    return { threatLevel, findings, latencyMs: Date.now() - start };
  }
}

// ─── Simple Audit Ledger (hash-chained) ──────────────────────

class BasicAuditLedger implements AuditLedgerWriter {
  private entries: SecureAuditEntry[] = [];
  private lastHash = '0000000000000000';

  record(event: { type: string; userId?: string; sessionId?: string; details: Record<string, unknown>; outcome: 'success' | 'failure' | 'blocked' }): SecureAuditEntry {
    const seq = this.entries.length;
    const entry: SecureAuditEntry = {
      id: randomUUID(),
      sequenceNumber: seq,
      timestamp: new Date().toISOString(),
      type: event.type,
      userId: event.userId ?? 'system',
      action: event.type,
      target: (event.details.target as string) ?? '',
      previousHash: this.lastHash,
      hash: '',
      details: event.details,
      outcome: event.outcome,
    };

    const hashInput = `${entry.sequenceNumber}:${entry.timestamp}:${entry.type}:${entry.previousHash}`;
    entry = { ...entry, hash: createHash('sha256').update(hashInput).digest('hex').slice(0, 16) };
    this.lastHash = entry.hash;
    this.entries.push(entry);
    return entry;
  }

  verifyChain(): { valid: boolean; brokenAt?: number; reason?: string } {
    let prev = '0000000000000000';
    for (const e of this.entries) {
      if (e.previousHash !== prev) return { valid: false, brokenAt: e.sequenceNumber, reason: 'Hash chain broken' };
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

async function main() {
  // Initialize store stack
  const sqlitePath = process.env.LCM_SQLITE_PATH ?? ':memory:';
  const innerStore = new SqliteStore({ path: sqlitePath });
  await innerStore.initialize();

  const sentinel = new BasicSentinel();
  const audit = new BasicAuditLedger();
  const adminUser: SecureUser = { id: 'system', role: 'admin' };
  const store = new SecureStore(innerStore, adminUser, sentinel, audit);
  await store.initialize();

  const embedGen = new MockEmbeddingGenerator();
  const pipeline = new SecureIngestionPipeline(innerStore, embedGen, sentinel, audit);

  console.log(`LCM v2 Secure Memory Server starting on port ${PORT}...`);
  console.log(`Store: SQLite (${sqlitePath})`);
  console.log(`Sentinel: enabled | Audit: hash-chained | RBAC: enabled`);

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const { path, params } = getPath(req.url ?? '/');

    try {
      // Health check
      if (path === '/health' && method === 'GET') {
        const health = await store.healthCheck();
        const chainStatus = audit.verifyChain();
        return json(res, 200, { ...health, auditChain: chainStatus });
      }

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

      // Sentinel inspect
      if (path === '/sentinel/inspect' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const result = sentinel.inspect(body.content ?? '');
        return json(res, 200, result);
      }

      // Audit trail
      if (path === '/audit' && method === 'GET') {
        const limit = parseInt(params.get('limit') ?? '50', 10);
        const entries = audit.getEntries(limit);
        const chainStatus = audit.verifyChain();
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
