import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProposalsStore } from "../../src/storage/proposals.js";
import type { Proposal } from "../../src/core/types.js";

function makeProposal(id: number): Proposal {
  return {
    id,
    cluster_id: `cluster-${id}`,
    subject: "test",
    kind: "patch",
    target_path: `/tmp/skill-${id}.md`,
    alternatives: [{ id: "A", label: "fix", diff_or_content: "# fixed", tradeoff: "" }],
    pattern_signature: `sig-${id}`,
    created_at: new Date("2026-05-09T00:00:00Z"),
    signature: "fakesig",
  };
}

describe("ProposalsStore JSONL corruption handling", () => {
  let dir: string;
  let store: ProposalsStore;
  let storeFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tuner-corruption-"));
    storeFile = join(dir, "proposals.jsonl");
    store = new ProposalsStore(storeFile);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("readAll skips corrupted lines and returns valid records", () => {
    // Write 3 valid JSONL records
    for (let i = 1; i <= 3; i++) {
      const record = {
        proposal: makeProposal(i),
        event: "created" as const,
        ts: new Date().toISOString(),
      };
      appendFileSync(storeFile, JSON.stringify(record) + "\n");
    }

    // Append a corrupted line (truncated JSON)
    appendFileSync(storeFile, '{"event":"created","ts":"2026-05-09T00:00:00Z","prop\n');

    // Append one more valid record
    const record4 = {
      proposal: makeProposal(4),
      event: "created" as const,
      ts: new Date().toISOString(),
    };
    appendFileSync(storeFile, JSON.stringify(record4) + "\n");

    // readAll should return 4 valid records, skipping the corrupted line
    const records = store.readAll();
    expect(records).toHaveLength(4);
    expect(records.map(r => r.proposal.id)).toEqual([1, 2, 3, 4]);
  });

  test("readAll does not throw on fully corrupted file", () => {
    writeFileSync(storeFile, "not json at all\n{also broken\n{{{\n");
    expect(() => store.readAll()).not.toThrow();
    expect(store.readAll()).toHaveLength(0);
  });

  test("readAll handles empty file gracefully", () => {
    writeFileSync(storeFile, "");
    expect(store.readAll()).toHaveLength(0);
  });

  test("readAll handles mixed valid and multiple corrupted lines", () => {
    const record = {
      proposal: makeProposal(1),
      event: "created" as const,
      ts: new Date().toISOString(),
    };
    appendFileSync(storeFile, JSON.stringify(record) + "\n");
    appendFileSync(storeFile, "CORRUPT_LINE_1\n");
    appendFileSync(storeFile, '{"partial": true\n');
    appendFileSync(storeFile, "   \n"); // blank line

    const records = store.readAll();
    expect(records).toHaveLength(1);
    expect(records[0]!.proposal.id).toBe(1);
  });
});
