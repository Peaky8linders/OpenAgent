/**
 * Compound Memory — shared knowledge base that compounds across agent sessions.
 *
 * Backed by AgentFS key-value store. Agents NEVER write directly (per ETH Zurich
 * multi-agent research) — all updates go through a propose → human-approve pipeline.
 *
 * Section keys:
 *   agents_md:section:{SECTION}         → current approved content
 *   agents_md:proposal:{uuid}           → pending proposal (JSON: ProposalEntry)
 *
 *                ┌──────────────┐
 *   agent calls  │proposeUpdate │  → agents_md:proposal:{uuid} (kvSet)
 *                └──────┬───────┘
 *                       │ lead/human reviews
 *             ┌─────────┴──────────┐
 *             │                    │
 *      approveUpdate()      rejectUpdate()
 *   sentinel-inspects,     deletes proposal,
 *   writes to section,     records reason
 *   deletes proposal       in audit
 */
import { randomUUID } from 'node:crypto';
import type { AgentFSStore } from './store.js';
import type { SentinelInspector, AuditLedgerWriter } from '../secure/secure-store.js';

export type MemorySection = 'STYLE' | 'GOTCHAS' | 'ARCH_DECISIONS' | 'TEST_STRATEGY';

const VALID_SECTIONS: readonly MemorySection[] = ['STYLE', 'GOTCHAS', 'ARCH_DECISIONS', 'TEST_STRATEGY'];

export interface Proposal {
  readonly id: string;
  readonly section: MemorySection;
  readonly entry: string;
  readonly agentId: string;
  readonly proposedAt: number;
}

export class CompoundMemory {
  private readonly store: AgentFSStore;
  private readonly sentinel: SentinelInspector | null;
  private readonly audit: AuditLedgerWriter | null;

  constructor(
    store: AgentFSStore,
    sentinel?: SentinelInspector,
    audit?: AuditLedgerWriter,
  ) {
    this.store = store;
    this.sentinel = sentinel ?? null;
    this.audit = audit ?? null;
  }

  /**
   * Load all section content as a formatted context string.
   * Returns empty string if no sections have been written yet.
   */
  loadContext(): string {
    const parts: string[] = [];
    for (const section of VALID_SECTIONS) {
      const content = this.store.kvGet(`agents_md:section:${section}`) as string | null;
      if (content) {
        parts.push(`## ${section}\n${content}`);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * Propose a new entry for a section.
   * Returns the proposal ID. Throws on invalid section.
   */
  proposeUpdate(section: string, entry: string, agentId: string): string {
    if (!(VALID_SECTIONS as readonly string[]).includes(section)) {
      throw new Error(`Invalid section '${section}'. Valid: ${VALID_SECTIONS.join(', ')}`);
    }

    const id = randomUUID();
    const proposal: Proposal = {
      id,
      section: section as MemorySection,
      entry,
      agentId,
      proposedAt: Date.now(),
    };

    this.store.kvSet(`agents_md:proposal:${id}`, proposal);
    this.audit?.record({
      type: 'compound_memory:proposal_created',
      details: { proposalId: id, section, agentId, entryLength: entry.length },
      outcome: 'success',
    });

    return id;
  }

  /**
   * Approve a proposal. Sentinel-inspects at approval time (not just at proposal time)
   * to catch any patterns that emerged between propose and approve.
   * Returns false if proposal not found or sentinel blocks.
   */
  approveUpdate(proposalId: string): boolean {
    const raw = this.store.kvGet(`agents_md:proposal:${proposalId}`);
    if (!raw) return false;

    const proposal = raw as Proposal;

    // Sentinel-inspect at approval time
    if (this.sentinel) {
      const result = this.sentinel.inspect(proposal.entry);
      if (result.threatLevel === 'blocked') {
        this.audit?.record({
          type: 'compound_memory:proposal_sentinel_blocked',
          details: {
            proposalId,
            section: proposal.section,
            findings: result.findings.map(f => f.category),
          },
          outcome: 'blocked',
        });
        // Remove the blocked proposal
        this.store.kvDelete(`agents_md:proposal:${proposalId}`);
        return false;
      }
    }

    // Append to the section (newline-separated entries)
    const existing = (this.store.kvGet(`agents_md:section:${proposal.section}`) as string | null) ?? '';
    const updated = existing ? `${existing}\n- ${proposal.entry}` : `- ${proposal.entry}`;
    this.store.kvSet(`agents_md:section:${proposal.section}`, updated);

    // Remove the proposal
    this.store.kvDelete(`agents_md:proposal:${proposalId}`);

    this.audit?.record({
      type: 'compound_memory:proposal_approved',
      details: { proposalId, section: proposal.section, agentId: proposal.agentId },
      outcome: 'success',
    });

    return true;
  }

  /**
   * Reject a proposal with a reason. Removes the proposal and audit-logs the rejection.
   * Returns false if proposal not found.
   */
  rejectUpdate(proposalId: string, reason: string): boolean {
    const raw = this.store.kvGet(`agents_md:proposal:${proposalId}`);
    if (!raw) return false;

    const proposal = raw as Proposal;
    this.store.kvDelete(`agents_md:proposal:${proposalId}`);

    this.audit?.record({
      type: 'compound_memory:proposal_rejected',
      details: { proposalId, section: proposal.section, agentId: proposal.agentId, reason },
      outcome: 'failure',
    });

    return true;
  }

  /** List all pending proposals. */
  listProposals(): Proposal[] {
    const entries = this.store.kvList('agents_md:proposal:');
    return entries
      .filter(e => e.key !== 'agents_md:proposal:') // exclude prefix itself if stored
      .map(e => JSON.parse(e.value) as Proposal);
  }

  /** Get the current content of a section. */
  getSection(section: MemorySection): string | null {
    return (this.store.kvGet(`agents_md:section:${section}`) as string | null) ?? null;
  }
}
