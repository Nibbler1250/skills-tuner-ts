import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { migrateRecord } from '../../scripts/migrate-from-python.js';
import { verifyProposalSignature } from '../../src/core/security.js';

// Minimal set of fields matching UnsignedProposalSchema
const BASE_ALTERNATIVES = [
  { id: 'A', label: 'Option A', diff_or_content: 'patch content', tradeoff: 'shorter' },
];

const PENDING_RAW = {
  id: 10,
  cluster_id: 'cluster-test-001',
  subject: 'skills',
  kind: 'patch',
  target_path: '/home/user/agent/skills/test-skill.md',
  alternatives: BASE_ALTERNATIVES,
  pattern_signature: 'sha256:deadbeef001',
  created_at: '2026-05-01T10:00:00.000000',
  status: 'pending',
  applied_alternative: null,
  applied_at: null,
  feedback: null,
  feedback_at: null,
  git_branch: null,
  git_commit: null,
  signature: '',
  // Extra Python-only fields
  recommended: 'A',
  confidence: 0.75,
  justification: 'Test justification',
  subjects_touched: ['test-skill'],
  sentiment_evidence: [],
};

const APPLIED_RAW = {
  ...PENDING_RAW,
  id: 11,
  pattern_signature: 'sha256:deadbeef002',
  status: 'applied',
  applied_alternative: 'B',
  applied_at: '2026-05-02T12:00:00.000000',
};

const REFUSED_RAW = {
  ...PENDING_RAW,
  id: 12,
  pattern_signature: 'sha256:deadbeef003',
  status: 'skipped',
  feedback_at: '2026-05-03T08:00:00.000000',
};

const META_LINE = { _meta: true, schema_version: 2, core_version: '0.1.0' };

describe('migrateRecord', () => {
  let secret: Buffer;

  beforeEach(() => {
    secret = randomBytes(32);
  });

  test('pending record emits exactly one created event', () => {
    const result = migrateRecord(PENDING_RAW, secret);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.event).toBe('created');
    expect(result.events[0]!.ts).toBe(new Date(PENDING_RAW.created_at).toISOString());
  });

  test('applied record emits created + applied events', () => {
    const result = migrateRecord(APPLIED_RAW, secret);
    expect(result.events).toHaveLength(2);
    const events = result.events.map((e) => e.event);
    expect(events).toContain('created');
    expect(events).toContain('applied');
    const applied = result.events.find((e) => e.event === 'applied')!;
    expect(applied.alternative_id).toBe('B');
    expect(applied.ts).toBe(new Date(APPLIED_RAW.applied_at!).toISOString());
  });

  test('skipped record emits created + refused events', () => {
    const result = migrateRecord(REFUSED_RAW, secret);
    expect(result.events).toHaveLength(2);
    const events = result.events.map((e) => e.event);
    expect(events).toContain('created');
    expect(events).toContain('refused');
    const refused = result.events.find((e) => e.event === 'refused')!;
    expect(refused.ts).toBe(new Date(REFUSED_RAW.feedback_at!).toISOString());
  });

  test('meta line is returned as meta passthrough', () => {
    const result = migrateRecord(META_LINE, secret);
    expect(result.events).toHaveLength(0);
    expect(result.meta).toEqual(META_LINE);
  });

  test('proposals are re-signed and signature verifies', () => {
    const result = migrateRecord(PENDING_RAW, secret);
    expect(result.events).toHaveLength(1);
    const proposal = result.events[0]!.proposal;
    expect(proposal.signature).toBeTruthy();
    expect(verifyProposalSignature(proposal, secret)).toBe(true);
  });

  test('legacy fields are stripped from proposal', () => {
    const result = migrateRecord(PENDING_RAW, secret);
    const proposal = result.events[0]!.proposal as Record<string, unknown>;
    expect(proposal.status).toBeUndefined();
    expect(proposal.applied_at).toBeUndefined();
    expect(proposal.applied_alternative).toBeUndefined();
    expect(proposal.feedback).toBeUndefined();
    expect(proposal.feedback_at).toBeUndefined();
    expect(proposal.git_branch).toBeUndefined();
    expect(proposal.git_commit).toBeUndefined();
    expect(proposal.recommended).toBeUndefined();
    expect(proposal.confidence).toBeUndefined();
    expect(proposal.justification).toBeUndefined();
  });

  test('already-wrapped TS record is returned as-is (idempotent)', () => {
    const tsRecord = {
      event: 'created',
      ts: '2026-05-01T10:00:00.000Z',
      proposal: { id: 99, signature: 'abc123' },
    };
    const result = migrateRecord(tsRecord, secret);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual(tsRecord);
  });

  test('reverted record emits created + applied + refused events', () => {
    const revertedRaw = {
      ...APPLIED_RAW,
      id: 13,
      pattern_signature: 'sha256:deadbeef004',
      status: 'reverted',
    };
    const result = migrateRecord(revertedRaw, secret);
    expect(result.events).toHaveLength(3);
    const events = result.events.map((e) => e.event);
    expect(events).toContain('created');
    expect(events).toContain('applied');
    expect(events).toContain('refused');
  });
});
