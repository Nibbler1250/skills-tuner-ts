import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { Engine } from '../../src/core/engine.js';
import { BranchManager } from '../../src/git_ops/branches.js';
import { SkillsSubject } from '../../src/subjects/skills.js';
import type { TunerConfig } from '../../src/core/config.js';
import type { Registry } from '../../src/core/registry.js';
import type { ProposalsStore } from '../../src/storage/proposals.js';
import type { RefusedStore } from '../../src/storage/refused.js';
import { TunableSubject } from '../../src/core/interfaces.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../../src/core/types.js';

// A minimal subject with no-op currentStateHash (default)
class NoHashSubject extends TunableSubject {
  readonly name = 'no-hash';
  async collectObservations() { return []; }
  async detectProblems() { return []; }
  async proposeChange(c: Cluster): Promise<UnsignedProposal> { throw new Error('unused'); }
  async apply(p: Proposal, a: string): Promise<Patch> { throw new Error('unused'); }
  async validate(p: Patch): Promise<ValidationResult> { return { valid: true }; }
}

// A subject with a controllable hash
class ControllableHashSubject extends TunableSubject {
  readonly name = 'controllable';
  public hash = 'initial-hash';
  async collectObservations() { return []; }
  async detectProblems() { return []; }
  async proposeChange(c: Cluster): Promise<UnsignedProposal> { throw new Error('unused'); }
  async apply(p: Proposal, a: string): Promise<Patch> { throw new Error('unused'); }
  async validate(p: Patch): Promise<ValidationResult> { return { valid: true }; }
  currentStateHash() { return this.hash; }
}

// A subject whose currentStateHash throws
class ThrowingHashSubject extends TunableSubject {
  readonly name = 'throwing';
  async collectObservations() { return []; }
  async detectProblems() { return []; }
  async proposeChange(c: Cluster): Promise<UnsignedProposal> { throw new Error('unused'); }
  async apply(p: Proposal, a: string): Promise<Patch> { throw new Error('unused'); }
  async validate(p: Patch): Promise<ValidationResult> { return { valid: true }; }
  currentStateHash(): string { throw new Error('hash computation failed'); }
}

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitrepo-'));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "T"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function makeConfig(): TunerConfig {
  return {
    models: { intent_classifier: 'h', detector: 'h', proposer_default: 'h', proposer_high_stakes: 'h', judge: 'h' },
    llm: { backend: 'anthropic_api' },
    detection: { improvement_keywords_extra: [], confidence_floor: 0.65, max_proposals_per_run: 5 },
    proposer: { alternatives_count: 3, language_preference: 'en' },
    subjects: {},
    ui: { primary_adapter: 'cli', follow_up_survey: false, follow_up_after_seconds: 30 },
    storage: { proposals_jsonl: '/tmp/p.jsonl', refused_jsonl: '/tmp/r.jsonl', schema_version: 1, backup_keep: 7 },
  } as TunerConfig;
}

function makeEngine(subjects: TunableSubject[], repoPath: string, stateHashesPath: string) {
  const branches = new BranchManager(repoPath);
  const mockRegistry = {
    getSubject: (n: string) => subjects.find(s => s.name === n) ?? null,
    enabledSubjects: () => subjects,
  } as unknown as Registry;
  const mockProposals = {
    readAll: () => [],
    append: () => {},
    pendingSignatures: () => new Set(),
    appliedSignatures: () => new Set(),
  } as unknown as ProposalsStore;
  const mockRefused = { activeSignatures: () => new Set(), add: () => {} } as unknown as RefusedStore;
  const engine = new Engine(makeConfig(), mockRegistry, mockProposals, mockRefused, branches);
  // Override state hashes path for test isolation
  (engine as any)._stateHashesPath = stateHashesPath;
  // Patch _lastStateHash and _recordStateHash to use test path
  engine['_lastStateHash'] = function(name: string): string {
    if (!existsSync(stateHashesPath)) return '';
    const lines = readFileSync(stateHashesPath, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const e = JSON.parse(lines[i]!); if (e.subject === name) return e.hash || ''; } catch {}
    }
    return '';
  };
  engine['_recordStateHash'] = function(name: string, hash: string): void {
    const { appendFileSync, mkdirSync } = require('node:fs');
    const { dirname } = require('node:path');
    mkdirSync(dirname(stateHashesPath), { recursive: true });
    appendFileSync(stateHashesPath, JSON.stringify({ ts: new Date().toISOString(), subject: name, hash }) + '\n');
  };
  return engine;
}

