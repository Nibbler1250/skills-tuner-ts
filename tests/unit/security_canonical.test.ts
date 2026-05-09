import { describe, test, expect } from "bun:test";
import { computeProposalSignature } from "../../src/core/security.js";
import type { Proposal } from "../../src/core/types.js";

describe("HMAC canonical serialization", () => {
  const secret = Buffer.from("a".repeat(32));

  const baseDate = new Date("2026-05-09T12:00:00Z");

  // Two proposals with IDENTICAL field values but different JS property insertion order
  // (In JS, object literal property order affects JSON.stringify output if keys differ)
  // The canonical function in security.ts explicitly constructs a fixed-key-order object,
  // so these should produce the same HMAC regardless of input object key order.

  const proposalNormalOrder: Proposal = {
    id: 1,
    cluster_id: "cluster-canonical",
    subject: "skills",
    kind: "patch",
    target_path: "~/test-skill.md",
    alternatives: [{ id: "A", label: "test alt", diff_or_content: "# content", tradeoff: "some tradeoff" }],
    pattern_signature: "canonical-test-sig",
    created_at: baseDate,
    signature: "dummy",
  };

  // Same proposal but with properties in a completely different insertion order
  // This simulates receiving a proposal from a different serialization path
  const proposalReorderedKeys: Proposal = {
    signature: "dummy",
    created_at: baseDate,
    pattern_signature: "canonical-test-sig",
    alternatives: [{ tradeoff: "some tradeoff", diff_or_content: "# content", label: "test alt", id: "A" }],
    target_path: "~/test-skill.md",
    kind: "patch",
    subject: "skills",
    cluster_id: "cluster-canonical",
    id: 1,
  };

  test("signature is identical regardless of property insertion order", () => {
    const sig1 = computeProposalSignature(proposalNormalOrder, secret);
    const sig2 = computeProposalSignature(proposalReorderedKeys, secret);
    expect(sig1).toBe(sig2);
  });

  test("signature changes when any field value changes", () => {
    const modified = { ...proposalNormalOrder, target_path: "~/different-skill.md" };
    const sig1 = computeProposalSignature(proposalNormalOrder, secret);
    const sig2 = computeProposalSignature(modified, secret);
    expect(sig1).not.toBe(sig2);
  });

  test("signature changes when alternative content changes", () => {
    const modified = {
      ...proposalNormalOrder,
      alternatives: [{ id: "A", label: "test alt", diff_or_content: "# different content", tradeoff: "some tradeoff" }],
    };
    const sig1 = computeProposalSignature(proposalNormalOrder, secret);
    const sig2 = computeProposalSignature(modified, secret);
    expect(sig1).not.toBe(sig2);
  });

  test("signature changes when alternative id changes", () => {
    const modified = {
      ...proposalNormalOrder,
      alternatives: [{ id: "B", label: "test alt", diff_or_content: "# content", tradeoff: "some tradeoff" }],
    };
    const sig1 = computeProposalSignature(proposalNormalOrder, secret);
    const sig2 = computeProposalSignature(modified, secret);
    expect(sig1).not.toBe(sig2);
  });

  test("canonical includes alternatives array order (A,B vs B,A gives different sig)", () => {
    const withTwoAlts: Proposal = {
      ...proposalNormalOrder,
      alternatives: [
        { id: "A", label: "alt A", diff_or_content: "# A", tradeoff: "" },
        { id: "B", label: "alt B", diff_or_content: "# B", tradeoff: "" },
      ],
    };
    const withReversedAlts: Proposal = {
      ...proposalNormalOrder,
      alternatives: [
        { id: "B", label: "alt B", diff_or_content: "# B", tradeoff: "" },
        { id: "A", label: "alt A", diff_or_content: "# A", tradeoff: "" },
      ],
    };
    const sig1 = computeProposalSignature(withTwoAlts, secret);
    const sig2 = computeProposalSignature(withReversedAlts, secret);
    // Different order = different signature (positional sensitivity)
    expect(sig1).not.toBe(sig2);
  });
});
