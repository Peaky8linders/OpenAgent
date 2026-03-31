/**
 * AgentFS Store — SQLite-backed agent filesystem with OpenHarness governance.
 *
 * Implements the AgentFS schema (inode, dentry, kv, toolcall tables)
 * on top of Node's built-in SQLite, with sentinel inspection on every
 * write and hash-chained audit logging of all operations.
 *
 * This is the bridge between Turso's AgentFS and our governance layer:
 *   AgentFS provides: filesystem isolation, portability, tool call recording
 *   OpenHarness adds: content inspection, RBAC, compliance audit, eval gates
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  AgentFSConfig, AgentInode, AgentDentry, AgentKVEntry,
  AgentToolCall, GovernedWrite, AgentSnapshot,
} from './types.js';
import type { SentinelInspector, AuditLedgerWriter, InspectionResult } from '../secure/secure-store.js';

const ROOT_INO = 1;

export class AgentFSStore {
  private readonly db: DatabaseSync;
  private readonly agentId: string;
  private readonly agentName: string;
  private readonly readOnly: boolean;
  private readonly sentinel: SentinelInspector | null;
  private readonly audit: AuditLedgerWriter | null;
  private nextIno: number = ROOT_INO + 1;

  constructor(
    config: AgentFSConfig,
    sentinel?: SentinelInspector,
    audit?: AuditLedgerWriter,
  ) {
    this.db = new DatabaseSync(config.dbPath);
    this.agentId = config.agentId;
    this.agentName = config.agentName ?? config.agentId;
    this.readOnly = config.readOnly ?? false;
    this.sentinel = sentinel ?? null;
    this.audit = audit ?? null;
  }

  /** Initialize the AgentFS schema (mirrors Turso's spec). */
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inode (
        ino INTEGER PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        mode INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL,
        ctime INTEGER NOT NULL,
        data BLOB
      );
      CREATE TABLE IF NOT EXISTS dentry (
        parent_ino INTEGER NOT NULL,
        name TEXT NOT NULL,
        ino INTEGER NOT NULL,
        file_type TEXT NOT NULL DEFAULT 'file',
        PRIMARY KEY (parent_ino, name)
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS toolcall (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER,
        sentinel_result TEXT,
        eval_gates_checked TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_toolcall_agent ON toolcall(agent_id);
      CREATE INDEX IF NOT EXISTS idx_toolcall_status ON toolcall(status);
      CREATE INDEX IF NOT EXISTS idx_dentry_ino ON dentry(ino);
    `);

    // Ensure root directory exists
    const root = this.db.prepare('SELECT ino FROM inode WHERE ino = ?').get(ROOT_INO) as { ino: number } | undefined;
    if (!root) {
      const now = Date.now();
      this.db.prepare('INSERT INTO inode (ino, size, mode, mtime, ctime) VALUES (?, 0, 16877, ?, ?)').run(ROOT_INO, now, now);
    }

    // Find max inode number
    const maxRow = this.db.prepare('SELECT MAX(ino) as m FROM inode').get() as { m: number | null };
    this.nextIno = (maxRow?.m ?? ROOT_INO) + 1;

    this.log('agentfs:initialized', this.agentId, 'success');
  }

  // ─── Filesystem Operations ───────────────────────────────────

  /** Write a file, governed by sentinel inspection. */
  writeFile(path: string, content: string): GovernedWrite {
    if (this.readOnly) {
      throw new Error(`AgentFS ${this.agentId} is read-only`);
    }

    // Sentinel inspection BEFORE write
    let inspectionResult: 'safe' | 'suspicious' | 'blocked' = 'safe';
    if (this.sentinel) {
      const result = this.sentinel.inspect(content);
      inspectionResult = result.threatLevel;
      if (result.threatLevel === 'blocked') {
        this.log('agentfs:write_blocked', path, 'blocked', {
          agent: this.agentId,
          findings: result.findings.length,
          categories: result.findings.map(f => f.category),
        });
        return { path, content, agentId: this.agentId, inspectionResult, allowed: false, timestamp: Date.now() };
      }
    }

    const parts = this.parsePath(path);
    let parentIno = ROOT_INO;

    // Ensure parent directories exist
    for (let i = 0; i < parts.length - 1; i++) {
      parentIno = this.ensureDirectory(parentIno, parts[i]!);
    }

    const fileName = parts[parts.length - 1]!;
    const data = Buffer.from(content, 'utf-8');
    const now = Date.now();

    // Check if file exists
    const existing = this.db.prepare(
      'SELECT d.ino FROM dentry d WHERE d.parent_ino = ? AND d.name = ?',
    ).get(parentIno, fileName) as { ino: number } | undefined;

    if (existing) {
      // Update existing file
      this.db.prepare('UPDATE inode SET size = ?, mtime = ?, data = ? WHERE ino = ?')
        .run(data.length, now, data, existing.ino);
    } else {
      // Create new file
      const ino = this.nextIno++;
      this.db.prepare('INSERT INTO inode (ino, size, mode, mtime, ctime, data) VALUES (?, ?, 33188, ?, ?, ?)')
        .run(ino, data.length, now, now, data);
      this.db.prepare('INSERT INTO dentry (parent_ino, name, ino, file_type) VALUES (?, ?, ?, ?)')
        .run(parentIno, fileName, ino, 'file');
    }

    this.log('agentfs:write', path, 'success', { agent: this.agentId, size: data.length, sentinel: inspectionResult });

    return { path, content, agentId: this.agentId, inspectionResult, allowed: true, timestamp: now };
  }

  /** Read a file. */
  readFile(path: string): string | null {
    const ino = this.resolveInode(path);
    if (ino === null) return null;

    const row = this.db.prepare('SELECT data FROM inode WHERE ino = ?').get(ino) as { data: Buffer | null } | undefined;
    if (!row?.data) return null;

    this.log('agentfs:read', path, 'success', { agent: this.agentId });
    return Buffer.from(row.data).toString('utf-8');
  }

  /** List files in a directory. */
  listDir(path: string = '/'): AgentDentry[] {
    const ino = path === '/' ? ROOT_INO : this.resolveInode(path);
    if (ino === null) return [];

    const rows = this.db.prepare(
      'SELECT parent_ino, name, ino, file_type FROM dentry WHERE parent_ino = ?',
    ).all(ino) as unknown as AgentDentry[];
    return rows;
  }

  /** Check if a file exists. */
  exists(path: string): boolean {
    return this.resolveInode(path) !== null;
  }

  /** Delete a file. */
  deleteFile(path: string): boolean {
    if (this.readOnly) throw new Error(`AgentFS ${this.agentId} is read-only`);

    const parts = this.parsePath(path);
    const fileName = parts[parts.length - 1]!;
    let parentIno = ROOT_INO;
    for (let i = 0; i < parts.length - 1; i++) {
      const child = this.db.prepare(
        'SELECT ino FROM dentry WHERE parent_ino = ? AND name = ? AND file_type = ?',
      ).get(parentIno, parts[i]!, 'directory') as { ino: number } | undefined;
      if (!child) return false;
      parentIno = child.ino;
    }

    const entry = this.db.prepare(
      'SELECT ino FROM dentry WHERE parent_ino = ? AND name = ?',
    ).get(parentIno, fileName) as { ino: number } | undefined;
    if (!entry) return false;

    this.db.prepare('DELETE FROM dentry WHERE parent_ino = ? AND name = ?').run(parentIno, fileName);
    this.db.prepare('DELETE FROM inode WHERE ino = ?').run(entry.ino);
    this.log('agentfs:delete', path, 'success', { agent: this.agentId });
    return true;
  }

  // ─── Key-Value Store ─────────────────────────────────────────

  kvSet(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    const now = Date.now();
    this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    ).run(key, json, now);
    this.log('agentfs:kv_set', key, 'success', { agent: this.agentId });
  }

  kvGet(key: string): unknown | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  kvList(prefix: string = ''): AgentKVEntry[] {
    // Escape LIKE wildcards in prefix to prevent unintended pattern expansion
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const rows = this.db.prepare(
      "SELECT key, value, updated_at FROM kv WHERE key LIKE ? ESCAPE '\\'",
    ).all(`${escaped}%`) as unknown as AgentKVEntry[];
    return rows;
  }

  kvDelete(key: string): boolean {
    const result = this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    return result.changes > 0;
  }

  // ─── Tool Call Audit ─────────────────────────────────────────

  /**
   * Record a tool call. Optionally inspects output through sentinel.
   * This is the core integration point: every agent tool invocation
   * is recorded AND governed.
   */
  recordToolCall(
    toolName: string,
    input: Record<string, unknown>,
    output: Record<string, unknown> | null,
    status: AgentToolCall['status'],
    durationMs: number | null,
  ): AgentToolCall {
    const id = randomUUID();
    const now = Date.now();

    // Inspect output if sentinel is available
    let sentinelResult: string | null = null;
    let evalGates: string[] | undefined;

    if (this.sentinel && output) {
      const outputStr = JSON.stringify(output);
      const inspection = this.sentinel.inspect(outputStr);
      sentinelResult = inspection.threatLevel;

      if (inspection.threatLevel === 'blocked') {
        status = 'blocked';
        this.log('agentfs:toolcall_blocked', toolName, 'blocked', {
          agent: this.agentId,
          findings: inspection.findings.map(f => f.category),
        });
      }
    }

    this.db.prepare(`
      INSERT INTO toolcall (id, agent_id, tool_name, input, output, status, started_at, completed_at, duration_ms, sentinel_result, eval_gates_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, this.agentId, toolName,
      JSON.stringify(input), output ? JSON.stringify(output) : null,
      status, now - (durationMs ?? 0), durationMs ? now : null,
      durationMs, sentinelResult, evalGates ? JSON.stringify(evalGates) : null,
    );

    this.log('agentfs:toolcall', toolName, status === 'blocked' ? 'blocked' : 'success', {
      agent: this.agentId, tool: toolName, status, duration: durationMs,
    });

    return {
      id, agent_id: this.agentId, tool_name: toolName,
      input, output, status, started_at: now - (durationMs ?? 0),
      completed_at: durationMs ? now : null, duration_ms: durationMs,
      sentinel_result: sentinelResult as AgentToolCall['sentinel_result'],
      eval_gates_checked: evalGates,
    };
  }

  /** Query tool calls with SQL-like filtering. */
  queryToolCalls(opts?: {
    agentId?: string;
    toolName?: string;
    status?: string;
    since?: number;
    limit?: number;
  }): AgentToolCall[] {
    let sql = 'SELECT * FROM toolcall WHERE 1=1';
    const params: unknown[] = [];

    if (opts?.agentId) { sql += ' AND agent_id = ?'; params.push(opts.agentId); }
    if (opts?.toolName) { sql += ' AND tool_name = ?'; params.push(opts.toolName); }
    if (opts?.status) { sql += ' AND status = ?'; params.push(opts.status); }
    if (opts?.since) { sql += ' AND started_at >= ?'; params.push(opts.since); }

    sql += ' ORDER BY started_at DESC';
    if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

    const rows = this.db.prepare(sql).all(...(params as Array<string | number>)) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      agent_id: r.agent_id as string,
      tool_name: r.tool_name as string,
      input: JSON.parse(r.input as string),
      output: r.output ? JSON.parse(r.output as string) : null,
      status: r.status as AgentToolCall['status'],
      started_at: r.started_at as number,
      completed_at: r.completed_at as number | null,
      duration_ms: r.duration_ms as number | null,
      sentinel_result: r.sentinel_result as AgentToolCall['sentinel_result'],
      eval_gates_checked: r.eval_gates_checked ? JSON.parse(r.eval_gates_checked as string) : undefined,
    }));
  }

  // ─── Snapshots ───────────────────────────────────────────────

  /** Get stats for snapshot metadata. */
  getStats(): { fileCount: number; kvCount: number; toolCallCount: number } {
    const files = this.db.prepare("SELECT COUNT(*) as c FROM dentry WHERE file_type = 'file'").get() as { c: number };
    const kvs = this.db.prepare('SELECT COUNT(*) as c FROM kv').get() as { c: number };
    const tools = this.db.prepare('SELECT COUNT(*) as c FROM toolcall').get() as { c: number };
    return { fileCount: files.c, kvCount: kvs.c, toolCallCount: tools.c };
  }

  // ─── Internals ───────────────────────────────────────────────

  private resolveInode(path: string): number | null {
    const parts = this.parsePath(path);
    let currentIno = ROOT_INO;

    for (const part of parts) {
      const row = this.db.prepare(
        'SELECT ino FROM dentry WHERE parent_ino = ? AND name = ?',
      ).get(currentIno, part) as { ino: number } | undefined;
      if (!row) return null;
      currentIno = row.ino;
    }
    return currentIno;
  }

  private ensureDirectory(parentIno: number, name: string): number {
    const existing = this.db.prepare(
      'SELECT ino FROM dentry WHERE parent_ino = ? AND name = ? AND file_type = ?',
    ).get(parentIno, name, 'directory') as { ino: number } | undefined;

    if (existing) return existing.ino;

    const ino = this.nextIno++;
    const now = Date.now();
    this.db.prepare('INSERT INTO inode (ino, size, mode, mtime, ctime) VALUES (?, 0, 16877, ?, ?)').run(ino, now, now);
    this.db.prepare('INSERT INTO dentry (parent_ino, name, ino, file_type) VALUES (?, ?, ?, ?)').run(parentIno, name, ino, 'directory');
    return ino;
  }

  private parsePath(path: string): string[] {
    const parts = path.split('/').filter(p => p.length > 0);
    if (parts.some(p => p === '..')) {
      throw new Error(`Path traversal not allowed: ${path}`);
    }
    return parts;
  }

  private log(type: string, target: string, outcome: 'success' | 'failure' | 'blocked', details?: Record<string, unknown>): void {
    this.audit?.record({ type, details: details ?? {}, outcome });
  }

  close(): void {
    this.db.close();
  }
}
