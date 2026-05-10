import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { ProposalsStore } from '../../src/storage/proposals.js';
import { RefusedStore } from '../../src/storage/refused.js';
import { Engine } from '../../src/core/engine.js';
import { Registry } from '../../src/core/registry.js';
import { BranchManager } from '../../src/git_ops/branches.js';
import { TunableSubject } from '../../src/core/interfaces.js';
import { type Cluster, type Observation, type UnsignedProposal, type Patch, type ValidationResult } from '../../src/core/types.js';

class FixedSigSubject extends TunableSubject {
  override readonly name = 'skills';
  override readonly risk_tier = 'low';
  constructor(private sig: string) { super(); }
  override async collectObservations(_since: Date): Promise<Observation[]> {
    return [{
      session_id: 's', observed_at: new Date(), signal_type: 'correction',
      verbatim: 'fix this', metadata: {},
    }];
  }
  override async detectProblems(obs: Observation[]): Promise<Cluster[]> {
    return [{
      id: 'c1', subject: 'skills', observations: obs,
      frequency: 5, success_rate: 0.1, sentiment: 'negative', subjects_touched: [],
    }];
  }
  override async proposeChange(_cluster: Cluster): Promise<UnsignedProposal> {
    return {
      id: 0, cluster_id: 'c1', subject: 'skills', kind: 'patch',
      target_path: '/tmp/x.md',
      alternatives: [{ id: 'A', label: 'a', diff_or_content: 'x', tradeoff: '' }],
      pattern_signature: this.sig,
      created_at: new Date(),
    };
  }
  override async validateProposal(_p: UnsignedProposal): Promise<ValidationResult> {
    return { valid: true };
  }
  override async applyPatch(_p: any): Promise<Patch> {
    return { target_path: '/tmp/x.md', kind: 'patch', applied_content: 'x' };
  }
  override currentStateHash(): string | null { return 'hash-1'; }
}

function makeConfig(tmp: string, gitRepo: string): any {
  return {
    models: {}, llm: {}, detection: { confidence_floor: 0.5, max_proposals_per_run: 5, improvement_keywords_extra: [] },
    proposer: { alternatives_count: 3, language_preference: 'en' },
    subjects: { skills: { enabled: true, scan_dirs: [], auto_merge: false } },
    ui: {},
    storage: {
      proposals_jsonl: join(tmp, 'p.jsonl'),
      refused_jsonl: join(tmp, 'r.jsonl'),
      schema_version: 1, backup_keep: 7, git_repo: gitRepo,
    },
  };
}

describe('Refused dedup resilience', () => {
  let tmp: string; let gitRepo: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `tuner-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    gitRepo = join(tmp, 'repo');
    mkdirSync(gitRepo);
    execSync('git init -q && git config user.email t@e.com && git config user.name t', { cwd: gitRepo });
    writeFileSync(join(gitRepo, 'README.md'), '# t');
    execSync('git add . && git commit -q -m init', { cwd: gitRepo });
    process.env['TUNER_AUDIT_PATH'] = join(tmp, 'audit.jsonl');
  });

  afterEach(() => {
    delete process.env['TUNER_AUDIT_PATH'];
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test('engine skips proposal whose pattern_signature appears as event:refused even if refused.jsonl is empty', async () => {
    const fixedSig = 'sha256:fixed-test-sig-001';
    const config = makeConfig(tmp, gitRepo);

    // Pre-seed proposals.jsonl with a refused event but DO NOT touch refused.jsonl
    const proposalsPath = config.storage.proposals_jsonl;
    const fakeRefused = {
      proposal: {
        id: 1, cluster_id: 'c0', subject: 'skills', kind: 'patch',
        target_path: '/tmp/x.md', alternatives: [], pattern_signature: fixedSig,
        signature: 'sig', created_at: new Date().toISOString(),
      },
      event: 'refused',
      ts: new Date().toISOString(),
    };
    writeFileSync(proposalsPath, JSON.stringify(fakeRefused) + '\n');

    const proposals = new ProposalsStore(proposalsPath);
    const refused = new RefusedStore(config.storage.refused_jsonl);
    const branches = new BranchManager(gitRepo);
    const registry = new Registry();
    registry.registerSubject(new FixedSigSubject(fixedSig));
    const engine = new Engine(config, registry, proposals, refused, branches);

    const result = await engine.runCycle({ since: new Date(0), dryRun: true });
    expect(result.proposed).toBe(0);
    expect(refused.activeSignatures().size).toBe(0); // refused.jsonl truly empty
    expect(proposals.refusedSignatures().has(fixedSig)).toBe(true); // dedup came from proposals.jsonl
  });

  test('RefusedStore activeSignatures accepts legacy ttl_until field (Python migration compat)', () => {
    const refusedPath = join(tmp, 'r.jsonl');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const legacyRecord = {
      pattern_signature: 'sha256:legacy-001',
      subject: 'skills',
      user_reason: 'regretted',
      first_proposed_at: '2026-01-01T00:00:00Z',
      refused_at: '2026-01-01T00:00:00Z',
      ttl_until: future,
    };
    writeFileSync(refusedPath, JSON.stringify({ _meta: true, schema_version: 1 }) + '\n' + JSON.stringify(legacyRecord) + '\n');
    const store = new RefusedStore(refusedPath);
    const sigs = store.activeSignatures();
    expect(sigs.has('sha256:legacy-001')).toBe(true);
  });

  test('RefusedStore.add silently no-ops on empty signature (avoids garbage entries)', () => {
    const refusedPath = join(tmp, 'r.jsonl');
    const store = new RefusedStore(refusedPath);
    store.add('', 'skills', 'reason');
    expect(existsSync(refusedPath)).toBe(false);
  });

  test('addWithExpiry preserves original timestamp + custom expiry', () => {
    const refusedPath = join(tmp, 'r.jsonl');
    const store = new RefusedStore(refusedPath);
    const orig = '2026-01-01T00:00:00.000Z';
    const expiry = '2099-01-01T00:00:00.000Z';
    store.addWithExpiry('sha256:x', 'skills', 'migrated', orig, expiry);
    const sigs = store.activeSignatures();
    expect(sigs.has('sha256:x')).toBe(true);
  });
});

describe('TUNER_AUDIT_PATH override', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `tuner-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    delete process.env['TUNER_AUDIT_PATH'];
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test('auditLog writes to TUNER_AUDIT_PATH when set, leaving production audit untouched', async () => {
    const customPath = join(tmp, 'test-audit.jsonl');
    process.env['TUNER_AUDIT_PATH'] = customPath;
    const { auditLog, getAuditPath } = await import('../../src/core/security.js');
    expect(getAuditPath()).toBe(customPath);
    auditLog('test_event', { foo: 'bar' });
    expect(existsSync(customPath)).toBe(true);
  });
});
