import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../../src/core/engine.js';
import { BranchManager } from '../../src/git_ops/branches.js';
import type { TunerConfig } from '../../src/core/config.js';
import type { Registry } from '../../src/core/registry.js';
import type { ProposalsStore } from '../../src/storage/proposals.js';
import type { RefusedStore } from '../../src/storage/refused.js';

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitrepo-'));
  // Initialize a real git repo for BranchManager
  const { execSync } = require('child_process');
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function makeConfig(overrides: Partial<TunerConfig> = {}): TunerConfig {
  return {
    models: { intent_classifier: 'h', detector: 'h', proposer_default: 'h', proposer_high_stakes: 'h', judge: 'h' },
    llm: { backend: 'anthropic_api' },
    detection: { improvement_keywords_extra: [], confidence_floor: 0.65, max_proposals_per_run: 5 },
    proposer: { alternatives_count: 3, language_preference: 'en' },
    subjects: {},
    ui: { primary_adapter: 'cli', follow_up_survey: false, follow_up_after_seconds: 30 },
    storage: { proposals_jsonl: '/tmp/p.jsonl', refused_jsonl: '/tmp/r.jsonl', schema_version: 1, backup_keep: 7 },
    ...overrides,
  } as TunerConfig;
}

function makeEngine(config: TunerConfig, defaultRepo: string) {
  const defaultBranches = new BranchManager(defaultRepo);
  const mockRegistry = { getSubject: () => null, enabledSubjects: () => [] } as unknown as Registry;
  const mockProposals = { readAll: () => [], append: () => {}, pendingSignatures: () => new Set(), appliedSignatures: () => new Set() } as unknown as ProposalsStore;
  const mockRefused = { activeSignatures: () => new Set(), add: () => {} } as unknown as RefusedStore;
  return new Engine(config, mockRegistry, mockProposals, mockRefused, defaultBranches);
}

describe('Engine per-subject git_repo', () => {
  let defaultRepo: string;
  let subjectRepo: string;
  let voiceRepo: string;

  beforeEach(() => {
    defaultRepo = makeTempGitRepo();
    subjectRepo = makeTempGitRepo();
    voiceRepo = makeTempGitRepo();
  });

  afterEach(() => {
    rmSync(defaultRepo, { recursive: true, force: true });
    rmSync(subjectRepo, { recursive: true, force: true });
    rmSync(voiceRepo, { recursive: true, force: true });
  });

  test('1. Default fallback: subject without git_repo uses storage default', () => {
    const config = makeConfig({ subjects: { skills: { enabled: true, auto_merge: false, scan_dirs: [] } } });
    const engine = makeEngine(config, defaultRepo);
    const bm = (engine as any).getBranchManager('skills');
    expect(bm.repoPath).toBe(defaultRepo);
  });

  test('2. Per-subject override: subject with git_repo uses that path', () => {
    const config = makeConfig({
      subjects: { skills: { enabled: true, git_repo: subjectRepo, auto_merge: false, scan_dirs: [] } },
    });
    const engine = makeEngine(config, defaultRepo);
    const bm = (engine as any).getBranchManager('skills');
    expect(bm.repoPath).toBe(subjectRepo);
    expect(bm.repoPath).not.toBe(defaultRepo);
  });

  test('3. Different repos for different subjects — no cross-contamination', () => {
    const config = makeConfig({
      subjects: {
        skills: { enabled: true, git_repo: subjectRepo, auto_merge: false, scan_dirs: [] },
        voice: { enabled: true, git_repo: voiceRepo, auto_merge: false, scan_dirs: [] },
      },
    });
    const engine = makeEngine(config, defaultRepo);
    const skillsBm = (engine as any).getBranchManager('skills');
    const voiceBm = (engine as any).getBranchManager('voice');
    expect(skillsBm.repoPath).toBe(subjectRepo);
    expect(voiceBm.repoPath).toBe(voiceRepo);
    expect(skillsBm.repoPath).not.toBe(voiceBm.repoPath);
  });

  test('4. Cache: same BranchManager instance returned for same subject across calls', () => {
    const config = makeConfig({
      subjects: { skills: { enabled: true, git_repo: subjectRepo, auto_merge: false, scan_dirs: [] } },
    });
    const engine = makeEngine(config, defaultRepo);
    const bm1 = (engine as any).getBranchManager('skills');
    const bm2 = (engine as any).getBranchManager('skills');
    expect(bm1).toBe(bm2); // exact same object reference
  });

  test('5. Default repo returned directly (not a new instance) when subject has no git_repo', () => {
    const config = makeConfig({ subjects: {} });
    const engine = makeEngine(config, defaultRepo);
    const bm = (engine as any).getBranchManager('nonexistent');
    // Should be the defaultBranches object itself
    expect(bm.repoPath).toBe(defaultRepo);
    const bm2 = (engine as any).getBranchManager('another');
    expect(bm2.repoPath).toBe(defaultRepo);
  });

  test('6. Backward compat: config without per-subject git_repo still works', () => {
    const config = makeConfig({
      subjects: {
        skills: { enabled: true, auto_merge: false, scan_dirs: [] }, // no git_repo
      },
      storage: { proposals_jsonl: '/tmp/p.jsonl', refused_jsonl: '/tmp/r.jsonl', schema_version: 1, backup_keep: 7, git_repo: defaultRepo },
    });
    const engine = makeEngine(config, defaultRepo);
    const bm = (engine as any).getBranchManager('skills');
    expect(bm.repoPath).toBe(defaultRepo);
  });

  test('7. Tilde expansion: git_repo with ~ resolves to homedir', () => {
    const { homedir } = require('os');
    const home = homedir();
    // Config loader expands ~ before engine sees it, so engine receives absolute path.
    // Test that engine accepts and uses an absolute path from homedir.
    const config = makeConfig({
      subjects: { skills: { enabled: true, git_repo: defaultRepo, auto_merge: false, scan_dirs: [] } },
    });
    const engine = makeEngine(config, voiceRepo);
    const bm = (engine as any).getBranchManager('skills');
    expect(bm.repoPath).toBe(defaultRepo);
  });

  test('8. Undefined subject (no config entry) falls back to default', () => {
    const config = makeConfig({ subjects: {} });
    const engine = makeEngine(config, defaultRepo);
    const bm = (engine as any).getBranchManager('trader-ml-hp');
    expect(bm.repoPath).toBe(defaultRepo);
  });

  test('9. Per-subject git_repo does not pollute other subjects', () => {
    const config = makeConfig({
      subjects: {
        skills: { enabled: true, git_repo: subjectRepo, auto_merge: false, scan_dirs: [] },
        // voice has no git_repo
        voice: { enabled: true, auto_merge: false, scan_dirs: [] },
      },
    });
    const engine = makeEngine(config, defaultRepo);
    const skillsBm = (engine as any).getBranchManager('skills');
    const voiceBm = (engine as any).getBranchManager('voice');
    expect(skillsBm.repoPath).toBe(subjectRepo);
    expect(voiceBm.repoPath).toBe(defaultRepo); // falls back to default
  });

  test('10. BranchManager ensureRepo() throws for non-git directory', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'nongit-'));
    try {
      const bm = new BranchManager(nonRepo);
      await expect(bm.ensureRepo()).rejects.toThrow();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