describe('Engine drift detection', () => {
  let repoDir: string;
  let stateHashesDir: string;
  let stateHashesPath: string;

  beforeEach(() => {
    repoDir = makeTempGitRepo();
    stateHashesDir = mkdtempSync(join(tmpdir(), 'state-hashes-'));
    stateHashesPath = join(stateHashesDir, 'state-hashes.jsonl');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateHashesDir, { recursive: true, force: true });
  });

  test('1. Default subject (no override) — currentStateHash returns empty string', () => {
    const s = new NoHashSubject();
    expect(s.currentStateHash()).toBe('');
  });

  test('2. Subject with empty hash — drift detection skipped (no state-hashes written)', async () => {
    const engine = makeEngine([new NoHashSubject()], repoDir, stateHashesPath);
    await engine.runCycle({ dryRun: true });
    expect(existsSync(stateHashesPath)).toBe(false);
  });

  test('3. First run — hash recorded, no prev hash (prev_hash=null in audit)', async () => {
    const subject = new ControllableHashSubject();
    const engine = makeEngine([subject], repoDir, stateHashesPath);
    await engine.runCycle({ dryRun: true });
    expect(existsSync(stateHashesPath)).toBe(true);
    const line = JSON.parse(readFileSync(stateHashesPath, 'utf8').trim());
    expect(line.subject).toBe('controllable');
    expect(line.hash).toBe('initial-hash');
  });

  test('4. No drift between runs — no new state-hashes line appended', async () => {
    const subject = new ControllableHashSubject();
    const engine = makeEngine([subject], repoDir, stateHashesPath);
    await engine.runCycle({ dryRun: true }); // first run
    const contentAfterFirst = readFileSync(stateHashesPath, 'utf8');
    await engine.runCycle({ dryRun: true }); // second run, same hash
    const contentAfterSecond = readFileSync(stateHashesPath, 'utf8');
    expect(contentAfterFirst).toBe(contentAfterSecond); // no new line
  });

  test('5. Drift detected — audit entry + new line in state-hashes', async () => {
    const subject = new ControllableHashSubject();
    const engine = makeEngine([subject], repoDir, stateHashesPath);
    await engine.runCycle({ dryRun: true }); // records 'initial-hash'
    subject.hash = 'changed-hash';
    await engine.runCycle({ dryRun: true }); // detects drift
    const lines = readFileSync(stateHashesPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    const second = JSON.parse(lines[1]!);
    expect(second.hash).toBe('changed-hash');
  });

  test('6. SkillsSubject hash stable across calls with same scan_dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-stable-'));
    try {
      writeFileSync(join(dir, 'my-skill.md'), '---\nname: my-skill\n---\n# My Skill\n');
      const subject = new SkillsSubject({ scanDirs: [dir] });
      const h1 = subject.currentStateHash();
      const h2 = subject.currentStateHash();
      expect(h1).toBe(h2);
      expect(h1.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('7. SkillsSubject hash changes after new .md file added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-change-'));
    try {
      writeFileSync(join(dir, 'skill-a.md'), '---\nname: a\n---\n# A\n');
      const subject = new SkillsSubject({ scanDirs: [dir] });
      const h1 = subject.currentStateHash();
      writeFileSync(join(dir, 'skill-b.md'), '---\nname: b\n---\n# B\n');
      const h2 = subject.currentStateHash();
      expect(h1).not.toBe(h2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('8. SkillsSubject hash changes after file mtime changes (touch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-mtime-'));
    try {
      const filePath = join(dir, 'skill.md');
      writeFileSync(filePath, '---\nname: skill\n---\n# Skill\n');
      const subject = new SkillsSubject({ scanDirs: [dir] });
      const h1 = subject.currentStateHash();
      // Wait briefly then rewrite file (updates mtime)
      await new Promise(r => setTimeout(r, 10));
      writeFileSync(filePath, '---\nname: skill\n---\n# Skill\n# extra line\n');
      const h2 = subject.currentStateHash();
      expect(h1).not.toBe(h2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('9. Throwing subject — runCycle continues, no crash', async () => {
    const throwing = new ThrowingHashSubject();
    const engine = makeEngine([throwing], repoDir, stateHashesPath);
    await expect(engine.runCycle({ dryRun: true })).resolves.toBeDefined();
    expect(existsSync(stateHashesPath)).toBe(false); // nothing written (hash errored)
  });

  test('10. State hashes survive engine restart', async () => {
    const subject = new ControllableHashSubject();
    const engine1 = makeEngine([subject], repoDir, stateHashesPath);
    await engine1.runCycle({ dryRun: true }); // records hash
    // Create new engine instance with same state-hashes file
    const engine2 = makeEngine([subject], repoDir, stateHashesPath);
    const prevHash = engine2['_lastStateHash']('controllable');
    expect(prevHash).toBe('initial-hash');
  });
});
