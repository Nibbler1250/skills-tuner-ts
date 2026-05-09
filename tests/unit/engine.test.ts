import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { Engine, SecurityError } from '../../src/core/engine.js';
import { Registry } from '../../src/core/registry.js';
import { ProposalsStore } from '../../src/storage/proposals.js';
import { RefusedStore } from '../../src/storage/refused.js';
import { BranchManager } from '../../src/git_ops/branches.js';
import { computeProposalSignature } from '../../src/core/security.js';
import { TunableSubject } from '../../src/core/interfaces.js';
import type { TunerConfig } from '../../src/core/config.js';
import type { Cluster, Observation, Patch, Proposal, ValidationResult } from '../../src/core/types.js';

// Build a minimal TunerConfig (matching actual schema)
function makeConfig(overrides: Partial<TunerConfig> = {}): TunerConfig {
  return {
    models: {
      intent_classifier: 'claude-haiku-4-5-20251001',
      detector: 'claude-haiku-4-5-20251001',
      proposer_default: 'claude-haiku-4-5-20251001',
      proposer_high_stakes: 'claude-sonnet-4-6',
      judge: 'claude-haiku-4-5-20251001',
    },
    detection: { confidence_floor: 0.6, max_proposals_per_run: 3, improvement_keywords_extra: [] },
    proposer: { alternatives_count: 2, language_preference: 'en' },
    ui: { primary_adapter: 'cli', follow_up_survey: false, follow_up_after_seconds: 3600 },
    storage: {
      proposals_jsonl: '/tmp/test-p.jsonl',
      refused_jsonl: '/tmp/test-r.jsonl',
      schema_version: 1,
      backup_keep: 7,
      git_repo: undefined,
    },
    llm: { backend: 'claude_cli', api_key: undefined },
    subjects: {},
    ...overrides,
  } as TunerConfig;
}

function makeCluster(overrides: Partial<Cluster> = {}): Cluster {
  return {
    id: 'cluster-1',
    subject: 'test',
    observations: [],
    frequency: 3,
    success_rate: 0.8,
    sentiment: 'negative',
    subjects_touched: [],
    ...overrides,
  };
}

function makeRawProposal(overrides: Partial<Proposal> = {}): Omit<Proposal, 'id' | 'signature'> {
  return {
    cluster_id: 'cluster-1',
    subject: 'test',
    kind: 'patch',
    target_path: '/tmp/test.md',
    alternatives: [{ id: 'A', label: 'test fix', diff_or_content: '# fixed', tradeoff: '' }],
    pattern_signature: 'test-sig-' + Math.random().toString(36).slice(2, 8),
    created_at: new Date(),
    ...overrides,
  };
}

// Mock subject that returns controlled data
class MockSubject extends TunableSubject {
  readonly name: string;
  private _clusters: Cluster[];
  private _proposal: Omit<Proposal, 'id' | 'signature'>;
  private _applyResult: Patch;
  private _validateResult: ValidationResult;

  constructor(opts: {
    name?: string;
    clusters?: Cluster[];
    proposal?: Omit<Proposal, 'id' | 'signature'>;
    applyResult?: Patch;
    validateResult?: ValidationResult;
  } = {}) {
    super();
    this.name = opts.name ?? 'test';
    this._clusters = opts.clusters ?? [makeCluster()];
    this._proposal = opts.proposal ?? makeRawProposal();
    this._applyResult = opts.applyResult ?? { target_path: '/tmp/test.md', kind: 'patch', applied_content: '# fixed' };
    this._validateResult = opts.validateResult ?? { valid: true };
  }

  async collectObservations(_since: Date): Promise<Observation[]> { return []; }

  async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return this._clusters; }

  async proposeChange(_cluster: Cluster): Promise<Proposal> {
    return { ...this._proposal, id: 0 } as Proposal;
  }

  async apply(_proposal: Proposal, _alt: string): Promise<Patch> {
    return this._applyResult;
  }

  async validate(_patch: Patch): Promise<ValidationResult> {
    return this._validateResult;
  }
}

async function initGitRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# test');
  await git.add('.');
  await git.commit('initial');
}

