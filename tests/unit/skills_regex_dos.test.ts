import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillsSubject } from "../../src/subjects/skills.js";

// Test for regex DoS (catastrophic backtracking) in scoreSignal/reclassifySignal
// when skill triggers contain pathological regex patterns.
//
// Known limitation: scoreSignal uses string.includes() for trigger matching,
// NOT RegExp.test(). This means catastrophic regex patterns in trigger frontmatter
// are NOT compiled as regexes — they're treated as literal substrings.
// Therefore, regex DoS is NOT applicable to the current implementation.
// This test documents this safe behavior.

describe("SkillsSubject regex DoS resistance", () => {
  let skillsDir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), "tuner-regex-dos-"));
    subject = new SkillsSubject({ scanDirs: [skillsDir] });
  });

  afterEach(() => {
    rmSync(skillsDir, { recursive: true });
  });

  test("scoreSignal completes in <500ms with catastrophic backtracking pattern as trigger", () => {
    // The catastrophic pattern (a+)+b would cause exponential backtracking if compiled as regex
    // But scoreSignal uses .includes() for trigger matching — so it's a literal string search
    const catastrophicPattern = "(a+)+b";

    // knownEntities simulates a skill with a catastrophic regex as its trigger string
    const knownEntities = {
      "evil-regex-skill": { triggers: [catastrophicPattern] },
    };

    // Input that would cause catastrophic backtracking if evaluated as regex
    const reDoSInput = "aaaaaaaaaaaaaaaaaaaaaaaaa!";

    const start = Date.now();
    const score = subject.scoreSignal(reDoSInput, "evil-regex-skill", knownEntities);
    const elapsed = Date.now() - start;

    // Must complete well under 500ms (literal includes() is O(n*m), not exponential)
    expect(elapsed).toBeLessThan(500);

    // Score should be 2 if the literal pattern "(a+)+b" is found in input, else 0
    // "(a+)+b" is NOT in "aaaaaaaaaaaaaaaaaaaaaaaaa!" so score contribution = 0
    // No others matched, no emot — score = 0
    expect(typeof score).toBe("number");
  });

  test("reclassifySignal completes in <500ms with pathological pattern", () => {
    const pathologicalPattern = "(?:a|a)*b"; // another catastrophic pattern if compiled

    const knownEntities = {
      "pathological-skill": { triggers: [pathologicalPattern] },
    };

    const reDoSInput = "a".repeat(25) + "!";

    const start = Date.now();
    const result = subject.reclassifySignal(reDoSInput, knownEntities);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    // Pattern not literally in input, so orphan is returned
    expect(typeof result).toBe("string");
  });

  test("scoreSignal uses literal string matching, not RegExp compilation", () => {
    // Verify the implementation does NOT compile triggers as regex
    // by using a string that would match as regex but not as literal

    // As regex: /abc?/ would match "ab" or "abc"
    // As literal: "abc?" only matches the exact string "abc?"
    const knownEntities = {
      "regex-vs-literal": { triggers: ["abc?"] },
    };

    // "abc" would match the regex /abc?/ but NOT the literal "abc?"
    const score = subject.scoreSignal("abc is here", "regex-vs-literal", knownEntities);

    // If triggers are compiled as regex: score would be 2 (trigger matched)
    // If triggers are literal includes(): score would be 0 (literal "abc?" not in "abc is here")
    // The safe (current) behavior is literal matching: score = 0
    expect(score).toBe(0); // documents safe literal-matching behavior

    // Confirm literal match DOES work
    const scoreWithLiteral = subject.scoreSignal("abc? is here", "regex-vs-literal", knownEntities);
    expect(scoreWithLiteral).toBe(2); // literal "abc?" IS in "abc? is here"
  });

  test("skills with catastrophic trigger patterns still load without hanging", async () => {
    // Write a skill with a catastrophic pattern as its trigger
    const catastrophicSkill = `---
name: catastrophic-skill
triggers: (a+)+b, normal-trigger
description: Skill with pathological trigger pattern
---

# Catastrophic Skill

This skill has a catastrophic regex pattern as a trigger.
The tuner should handle it safely via literal string matching.
`;

    writeFileSync(join(skillsDir, "catastrophic-skill.md"), catastrophicSkill);

    const start = Date.now();
    // collectObservations will load skills and index their triggers
    await subject.collectObservations(new Date());
    const elapsed = Date.now() - start;

    // Should complete quickly — no regex compilation
    expect(elapsed).toBeLessThan(2000);
  });
});
