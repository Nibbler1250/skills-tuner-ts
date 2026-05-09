import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import { ProposalsStore } from "../../src/storage/proposals.js";
import { RefusedStore } from "../../src/storage/refused.js";
import { BranchManager } from "../../src/git_ops/branches.js";
import { TunableSubject } from "../../src/core/interfaces.js";
import type { TunerConfig } from "../../src/core/config.js";
import type { Cluster, Observation, Patch, Proposal, ValidationResult } from "../../src/core/types.js";

function makeConfig(): TunerConfig {
  return {
    models: {
      intent_classifier: "claude-haiku-4-5-20251001",
      detector: "claude-haiku-4-5-20251001",
      proposer_default: "claude-haiku-4-5-20251001",
      proposer_high_stakes: "claude-sonnet-4-6",
      judge: "claude-haiku-4-5-20251001",
    },
    detection: { confidence_floor: 0.6, max_proposals_per_run: 3, improvement_keywords_extra: [] },
    proposer: { alternatives_count: 2, language_preference: "en" },
    ui: { primary_adapter: "cli", follow_up_survey: false, follow_up_after_seconds: 3600 },
    storage: {
      proposals_jsonl: "/tmp/test-p.jsonl",
      refused_jsonl: "/tmp/test-r.jsonl",
      schema_version: 1,
      backup_keep: 7,
      git_repo: undefined,
    },
    llm: { backend: "claude_cli", api_key: undefined },
    subjects: {},
  } as TunerConfig;
}

async function initGitRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# test");
  await git.add(".");
  await git.commit("initial");
}

// Deterministic subject so apply() works in git repo
function makeSubject(gitDir: string) {
  class FixedSubject extends TunableSubject {
    readonly name = "test";
    private callCount = 0;
    async collectObservations(_since: Date): Promise<Observation[]> { return []; }
    async detectProblems(_obs: Observation[]): Promise<Cluster[]> {
      return [{
        id: "cluster-concurrent",
        subject: "test",
        observations: [],
        frequency: 3,
        success_rate: 0.2,
        sentiment: "negative" as const,
        subjects_touched: ["test"],
      }];
    }
    async proposeChange(_cluster: Cluster): Promise<Proposal> {
      return {
        id: 0,
        cluster_id: "cluster-concurrent",
        subject: "test",
        kind: "patch",
        target_path: join(gitDir, "skill.md"),
        alternatives: [{ id: "A", label: "fix", diff_or_content: "# fixed", tradeoff: "" }],
        pattern_signature: "concurrent-sig-fixed",
        created_at: new Date(),
      };
    }
    async apply(_proposal: Proposal, _alt: string): Promise<Patch> {
      return { target_path: join(gitDir, "skill.md"), kind: "patch", applied_content: "# fixed" };
    }
    async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
  }
  return new FixedSubject();
}

describe("Engine concurrency", () => {
  let dir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;
  let engine: Engine;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tuner-concurrency-"));
    gitDir = mkdtempSync(join(tmpdir(), "tuner-git-concurrency-"));
    await initGitRepo(gitDir);

    proposals = new ProposalsStore(join(dir, "proposals.jsonl"));
    refused = new RefusedStore(join(dir, "refused.jsonl"));
    branches = new BranchManager(gitDir);
    registry = new Registry();
    registry.registerSubject(makeSubject(gitDir));
    engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as unknown as { secret: Buffer }).secret = Buffer.alloc(32);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
    rmSync(gitDir, { recursive: true });
  });

  test("concurrent applyProposal — only one succeeds (race condition prevention)", async () => {
    // Create the proposal
    await engine.runCycle();
    const records = proposals.readAll();
    expect(records).toHaveLength(1);
    const proposalId = records[0]!.proposal.id;

    // Fire two concurrent apply calls
    const results = await Promise.allSettled([
      engine.applyProposal(proposalId, "A"),
      engine.applyProposal(proposalId, "A"),
    ]);

    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");

    // The Engine has an in-memory lock: exactly one should succeed
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Only ONE "applied" event should be in the store
    const allRecords = proposals.readAll();
    const appliedEvents = allRecords.filter(r => r.event === "applied");
    expect(appliedEvents).toHaveLength(1);
  });

  test("sequential applyProposal — second call throws already-applied", async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;

    await engine.applyProposal(proposalId, "A");
    await expect(engine.applyProposal(proposalId, "A")).rejects.toThrow("already applied");
  });
});
