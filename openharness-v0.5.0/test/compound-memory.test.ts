/**
 * Tests for CompoundMemory — shared knowledge base with proposal pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentFSStore } from '../src/agentfs/store.js';
import { CompoundMemory } from '../src/agentfs/compound-memory.js';
import type { SentinelInspector, AuditLedgerWriter, InspectionResult } from '../src/secure/secure-store.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function createMockAudit(): AuditLedgerWriter {
  const records: unknown[] = [];
  return {
    record: (entry: unknown) => { records.push(entry); },
    getRecords: () => records,
  } as unknown as AuditLedgerWriter;
}

function createSafeSentinel(): SentinelInspector {
  return {
    inspect: () => ({ threatLevel: 'safe', findings: [], latencyMs: 0 } as InspectionResult),
  };
}

function createBlockingSentinel(keyword: string): SentinelInspector {
  return {
    inspect: (content: string) => {
      if (content.includes(keyword)) {
        return {
          threatLevel: 'blocked',
          findings: [{ category: 'injection', confidence: 99, description: 'blocked' }],
          latencyMs: 0,
        } as InspectionResult;
      }
      return { threatLevel: 'safe', findings: [], latencyMs: 0 } as InspectionResult;
    },
  };
}

function makeStore(): AgentFSStore {
  const store = new AgentFSStore({ dbPath: ':memory:', agentId: 'test-agent' });
  store.initialize();
  return store;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CompoundMemory', () => {
  let store: AgentFSStore;
  let memory: CompoundMemory;
  let audit: AuditLedgerWriter;

  beforeEach(() => {
    store = makeStore();
    audit = createMockAudit();
    memory = new CompoundMemory(store, createSafeSentinel(), audit);
  });

  describe('loadContext()', () => {
    it('returns empty string when no sections written', () => {
      expect(memory.loadContext()).toBe('');
    });

    it('returns formatted sections after approvals', () => {
      const id = memory.proposeUpdate('GOTCHAS', 'Always use UTC timestamps', 'agent-1');
      memory.approveUpdate(id);

      const ctx = memory.loadContext();
      expect(ctx).toContain('## GOTCHAS');
      expect(ctx).toContain('Always use UTC timestamps');
    });

    it('includes all populated sections', () => {
      const id1 = memory.proposeUpdate('STYLE', 'Use 2-space indent', 'a1');
      const id2 = memory.proposeUpdate('ARCH_DECISIONS', 'SQLite over Postgres for tests', 'a2');
      memory.approveUpdate(id1);
      memory.approveUpdate(id2);

      const ctx = memory.loadContext();
      expect(ctx).toContain('## STYLE');
      expect(ctx).toContain('## ARCH_DECISIONS');
    });
  });

  describe('proposeUpdate()', () => {
    it('creates a proposal with a unique UUID key', () => {
      const id1 = memory.proposeUpdate('STYLE', 'entry one', 'agent-1');
      const id2 = memory.proposeUpdate('STYLE', 'entry two', 'agent-2');
      expect(id1).not.toBe(id2);

      const proposals = memory.listProposals();
      expect(proposals).toHaveLength(2);
    });

    it('throws on invalid section name', () => {
      expect(() => memory.proposeUpdate('INVALID_SECTION', 'entry', 'agent-1'))
        .toThrow(/Invalid section/);
    });

    it('two simultaneous proposals to the same section do not collide', () => {
      const id1 = memory.proposeUpdate('GOTCHAS', 'watch for X', 'agent-1');
      const id2 = memory.proposeUpdate('GOTCHAS', 'watch for Y', 'agent-2');

      const proposals = memory.listProposals();
      const ids = proposals.map(p => p.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(proposals.find(p => p.id === id1)?.entry).toBe('watch for X');
      expect(proposals.find(p => p.id === id2)?.entry).toBe('watch for Y');
    });
  });

  describe('approveUpdate()', () => {
    it('writes entry to section and removes proposal', () => {
      const id = memory.proposeUpdate('STYLE', 'Use explicit return types', 'agent-1');
      const result = memory.approveUpdate(id);

      expect(result).toBe(true);
      expect(memory.getSection('STYLE')).toContain('Use explicit return types');
      expect(memory.listProposals()).toHaveLength(0);
    });

    it('returns false for non-existent proposal', () => {
      expect(memory.approveUpdate('non-existent-uuid')).toBe(false);
    });

    it('appends multiple approved entries to the same section', () => {
      const id1 = memory.proposeUpdate('TEST_STRATEGY', 'Unit test pure functions', 'a1');
      const id2 = memory.proposeUpdate('TEST_STRATEGY', 'Integration test at boundaries', 'a2');
      memory.approveUpdate(id1);
      memory.approveUpdate(id2);

      const section = memory.getSection('TEST_STRATEGY')!;
      expect(section).toContain('Unit test pure functions');
      expect(section).toContain('Integration test at boundaries');
    });

    it('sentinel-inspects at approval time and blocks injected content', () => {
      const blockingSentinel = createBlockingSentinel('INJECT');
      const guardedMemory = new CompoundMemory(store, blockingSentinel, audit);

      const id = guardedMemory.proposeUpdate('GOTCHAS', 'INJECT malicious content here', 'agent-evil');
      const result = guardedMemory.approveUpdate(id);

      expect(result).toBe(false);
      expect(guardedMemory.getSection('GOTCHAS')).toBeNull();
      // Proposal should be removed after block
      expect(guardedMemory.listProposals()).toHaveLength(0);
    });

    it('approves clean content even with blocking sentinel active for other keywords', () => {
      const blockingSentinel = createBlockingSentinel('DANGER');
      const guardedMemory = new CompoundMemory(store, blockingSentinel, audit);

      const id = guardedMemory.proposeUpdate('STYLE', 'Safe and clean entry', 'agent-1');
      const result = guardedMemory.approveUpdate(id);

      expect(result).toBe(true);
      expect(guardedMemory.getSection('STYLE')).toContain('Safe and clean entry');
    });
  });

  describe('rejectUpdate()', () => {
    it('removes proposal and returns true', () => {
      const id = memory.proposeUpdate('GOTCHAS', 'some entry', 'agent-1');
      const result = memory.rejectUpdate(id, 'Not accurate enough');

      expect(result).toBe(true);
      expect(memory.listProposals()).toHaveLength(0);
    });

    it('returns false for non-existent proposal', () => {
      expect(memory.rejectUpdate('not-a-real-id', 'reason')).toBe(false);
    });

    it('does not write anything to the section', () => {
      const id = memory.proposeUpdate('ARCH_DECISIONS', 'Use PostgreSQL', 'agent-1');
      memory.rejectUpdate(id, 'We use SQLite');

      expect(memory.getSection('ARCH_DECISIONS')).toBeNull();
    });
  });

  describe('audit trail', () => {
    it('records proposal_created, proposal_approved events', () => {
      const records = (audit as unknown as { getRecords: () => unknown[] }).getRecords();
      const id = memory.proposeUpdate('STYLE', 'entry', 'agent-1');
      memory.approveUpdate(id);

      const types = records.map((r: unknown) => (r as { type: string }).type);
      expect(types).toContain('compound_memory:proposal_created');
      expect(types).toContain('compound_memory:proposal_approved');
    });

    it('records proposal_rejected event', () => {
      const records = (audit as unknown as { getRecords: () => unknown[] }).getRecords();
      const id = memory.proposeUpdate('GOTCHAS', 'entry', 'agent-1');
      memory.rejectUpdate(id, 'Reason');

      const types = records.map((r: unknown) => (r as { type: string }).type);
      expect(types).toContain('compound_memory:proposal_rejected');
    });

    it('records sentinel_blocked event when approval is blocked', () => {
      const records = (audit as unknown as { getRecords: () => unknown[] }).getRecords();
      const blockingSentinel = createBlockingSentinel('MALICIOUS');
      const guardedMemory = new CompoundMemory(store, blockingSentinel, audit);

      const id = guardedMemory.proposeUpdate('STYLE', 'MALICIOUS payload', 'agent-evil');
      guardedMemory.approveUpdate(id);

      const types = records.map((r: unknown) => (r as { type: string }).type);
      expect(types).toContain('compound_memory:proposal_sentinel_blocked');
    });
  });
});
