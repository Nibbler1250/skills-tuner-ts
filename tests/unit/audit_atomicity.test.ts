import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import { ProposalsStore } from "../../src/storage/proposals.js";
import { RefusedStore } from "../../src/storage/refused.js";
import { BranchManager } from "../../src/git_ops/branches.js";
import { AUDIT_PATH } from "../../src/core/security.js";
import { TunableSubject } from "../../src/core/interfaces.js";
import type { TunerConfig } from "../../src/core/config.js";
import type { Cluster, Observation, Patch, Proposal, ValidationResult } from "../../src/core/types.js";

function makeConfig(overrides: Partial<TunerConfig> = {}): TunerConfig {
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
    ...overrides,
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

function makeSubject(gitDir: string) {
  class AuditSubject extends TunableSubject {
    readonly name = "audit-test";
    async collectObservations(_since: Date): Promise<Observation[]> { return []; }
    async detectProblems(_obs: Observation[]): Promise<Cluster[]> {
      return [{
        id: "audit-cluster",
        subject: "audit-test",
        observations: [],
        frequency: 3,
        success_rate: 0.2,
        sentiment: "negative" as const,
        subjects_touched: ["audit-test"],
      }];
    }
    async proposeChange(_cluster: Cluster): Promise<Proposal> {
      return {
        id: 0,
        cluster_id: "audit-cluster",
        subject: "audit-test",
        kind: "patch",
        target_path: join(gitDir, "skill.md"),
        alternatives: [{ id: "A", label: "fix", diff_or_content: "# fixed", tradeoff: "" }],
        pattern_signature: "audit-sig-fixed",
        created_at: new Date(),
      };
    }
    async apply(_proposal: Proposal, _alt: string): Promise<Patch> {
      return { target_path: join(gitDir, "skill.md"), kind: "patch", applied_content: "# fixed" };
    }
    async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
  }
  return new AuditSubject();
}

describe("Engine audit log atomicity", () => {
  let dir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;
  let engine: Engine;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tuner-audit-"));
    gitDir = mkdtempSync(join(tmpdir(), "tuner-git-audit-"));
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

  test("applyProposal writes audit entry before returning", async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    expect(records).toHaveLength(1);
    const proposalId = records[0]!.proposal.id;

    const beforeApply = Date.now();
    await engine.applyProposal(proposalId, "A");
    const afterApply = Date.now();

    // Audit log should exist and contain apply_success event
    expect(existsSync(AUDIT_PATH)).toBe(true);
    const auditLines = readFileSync(AUDIT_PATH, "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    // Find a fresh apply_success entry for this proposalId written DURING this test run
    // Filter by timestamp >= beforeApply to exclude stale entries from previous runs
    const applySuccess = auditLines.find(
      e => e.event === "apply_success" && e.proposal_id === proposalId &&
           new Date(e.ts).getTime() >= beforeApply - 2000 // 2s tolerance for clock jitter
    );
    expect(applySuccess).toBeDefined();

    // Verify the audit entry was written within our apply window
    const auditTs = new Date(applySuccess.ts).getTime();
    expect(auditTs).toBeLessThanOrEqual(afterApply + 2000);
  });

  test("applyProposal audit order: apply_attempted logged before apply_success", async () => {
    await engine.runCycle();
    const records = proposals.readAll();
    const proposalId = records[0]!.proposal.id;

    await engine.applyProposal(proposalId, "A");

    const auditLines = readFileSync(AUDIT_PATH, "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
      .filter((e: { proposal_id?: number }) => e.proposal_id === proposalId);

    const attemptedIdx = auditLines.findIndex((e: { event: string }) => e.event === "apply_attempted");
    const successIdx = auditLines.findIndex((e: { event: string }) => e.event === "apply_success");

    // apply_attempted should come before apply_success in the log
    expect(attemptedIdx).toBeGreaterThanOrEqual(0);
    expect(successIdx).toBeGreaterThanOrEqual(0);
    expect(attemptedIdx).toBeLessThan(successIdx);
  });
});
