import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { Engine } from '../../src/core/engine.js';
import { Registry } from '../../src/core/registry.js';
import { ProposalsStore } from '../../src/storage/proposals.js';
import { RefusedStore } from '../../src/storage/refused.js';
import { BranchManager } from '../../src/git_ops/branches.js';
import { TunableSubject } from '../../src/core/interfaces.js';
import type { TunerConfig } from '../../src/core/config.js';
import type { Cluster, Observation, Patch, Proposal, ValidationResult } from '../../src/core/types.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<TunerConfig['storage']> = {}): TunerConfig {
  return {
    models: {
      intent_classifier: 'claude-haiku-4-5-20251001',
      detector: 'claude-haiku-4-5-20251001',
      proposer_default: 'claude-haiku-4-5-20251001',
      proposer_high_stakes: 'claude-sonnet-4-6',
      judge: 'claude-haiku-4-5-20251001',
    },
    detection: { confidence_floor: 0.6, max_proposals_per_run: 5, improvement_keywords_extra: [] },
    proposer: { alternatives_count: 2, language_preference: 'en' },
    ui: { primary_adapter: 'cli', follow_up_survey: false, follow_up_after_seconds: 3600 },
    storage: {
      proposals_jsonl: '/tmp/test-int-p.jsonl',
      refused_jsonl: '/tmp/test-int-r.jsonl',
      schema_version: 1,
      backup_keep: 7,
      git_repo: undefined,
      ...overrides,
    },
    llm: { backend: 'claude_cli', api_key: undefined },
    subjects: {},
  } as TunerConfig;
}

async function initGitRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# Skills Repo');
  await git.add('.');
  await git.commit('initial');
}

function makeCluster(overrides: Partial<Cluster> = {}): Cluster {
  return {
    id: 'cluster-e2e',
    subject: 'skills',
    observations: [],
    frequency: 3,
    success_rate: 0.8,
    sentiment: 'negative',
    subjects_touched: [],
    ...overrides,
  };
}

// ── Mock LLM-driven subject ────────────────────────────────────────────────────────────

class MockSkillSubject extends TunableSubject {
  readonly name: string;
  private clusters: Cluster[];
  private proposalTemplate: Omit<Proposal, 'id' | 'signature'>;

  constructor(opts: {
    name?: string;
    gitDir: string;
    clusters?: Cluster[];
    patternSig?: string;
  }) {
    super();
    this.name = opts.name ?? 'skills';
    this.clusters = opts.clusters ?? [makeCluster()];
    this.proposalTemplate = {
      cluster_id: 'cluster-e2e',
      subject: this.name,
      kind: 'patch',
      target_path: join(opts.gitDir, 'skills', 'test-skill.md'),
      alternatives: [
        { id: 'A', label: 'Add examples section', diff_or_content: '# Test Skill\n\nExamples:\n- foo\n', tradeoff: 'minor' },
        { id: 'B', label: 'Tighten description', diff_or_content: '# Test Skill\n\nTighter desc.\n', tradeoff: 'style' },
      ],
      pattern_signature: opts.patternSig ?? 'e2e-sig-' + Math.random().toString(36).slice(2, 8),
      created_at: new Date(),
    };
  }

  async collectObservations(_since: Date): Promise<Observation[]> {
    return [];
  }

  async detectProblems(_obs: Observation[]): Promise<Cluster[]> {
    return this.clusters;
  }

  async proposeChange(_cluster: Cluster): Promise<Proposal> {
    return { ...this.proposalTemplate, id: 0 } as Proposal;
  }

  async apply(_proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = _proposal.alternatives.find(a => a.id === alternativeId);
    return {
      target_path: _proposal.target_path,
      kind: 'patch',
      applied_content: alt?.diff_or_content ?? '# patched',
    };
  }

  async validate(_patch: Patch): Promise<ValidationResult> {
    return { valid: true };
  }
}

// ── Full workflow integration test ─────────────────────────────────────────────────────

