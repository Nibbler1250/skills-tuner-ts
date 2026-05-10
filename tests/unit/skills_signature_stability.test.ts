import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsSubject } from '../../src/subjects/skills.js';
import type { Observation } from '../../src/core/types.js';

describe('SkillsSubject pattern_signature stability', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `tuner-sig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env['TUNER_AUDIT_PATH'] = join(tmp, 'audit.jsonl');
  });

  afterEach(() => {
    delete process.env['TUNER_AUDIT_PATH'];
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test('patch proposal pattern_signature does not contain a date stamp', async () => {
    const skillsDir = join(tmp, 'skills');
    mkdirSync(skillsDir);
    const skillPath = join(skillsDir, 'foo.md');
    writeFileSync(skillPath, '---\nname: foo\ndescription: x\n---\nbody');

    const subj = new SkillsSubject({ scanDirs: [skillsDir] });
    const obs: Observation[] = Array(5).fill(null).map((_, i) => ({
      session_id: `s${i}`, observed_at: new Date(), signal_type: 'correction',
      verbatim: 'fix me', metadata: { skill_name: 'foo' },
    }));
    const clusters = await subj.detectProblems(obs);
    expect(clusters.length).toBeGreaterThan(0);
    const proposal = await subj.proposeChange(clusters[0]!);
    // Stable signature: only path + kind, no date
    expect(proposal.pattern_signature).toBe(`skills:${skillPath}:patch`);
    // removed brittle regex (temp dir timestamps trip it)
  });

  test('two clusters for the same skill on different days produce identical pattern_signature', async () => {
    const skillsDir = join(tmp, 'skills');
    mkdirSync(skillsDir);
    const skillPath = join(skillsDir, 'foo.md');
    writeFileSync(skillPath, '---\nname: foo\ndescription: x\n---\nbody');

    const subj = new SkillsSubject({ scanDirs: [skillsDir] });
    const obs1: Observation[] = Array(5).fill(null).map((_, i) => ({
      session_id: `s${i}`, observed_at: new Date('2026-01-01T12:00:00Z'),
      signal_type: 'correction', verbatim: 'fix it', metadata: { skill_name: 'foo' },
    }));
    const obs2: Observation[] = Array(5).fill(null).map((_, i) => ({
      session_id: `s${i}`, observed_at: new Date('2026-06-15T12:00:00Z'),
      signal_type: 'correction', verbatim: 'fix it', metadata: { skill_name: 'foo' },
    }));
    const c1 = (await subj.detectProblems(obs1))[0]!;
    const c2 = (await subj.detectProblems(obs2))[0]!;
    const p1 = await subj.proposeChange(c1);
    const p2 = await subj.proposeChange(c2);
    expect(p1.pattern_signature).toBe(p2.pattern_signature);
  });

  test('orphan new_skill pattern_signature varies by observation content (different needs ≠ same sig)', async () => {
    const skillsDir = join(tmp, 'skills');
    mkdirSync(skillsDir);
    const subj = new SkillsSubject({ scanDirs: [skillsDir] });
    const obsA: Observation[] = Array(5).fill(null).map((_, i) => ({
      session_id: `s${i}`, observed_at: new Date(), signal_type: 'orphan',
      verbatim: 'I need a weather skill', metadata: { skill_name: '__new_entity__' },
    }));
    const obsB: Observation[] = Array(5).fill(null).map((_, i) => ({
      session_id: `s${i}`, observed_at: new Date(), signal_type: 'orphan',
      verbatim: 'I need a calendar skill', metadata: { skill_name: '__new_entity__' },
    }));
    const cA = (await subj.detectProblems(obsA))[0]!;
    const cB = (await subj.detectProblems(obsB))[0]!;
    const pA = await subj.proposeChange(cA);
    const pB = await subj.proposeChange(cB);
    expect(pA.pattern_signature).not.toBe(pB.pattern_signature);
    expect(pA.pattern_signature).toMatch(/^skills:__new_entity__:new_skill:/);
  });
});