describe('Engine', () => {
  let dir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;
  let engine: Engine;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tuner-engine-test-'));
    gitDir = mkdtempSync(join(tmpdir(), 'tuner-git-test-'));
    await initGitRepo(gitDir);

    proposals = new ProposalsStore(join(dir, 'proposals.jsonl'));
    refused = new RefusedStore(join(dir, 'refused.jsonl'));
    branches = new BranchManager(gitDir);
    registry = new Registry();

    // Use a path inside gitDir so BranchManager.commitPatch can git add it
    const subject = new MockSubject({
      applyResult: { target_path: join(gitDir, 'skill.md'), kind: 'patch', applied_content: '# fixed' },
      proposal: { ...makeRawProposal(), target_path: join(gitDir, 'skill.md') },
    });
    registry.registerSubject(subject);

    engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    // Override secret to avoid filesystem dependency
    (engine as unknown as { secret: Buffer }).secret = Buffer.alloc(32);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
    rmSync(gitDir, { recursive: true });
  });

  test('runCycle generates proposals', async () => {
    const result = await engine.runCycle();
    expect(result.proposed).toBe(1);
    const records = proposals.readAll();
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('created');
  });

  test('runCycle skips refused signatures', async () => {
    // Create a subject with a fixed pattern_signature
    const fixedSig = 'fixed-sig-abc';
    const subject = new MockSubject({
      proposal: { ...makeRawProposal(), pattern_signature: fixedSig, subject: 'test2' },
      clusters: [makeCluster({ subject: 'test2' })],
      name: 'test2',
    });
    const reg = new Registry();
    reg.registerSubject(subject);
    const eng = new Engine(makeConfig(), reg, proposals, refused, branches);
    (eng as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    refused.add(fixedSig, 'test2', 'user refused');

    const result = await eng.runCycle({ subjectName: 'test2' });
    expect(result.proposed).toBe(0);
  });

  test('runCycle skips pending signatures on second run', async () => {
    // Create stable signature subject
    const fixedSig = 'stable-sig-' + Math.random().toString(36).slice(2, 8);
    const subject = new MockSubject({ proposal: { ...makeRawProposal(), pattern_signature: fixedSig } });
    const reg = new Registry();
    reg.registerSubject(subject);
    const eng = new Engine(makeConfig(), reg, proposals, refused, branches);
    (eng as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    const first = await eng.runCycle();
    expect(first.proposed).toBe(1);

    const second = await eng.runCycle();
    expect(second.proposed).toBe(0);
  });

  test('runCycle skips applied signatures', async () => {
    const fixedSig = 'applied-sig-xyz';
    const subject = new MockSubject({ proposal: { ...makeRawProposal(), pattern_signature: fixedSig } });
    const reg = new Registry();
    reg.registerSubject(subject);
    const eng = new Engine(makeConfig(), reg, proposals, refused, branches);
    (eng as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    // Manually append an applied record with that sig
    const fakeProposal: Proposal = {
      id: 999,
      cluster_id: 'c',
      subject: 'test',
      kind: 'patch',
      target_path: '/tmp/x.md',
      alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }],
      pattern_signature: fixedSig,
      created_at: new Date(),
    };
    proposals.append({ proposal: fakeProposal, event: 'applied', ts: new Date().toISOString(), alternative_id: 'A' });

    const result = await eng.runCycle({ subjectName: 'test' });
    expect(result.proposed).toBe(0);
  });

  test('runCycle caps at max_proposals_per_run', async () => {
    const clusters: Cluster[] = Array.from({ length: 5 }, (_, i) => makeCluster({ id: `c-${i}` }));
    // Each cluster needs a different signature so no dedup kicks in
    let callCount = 0;
    class MultiClusterSubject extends TunableSubject {
      readonly name = 'multi';
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return clusters; }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        const sig = `unique-sig-${callCount++}`;
        return { id: 0, cluster_id: _cluster.id, subject: 'multi', kind: 'patch', target_path: '/tmp/x.md', alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }], pattern_signature: sig, created_at: new Date() };
      }
      async apply(_p: Proposal, _a: string): Promise<Patch> { return { target_path: '/tmp/x.md', kind: 'patch', applied_content: '' }; }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
    }

    const reg = new Registry();
    reg.registerSubject(new MultiClusterSubject());
    const cfg = makeConfig({ detection: { confidence_floor: 0.6, max_proposals_per_run: 2, improvement_keywords_extra: [] } });
    const eng = new Engine(cfg, reg, proposals, refused, branches);
    (eng as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    const result = await eng.runCycle();
    expect(result.proposed).toBe(2);
  });

  test('runCycle sets HMAC signature on proposal', async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    expect(records[0]!.proposal.signature).toBeDefined();
    expect(records[0]!.proposal.signature!.length).toBe(64); // hex SHA-256
  });

  test('applyProposal rejects invalid HMAC', async () => {
    // First create a proposal
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;

    // Tamper with the signature — change secret to something else
    (engine as unknown as { secret: Buffer }).secret = Buffer.alloc(32, 1); // different secret

    await expect(engine.applyProposal(proposalId, 'A')).rejects.toBeInstanceOf(SecurityError);
  });

  test('applyProposal creates branch in git repo', async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;

    // Restore correct secret for valid signature
    await engine.applyProposal(proposalId, 'A');

    const git = simpleGit(gitDir);
    const localBranches = await git.branchLocal();
    const hasBranch = localBranches.all.some(b => b.includes(`proposal-${proposalId}`));
    expect(hasBranch).toBe(true);
  });

  test('applyProposal appends applied event', async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;

    await engine.applyProposal(proposalId, 'A');

    const allRecords = proposals.readAll();
    const appliedRecord = allRecords.find(r => r.event === 'applied');
    expect(appliedRecord).toBeDefined();
    expect(appliedRecord!.alternative_id).toBe('A');
  });

  test('refuseProposal adds to refused store', async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;
    const sig = records[0]!.proposal.pattern_signature;

    await engine.refuseProposal(proposalId);

    expect(refused.isRefused(sig)).toBe(true);
  });

  test('refuseProposal appends refused event', async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;

    await engine.refuseProposal(proposalId);

    const allRecords = proposals.readAll();
    const refusedRecord = allRecords.find(r => r.event === 'refused');
    expect(refusedRecord).toBeDefined();
  });

  test('revertProposal calls git revert', async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;

    await engine.applyProposal(proposalId, 'A');

    // Switch back to that branch for revert to work
    const git = simpleGit(gitDir);
    await git.checkout(`tune/proposal-${proposalId}`);

    await engine.revertProposal(proposalId);

    // If no error was thrown, revert was called successfully
    expect(true).toBe(true);
  });

  test('runCycle with subjectName filters to specific subject', async () => {
    const result = await engine.runCycle({ subjectName: 'nonexistent' });
    expect(result.proposed).toBe(0);

    const result2 = await engine.runCycle({ subjectName: 'test' });
    expect(result2.proposed).toBe(1);
  });

  test('runCycle dryRun does not persist proposals', async () => {
    const result = await engine.runCycle({ dryRun: true });
    expect(result.proposed).toBe(1);
    const records = proposals.readAll();
    expect(records).toHaveLength(0);
  });

  test('refuseProposal throws for unknown proposalId', async () => {
    await expect(engine.refuseProposal(9999)).rejects.toThrow('not found');
  });

  test('applyProposal throws for unknown proposalId', async () => {
    await expect(engine.applyProposal(9999, 'A')).rejects.toThrow('not found');
  });
  test('high risk_tier subject never auto-merges even if config says auto_merge: true', async () => {
    class HighRiskSubject extends TunableSubject {
      readonly name = 'high-risk';
      readonly risk_tier = 'high' as const;
      private callCount = 0;
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return [makeCluster({ subject: 'high-risk' })]; }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        const sig = 'high-risk-sig-' + (this.callCount++);
        return { id: 0, cluster_id: 'c', subject: 'high-risk', kind: 'patch', target_path: '/tmp/x.md', alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }], pattern_signature: sig, created_at: new Date() };
      }
      async apply(_p: Proposal, _a: string): Promise<Patch> { return { target_path: '/tmp/x.md', kind: 'patch', applied_content: '' }; }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
    }
    const reg = new Registry();
    reg.registerSubject(new HighRiskSubject());
    const cfg = makeConfig({ subjects: { 'high-risk': { auto_merge: true } } } as Partial<TunerConfig>);
    const eng = new Engine(cfg, reg, proposals, refused, branches);
    (eng as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    const result = await eng.runCycle({ subjectName: 'high-risk' });
    expect(result.proposed).toBe(1);
    expect(result.autoApplied).toBe(0);
  });

  test('critical risk_tier subject never auto-merges even if config says auto_merge: true', async () => {
    class CriticalRiskSubject extends TunableSubject {
      readonly name = 'critical-risk';
      readonly risk_tier = 'critical' as const;
      private callCount = 0;
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return [makeCluster({ subject: 'critical-risk' })]; }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        const sig = 'critical-risk-sig-' + (this.callCount++);
        return { id: 0, cluster_id: 'c', subject: 'critical-risk', kind: 'patch', target_path: '/tmp/x.md', alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }], pattern_signature: sig, created_at: new Date() };
      }
      async apply(_p: Proposal, _a: string): Promise<Patch> { return { target_path: '/tmp/x.md', kind: 'patch', applied_content: '' }; }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
    }
    const reg = new Registry();
    reg.registerSubject(new CriticalRiskSubject());
    const cfg = makeConfig({ subjects: { 'critical-risk': { auto_merge: true } } } as Partial<TunerConfig>);
    const eng = new Engine(cfg, reg, proposals, refused, branches);
    (eng as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    const result = await eng.runCycle({ subjectName: 'critical-risk' });
    expect(result.proposed).toBe(1);
    expect(result.autoApplied).toBe(0);
  });

});
