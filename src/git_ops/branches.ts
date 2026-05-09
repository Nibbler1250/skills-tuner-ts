import { simpleGit, type SimpleGit } from 'simple-git';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Patch, Proposal } from '../core/types.js';

export class BranchManager {
  private git: SimpleGit;

  constructor(public readonly repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  async ensureRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) throw new Error(`${this.repoPath} is not a git repository`);
  }

  branchName(proposalId: number): string {
    return `tune/proposal-${proposalId}`;
  }

  async createProposalBranch(proposalId: number): Promise<string> {
    const name = this.branchName(proposalId);
    const branches = await this.git.branchLocal();
    if (branches.all.includes(name)) {
      await this.git.checkout(name);
    } else {
      await this.git.checkoutLocalBranch(name);
    }
    return name;
  }

  async commitPatch(patch: Patch, proposal: Proposal, alternativeId: string): Promise<string> {
    const target = resolve(patch.target_path.replace(/^~/, homedir()));
    const repoRoot = resolve(this.repoPath);
    if (!target.startsWith(repoRoot + sep) && target !== repoRoot) {
      throw new Error(`BranchManager refusing to write outside repo: target=${target}, repo=${repoRoot}`);
    }
    if (patch.applied_content) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, patch.applied_content, 'utf8');
      await this.git.add(target);
    } else {
      await this.git.add('.');
    }
    const msg = `tune: ${proposal.subject} — alternative ${alternativeId}\nProposal-ID: ${proposal.id}`;
    const result = await this.git.commit(msg, { '--allow-empty': null });
    return result.commit;
  }

  async revertPatch(commitSha: string): Promise<void> {
    try {
      await this.git.revert(commitSha, ['--no-edit']);
    } catch {
      await this.git.commit(`Revert ${commitSha.slice(0, 8)}`, { '--allow-empty': null });
    }
  }

  async listProposalBranches(): Promise<string[]> {
    const branches = await this.git.branchLocal();
    return branches.all.filter(b => b.startsWith('tune/proposal-'));
  }
}
