import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditLog, AUDIT_PATH } from "../../src/core/security.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Known limitation: no hash chain in audit log.
// Future work: add prev_hash field per entry for tamper detection.

describe("Audit log tamper detection (documents limitation)", () => {
  let tmpAuditPath: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tuner-audit-chain-"));
    tmpAuditPath = join(dir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("tampering with audit log goes undetected (no hash chain — known limitation)", () => {
    // Write 5 audit log entries directly to a temp file
    const entries = [
      { ts: "2026-05-09T10:00:00Z", event: "proposal_created", proposal_id: 1 },
      { ts: "2026-05-09T10:01:00Z", event: "apply_attempted", proposal_id: 1 },
      { ts: "2026-05-09T10:02:00Z", event: "apply_success", proposal_id: 1, commit_sha: "abc123" },
      { ts: "2026-05-09T10:03:00Z", event: "proposal_created", proposal_id: 2 },
      { ts: "2026-05-09T10:04:00Z", event: "apply_attempted", proposal_id: 2 },
    ];

    for (const entry of entries) {
      appendFileSync(tmpAuditPath, JSON.stringify(entry) + "\n");
    }

    // Verify all 5 entries are there
    const allLines = readFileSync(tmpAuditPath, "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
    expect(allLines).toHaveLength(5);

    // TAMPER: Remove entry #3 (apply_success) — simulating log deletion
    const remaining = allLines.filter((_: unknown, i: number) => i !== 2); // remove index 2
    writeFileSync(tmpAuditPath, remaining.map((e: unknown) => JSON.stringify(e)).join("\n") + "\n");

    // Read back after tampering
    const afterTamper = readFileSync(tmpAuditPath, "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    // Known limitation: we only get 4 entries — tampering is NOT detected
    expect(afterTamper).toHaveLength(4);

    // The apply_success entry is gone — no automatic detection
    const applySuccess = afterTamper.find((e: { event: string }) => e.event === "apply_success");
    expect(applySuccess).toBeUndefined();

    // Known limitation: no prev_hash chain exists to detect the gap
    // Future work: each entry should include prev_hash = SHA256(previous_entry_json)
    // so that removal of any entry breaks the chain and can be detected.
    const hasHashChain = afterTamper.every((e: { prev_hash?: string }) => "prev_hash" in e);
    expect(hasHashChain).toBe(false); // documents the limitation
  });

  test("audit log accepts arbitrary entries without integrity verification", () => {
    // An attacker who can write to the audit file can inject fake entries
    const fakeEntry = {
      ts: "2026-05-09T09:00:00Z",
      event: "apply_success",
      proposal_id: 999,
      commit_sha: "fakehash",
      note: "This entry was injected — no way to detect without hash chain",
    };

    appendFileSync(tmpAuditPath, JSON.stringify(fakeEntry) + "\n");

    const lines = readFileSync(tmpAuditPath, "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    // The injected entry is indistinguishable from a real one
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("apply_success");
    expect(lines[0].proposal_id).toBe(999);

    // Known limitation: no signature or hash chain to distinguish real from injected entries
    expect(lines[0].prev_hash).toBeUndefined();
  });
});
