import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProposalsStore } from '../../src/storage/proposals.js';
import type { ProposalRecord } from '../../src/storage/proposals.js';
import { RefusedStore } from '../../src/storage/refused.js';
import { migrateRecord, detectSchemaVersion, CURRENT_SCHEMA_VERSION } from '../../src/storage/migrations.js';
import type { Proposal } from '../../src/core/types.js';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1, cluster_id: 'c1', subject: 'skills', kind: 'patch',
    target_path: '/tmp/test.md',
    alternatives: [{ id: 'A', label: 'test', diff_or_content: 'foo', tradeoff: '' }],
    pattern_signature: 'sig-abc',
    created_at: new Date('2026-05-09T00:00:00Z'),
    ...overrides,
  };
}

describe('ProposalsStore', () => {
  let dir: string;
  let store: ProposalsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tuner-test-'));
    store = new ProposalsStore(join(dir, 'proposals.jsonl'));
  });

  afterEach(() => rmSync(dir, { recursive: true }));

  test('append and readAll round-trips a record', () => {
    const record: ProposalRecord = {
      proposal: makeProposal(),
      event: 'created',
      ts: new Date().toISOString(),
    };
    store.append(record);
    const all = store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].event).toBe('created');
    expect(all[0].proposal.pattern_signature).toBe('sig-abc');
  });

  test('pendingSignatures excludes applied signatures', () => {
    const p = makeProposal();
    store.append({ proposal: p, event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: p, event: 'applied', ts: new Date().toISOString(), alternative_id: 'A' });
    expect(store.pendingSignatures().has('sig-abc')).toBe(false);
  });

  test('pendingSignatures returns unresolved signatures only', () => {
    store.append({ proposal: makeProposal({ pattern_signature: 'sig-1' }), event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: makeProposal({ pattern_signature: 'sig-2', id: 2 }), event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: makeProposal({ pattern_signature: 'sig-2', id: 3 }), event: 'refused', ts: new Date().toISOString() });
    const pending = store.pendingSignatures();
    expect(pending.has('sig-1')).toBe(true);
    expect(pending.has('sig-2')).toBe(false);
  });

  test('appliedSignatures returns recently applied', () => {
    const p = makeProposal({ target_path: join(dir, 'nonexistent.md') });
    store.append({ proposal: p, event: 'applied', ts: new Date().toISOString(), alternative_id: 'A' });
    expect(store.appliedSignatures({ withinDays: 7 }).has('sig-abc')).toBe(true);
  });

  test('appliedSignatures skips old entries', () => {
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const p = makeProposal({ target_path: join(dir, 'nonexistent.md') });
    store.append({ proposal: p, event: 'applied', ts: oldTs, alternative_id: 'A' });
    expect(store.appliedSignatures({ withinDays: 7 }).has('sig-abc')).toBe(false);
  });

  test('appliedSignatures skips if target file modified after applied', () => {
    const skillPath = join(dir, 'skill.md');
    const past = new Date(Date.now() - 5000).toISOString();
    writeFileSync(skillPath, '# skill');
    // File mtime is NOW, but applied ts is in the past — so mtime > ts → skip
    const p = makeProposal({ target_path: skillPath });
    store.append({ proposal: p, event: 'applied', ts: past, alternative_id: 'A' });
    expect(store.appliedSignatures({ withinDays: 7 }).has('sig-abc')).toBe(false);
  });
});

describe('RefusedStore', () => {
  let dir: string;
  let store: RefusedStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tuner-refused-'));
    store = new RefusedStore(join(dir, 'refused.jsonl'), 30);
  });

  afterEach(() => rmSync(dir, { recursive: true }));

  test('add and activeSignatures', () => {
    store.add('sig-xyz', 'skills');
    expect(store.activeSignatures().has('sig-xyz')).toBe(true);
  });

  test('isRefused returns true for active signature', () => {
    store.add('sig-xyz', 'skills');
    expect(store.isRefused('sig-xyz')).toBe(true);
  });

  test('isRefused returns false for unknown signature', () => {
    expect(store.isRefused('sig-unknown')).toBe(false);
  });

  test('TTL=0 entries are immediately expired', () => {
    const store0 = new RefusedStore(join(dir, 'refused0.jsonl'), 0);
    store0.add('sig-expired', 'skills');
    expect(store0.isRefused('sig-expired')).toBe(false);
  });
});

describe('migrations', () => {
  test('CURRENT_SCHEMA_VERSION is 1', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  test('migrateRecord is identity for current version', () => {
    const record = { id: 1, kind: 'patch' };
    expect(migrateRecord(record)).toEqual(record);
  });

  test('detectSchemaVersion reads version from meta line', () => {
    expect(detectSchemaVersion(JSON.stringify({ schema_version: 1, _meta: true }))).toBe(1);
  });

  test('detectSchemaVersion defaults to 1 for missing field', () => {
    expect(detectSchemaVersion('{}')).toBe(1);
  });

  test('detectSchemaVersion defaults to 1 for invalid JSON', () => {
    expect(detectSchemaVersion('not-json')).toBe(1);
  });
});
