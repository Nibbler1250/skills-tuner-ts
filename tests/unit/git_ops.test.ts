import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { BranchManager } from '../../src/git_ops/branches.js';
import type { Patch, Proposal } from '../../src/core/types.js';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1, cluster_id: 'c1', subject: 'skills', kind: 'patch',
    target_path: '',
    alternatives: [{ id: 'A', label: 'test', diff_or_content: 'foo', tradeoff: '' }],
    pattern_signature: 'sig-abc',
    created_at: new Date('2026-05-09T00:00:00Z'),
    ...overrides,
  };
}

describe('BranchManager', () => {
  let dir: string;
  let mgr: BranchManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tuner-git-'));
    const git = simpleGit(dir);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@test.com');
    writeFileSync(join(dir, 'README.md'), '# test');
    await git.add('.');
    await git.commit('init');
    mgr = new BranchManager(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true }));

  test('ensureRepo does not throw for valid repo', async () => {
    await expect(mgr.ensureRepo()).resolves.toBeUndefined();
  });

  test('createProposalBranch creates and returns branch name', async () => {
    const name = await mgr.createProposalBranch(42);
    expect(name).toBe('tune/proposal-42');
  });

  test('createProposalBranch is idempotent', async () => {
    await mgr.createProposalBranch(42);
    const name = await mgr.createProposalBranch(42);
    expect(name).toBe('tune/proposal-42');
  });

  test('listProposalBranches returns tune/proposal-* branches', async () => {
    await mgr.createProposalBranch(1);
    await mgr.createProposalBranch(2);
    const branches = await mgr.listProposalBranches();
    expect(branches).toContain('tune/proposal-1');
    expect(branches).toContain('tune/proposal-2');
    expect(branches.every((b: string) => b.startsWith('tune/proposal-'))).toBe(true);
  });

  test('commitPatch creates a commit and returns sha', async () => {
    await mgr.createProposalBranch(1);
    const proposal = makeProposal({ target_path: join(dir, 'skill.md') });
    const patch: Patch = { target_path: join(dir, 'skill.md'), kind: 'patch', applied_content: '# skill' };
    const sha = await mgr.commitPatch(patch, proposal, 'A');
    expect(typeof sha).toBe('string');
    expect(sha.length).toBeGreaterThan(0);
  });
  test('commitPatch throws on target outside repoPath', async () => {
    await mgr.createProposalBranch(99);
    const proposal = makeProposal({ target_path: '/etc/passwd' });
    const patch = { target_path: '/etc/passwd', kind: 'patch', applied_content: 'evil' };
    await expect(mgr.commitPatch(patch, proposal, 'A')).rejects.toThrow('refusing to write outside repo');
  });

  test('revertPatch throws on bad SHA', async () => {
    // Should throw (not silently create empty commit)
    await expect(mgr.revertPatch('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow();
  });

});