describe('e2e: full proposal workflow', () => {
  let tmpDir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;
  let engine: Engine;
  let subject: MockSkillSubject;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tuner-e2e-'));
    gitDir = mkdtempSync(join(tmpdir(), 'tuner-e2e-git-'));
    await initGitRepo(gitDir);
    mkdirSync(join(gitDir, 'skills'), { recursive: true });
    writeFileSync(join(gitDir, 'skills', 'test-skill.md'), '# Test Skill\n');
    const git = simpleGit(gitDir);
    await git.add('.');
    await git.commit('add test skill');

    proposals = new ProposalsStore(join(tmpDir, 'proposals.jsonl'));
    refused = new RefusedStore(join(tmpDir, 'refused.jsonl'));
    branches = new BranchManager(gitDir);
    registry = new Registry();
    subject = new MockSkillSubject({ gitDir });
    registry.registerSubject(subject);
    engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as any).secret = Buffer.alloc(32);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    rmSync(gitDir, { recursive: true });
  });

  test('detect → propose → apply creates git branch and records', async () => {
    // Step 1: run cycle, expect 1 proposal created
    const { proposed } = await engine.runCycle();
    expect(proposed).toBe(1);

    const records = proposals.readAll();
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('created');
    const proposal = records[0]!.proposal;
    expect(proposal.subject).toBe('skills');
    expect(proposal.alternatives).toHaveLength(2);

    // Step 2: apply the first alternative
    await engine.applyProposal(proposal.id, 'A');

    const allRecords = proposals.readAll();
    const appliedRec = allRecords.find(r => r.event === 'applied');
    expect(appliedRec).toBeDefined();
    expect(appliedRec!.alternative_id).toBe('A');
    expect(appliedRec!.commit_sha).toBeDefined();
    expect(typeof appliedRec!.commit_sha).toBe('string');

    // Step 3: verify git branch was created
    const git = simpleGit(gitDir);
    const localBranches = await git.branchLocal();
    const branchName = `tune/proposal-${proposal.id}`;
    expect(localBranches.all).toContain(branchName);
  });
});

// ── Orphan detection (new_entity pattern) ─────────────────────────────────────────────

describe('e2e: orphan proposal (new entity)', () => {
  let tmpDir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;
  let engine: Engine;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tuner-e2e-orphan-'));
    gitDir = mkdtempSync(join(tmpdir(), 'tuner-e2e-orphan-git-'));
    await initGitRepo(gitDir);

    proposals = new ProposalsStore(join(tmpDir, 'proposals.jsonl'));
    refused = new RefusedStore(join(tmpDir, 'refused.jsonl'));
    branches = new BranchManager(gitDir);
    registry = new Registry();

    class OrphanSubject extends TunableSubject {
      readonly name = 'skills';
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> {
        return [{
          id: 'orphan-cluster',
          subject: '__new_entity__',
          observations: [],
          frequency: 5,
          success_rate: 0.0,
          sentiment: 'negative',
          subjects_touched: ['skills'],
        }];
      }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        return {
          id: 0,
          cluster_id: 'orphan-cluster',
          subject: '__new_entity__',
          kind: 'new_skill',
          target_path: join(gitDir, 'new-skill.md'),
          alternatives: [{ id: 'A', label: 'Create new skill', diff_or_content: '# New Skill\n', tradeoff: '' }],
          pattern_signature: 'orphan-sig-abc',
          created_at: new Date(),
        } as Proposal;
      }
      async apply(_proposal: Proposal, _alt: string): Promise<Patch> {
        return { target_path: join(gitDir, 'new-skill.md'), kind: 'new_skill', applied_content: '# New Skill\n' };
      }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
    }

    registry.registerSubject(new OrphanSubject());
    engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as any).secret = Buffer.alloc(32);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    rmSync(gitDir, { recursive: true });
  });

  test('orphan cluster generates new_skill proposal', async () => {
    const { proposed } = await engine.runCycle();
    expect(proposed).toBe(1);
    const record = proposals.readAll()[0]!;
    expect(record.proposal.kind).toBe('new_skill');
    expect(record.proposal.subject).toBe('__new_entity__');
  });
});

// ── Refuse + dedup ─────────────────────────────────────────────────────────────────────

