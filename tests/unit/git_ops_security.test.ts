import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { BranchManager } from "../../src/git_ops/branches.js";
import type { Patch, Proposal } from "../../src/core/types.js";

async function initGitRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# test");
  await git.add(".");
  await git.commit("initial");
}

function makeProposal(gitDir: string): Proposal {
  return {
    id: 42,
    cluster_id: "cluster-symlink",
    subject: "test",
    kind: "patch",
    target_path: join(gitDir, "safe-file.md"),
    alternatives: [{ id: "A", label: "fix", diff_or_content: "# fixed", tradeoff: "" }],
    pattern_signature: "symlink-test-sig",
    created_at: new Date(),
    signature: "fakesig",
  };
}

describe("BranchManager symlink path traversal", () => {
  let gitDir: string;
  let safeDir: string;
  let branches: BranchManager;

  beforeEach(async () => {
    gitDir = mkdtempSync(join(tmpdir(), "tuner-git-symlink-"));
    safeDir = mkdtempSync(join(tmpdir(), "tuner-safe-dir-"));
    await initGitRepo(gitDir);
    branches = new BranchManager(gitDir);
  });

  afterEach(() => {
    rmSync(gitDir, { recursive: true });
    rmSync(safeDir, { recursive: true });
  });

  test("commitPatch rejects target path outside repo (plain absolute path)", async () => {
    const patch: Patch = {
      target_path: "/etc/passwd",
      kind: "patch",
      applied_content: "evil content",
    };
    const proposal = makeProposal(gitDir);
    await branches.createProposalBranch(42);
    await expect(branches.commitPatch(patch, proposal, "A")).rejects.toThrow(/outside repo/);
  });

  test("commitPatch rejects path that escapes repo via .. segments", async () => {
    const escapedPath = join(gitDir, "..", "outside-file.md");
    const patch: Patch = {
      target_path: escapedPath,
      kind: "patch",
      applied_content: "evil content",
    };
    const proposal = makeProposal(gitDir);
    await branches.createProposalBranch(42);
    await expect(branches.commitPatch(patch, proposal, "A")).rejects.toThrow(/outside repo/);
  });

  test("commitPatch rejects symlink pointing outside repo (symlink traversal)", async () => {
    // Create a file outside the repo
    const outsideTarget = join(safeDir, "outside.txt");
    writeFileSync(outsideTarget, "outside content");

    // Create a symlink inside the repo pointing to outside
    const symlinkInRepo = join(gitDir, "symlink-to-outside.md");
    symlinkSync(outsideTarget, symlinkInRepo);

    // The syntactic path is inside the repo, but realpath resolves to outsideTarget
    const patch: Patch = {
      target_path: symlinkInRepo,
      kind: "patch",
      applied_content: "evil content",
    };
    const proposal = makeProposal(gitDir);
    await branches.createProposalBranch(42);

    // Should throw because realpath(symlinkInRepo) = outsideTarget which is outside gitDir
    await expect(branches.commitPatch(patch, proposal, "A")).rejects.toThrow(/symlink traversal|outside repo/);
  });

  test("commitPatch allows legitimate path inside repo", async () => {
    const patch: Patch = {
      target_path: join(gitDir, "new-skill.md"),
      kind: "patch",
      applied_content: "# legitimate skill",
    };
    const proposal = makeProposal(gitDir);
    await branches.createProposalBranch(42);
    await expect(branches.commitPatch(patch, proposal, "A")).resolves.toBeDefined();
  });
});