describe('e2e: refuse and deduplication', () => {
  let tmpDir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;
  let engine: Engine;
  const fixedSig = 'e2e-fixed-sig-42';

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tuner-e2e-refuse-'));
    gitDir = mkdtempSync(join(tmpdir(), 'tuner-e2e-refuse-git-'));
    await initGitRepo(gitDir);

    proposals = new ProposalsStore(join(tmpDir, 'proposals.jsonl'));
    refused = new RefusedStore(join(tmpDir, 'refused.jsonl'));
    branches = new BranchManager(gitDir);
    registry = new Registry();

    class FixedSigSubject extends TunableSubject {
      readonly name = 'skills';
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return [makeCluster()]; }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        return {
          id: 0,
          cluster_id: 'cluster-e2e',
          subject: 'skills',
          kind: 'patch',
          target_path: join(gitDir, 'skill.md'),
          alternatives: [{ id: 'A', label: 'fix', diff_or_content: '# fixed', tradeoff: '' }],
          pattern_signature: fixedSig,
          created_at: new Date(),
        } as Proposal;
      }
      async apply(_p: Proposal, _a: string): Promise<Patch> {
        return { target_path: join(gitDir, 'skill.md'), kind: 'patch', applied_content: '# fixed' };
      }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
    }

    registry.registerSubject(new FixedSigSubject());
    engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as any).secret = Buffer.alloc(32);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    rmSync(gitDir, { recursive: true });
  });

  test('refused signature is not re-proposed', async () => {
    // First run creates the proposal
    const r1 = await engine.runCycle();
    expect(r1.proposed).toBe(1);
    const record = proposals.readAll()[0]!;

    // Refuse it
    await engine.refuseProposal(record.proposal.id);
    expect(refused.isRefused(fixedSig)).toBe(true);

    // Second run should skip it
    const r2 = await engine.runCycle();
    expect(r2.proposed).toBe(0);
  });

  test('pending signature is deduplicated on second run', async () => {
    const r1 = await engine.runCycle();
    expect(r1.proposed).toBe(1);

    // Do NOT resolve — proposal is still pending
    const r2 = await engine.runCycle();
    expect(r2.proposed).toBe(0);
  });
});

// ── ProposalsStore stats ───────────────────────────────────────────────────────────────

describe('e2e: proposals store statistics', () => {
  let tmpDir: string;
  let store: ProposalsStore;

  function makeProposal(id: number, sig: string): Proposal {
    return {
      id,
      cluster_id: 'c',
      subject: 'skills',
      kind: 'patch',
      target_path: '/tmp/x.md',
      alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }],
      pattern_signature: sig,
      created_at: new Date(),
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tuner-e2e-stats-'));
    store = new ProposalsStore(join(tmpDir, 'proposals.jsonl'));
  });

  afterEach(() => rmSync(tmpDir, { recursive: true }));

  test('readAll returns all events in order', () => {
    const p1 = makeProposal(1, 'sig-1');
    const p2 = makeProposal(2, 'sig-2');
    store.append({ proposal: p1, event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: p2, event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: p1, event: 'applied', ts: new Date().toISOString(), alternative_id: 'A' });
    store.append({ proposal: p2, event: 'refused', ts: new Date().toISOString() });

    const all = store.readAll();
    expect(all).toHaveLength(4);

    const counts = { created: 0, applied: 0, refused: 0 };
    for (const r of all) {
      counts[r.event as keyof typeof counts]++;
    }
    expect(counts.created).toBe(2);
    expect(counts.applied).toBe(1);
    expect(counts.refused).toBe(1);
  });

  test('pendingSignatures excludes applied and refused', () => {
    const p1 = makeProposal(1, 'sig-pending');
    const p2 = makeProposal(2, 'sig-applied');
    const p3 = makeProposal(3, 'sig-refused');
    store.append({ proposal: p1, event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: p2, event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: p3, event: 'created', ts: new Date().toISOString() });
    store.append({ proposal: p2, event: 'applied', ts: new Date().toISOString(), alternative_id: 'A' });
    store.append({ proposal: p3, event: 'refused', ts: new Date().toISOString() });

    const pending = store.pendingSignatures({});
    expect(pending.has('sig-pending')).toBe(true);
    expect(pending.has('sig-applied')).toBe(false);
    expect(pending.has('sig-refused')).toBe(false);
  });
});
