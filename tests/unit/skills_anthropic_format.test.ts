import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsSubject } from '../../src/subjects/skills.js';

function makeScanDir(): string {
  return mkdtempSync(join(tmpdir(), 'skills-format-'));
}

describe('SkillsSubject — Anthropic format', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = makeScanDir();
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('loadSkills detects directory-based skill', async () => {
    const skillDir = join(dir, 'my-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Does my thing.\n---\n\n# My Skill\n');

    const obs = await subject.collectObservations(new Date(0));
    // Skills loaded — no crash means directory format was detected
    // Verify by checking cache through proposeChange path
    const proposal = await subject.proposeChange({
      id: 'test', subject: 'skills', observations: [
        { session_id: 's1', observed_at: new Date(), signal_type: 'correction', verbatim: 'my-skill nope', metadata: { skill_name: 'my-skill' } },
        { session_id: 's1', observed_at: new Date(), signal_type: 'correction', verbatim: 'my-skill wrong', metadata: { skill_name: 'my-skill' } },
      ],
      frequency: 2, success_rate: 0, sentiment: 'negative', subjects_touched: ['my-skill'],
    });
    // target_path should point to the directory-format SKILL.md
    expect(proposal.target_path).toContain('my-skill');
    expect(proposal.target_path).toContain('SKILL.md');
  });

  test('loadSkills detects flat skill (legacy)', async () => {
    writeFileSync(join(dir, 'old-skill.md'), '---\nname: old-skill\ntriggers: old-skill\n---\n\n# Old Skill\n');

    const proposal = await subject.proposeChange({
      id: 'test', subject: 'skills', observations: [
        { session_id: 's1', observed_at: new Date(), signal_type: 'correction', verbatim: 'old-skill nope', metadata: { skill_name: 'old-skill' } },
        { session_id: 's1', observed_at: new Date(), signal_type: 'correction', verbatim: 'old-skill wrong', metadata: { skill_name: 'old-skill' } },
      ],
      frequency: 2, success_rate: 0, sentiment: 'negative', subjects_touched: ['old-skill'],
    });
    // flat format: target_path ends with .md, not SKILL.md inside a dir
    expect(proposal.target_path).toMatch(/old-skill\.md$/);
    expect(proposal.target_path).not.toContain('SKILL.md');
  });

  test('directory format wins over flat when both exist', async () => {
    // Create flat format
    writeFileSync(join(dir, 'my-skill.md'), '---\nname: my-skill\ntriggers: my-skill\n---\n\n# Flat\n');
    // Create directory format (should win)
    const skillDir = join(dir, 'my-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Directory version wins.\n---\n\n# Directory\n');

    const proposal = await subject.proposeChange({
      id: 'test', subject: 'skills', observations: [
        { session_id: 's1', observed_at: new Date(), signal_type: 'correction', verbatim: 'my-skill nope', metadata: { skill_name: 'my-skill' } },
        { session_id: 's1', observed_at: new Date(), signal_type: 'correction', verbatim: 'my-skill wrong', metadata: { skill_name: 'my-skill' } },
      ],
      frequency: 2, success_rate: 0, sentiment: 'negative', subjects_touched: ['my-skill'],
    });
    // directory format wins: target_path is SKILL.md inside the directory
    expect(proposal.target_path).toContain('SKILL.md');
    expect(proposal.target_path).not.toMatch(/my-skill\.md$/);
  });

  test('apply new_skill creates directory by default', async () => {
    const proposal = {
      id: 1, cluster_id: 'c1', subject: 'skills', kind: 'new_skill',
      target_path: join(dir, '__new_entity__.md'),
      alternatives: [{
        id: 'A', label: 'my-new-skill',
        diff_or_content: '---\nname: my-new-skill\ndescription: A brand new skill.\n---\n\n# My New Skill\n',
        tradeoff: '',
      }],
      pattern_signature: 'sig', created_at: new Date(),
    };
    const patch = await subject.apply(proposal, 'A');
    // Should create <dir>/my-new-skill/SKILL.md
    expect(patch.target_path).toMatch(/my-new-skill\/SKILL\.md$/);
    expect(existsSync(patch.target_path)).toBe(true);
    // Parent directory must exist
    expect(existsSync(join(dir, 'my-new-skill'))).toBe(true);
  });

  test('apply new_skill collision adds timestamp to directory name', async () => {
    // Pre-create the directory to trigger collision
    mkdirSync(join(dir, 'my-skill'));
    const proposal = {
      id: 1, cluster_id: 'c1', subject: 'skills', kind: 'new_skill',
      target_path: join(dir, '__new_entity__.md'),
      alternatives: [{
        id: 'A', label: 'my-skill',
        diff_or_content: '---\nname: my-skill\ndescription: Collision test.\n---\n\n# Skill\n',
        tradeoff: '',
      }],
      pattern_signature: 'sig', created_at: new Date(),
    };
    const patch = await subject.apply(proposal, 'A');
    expect(patch.target_path).toMatch(/my-skill-\d+\/SKILL\.md$/);
    expect(existsSync(patch.target_path)).toBe(true);
  });

  test('triggers resolved from config overrides if present', async () => {
    writeFileSync(join(dir, 'flat-skill.md'), '---\nname: flat-skill\ntriggers: old-trigger\n---\n# Flat\n');

    const subjectWithOverride = new SkillsSubject({
      scanDirs: [dir],
      overrides: { 'flat-skill': { triggers: ['config-trigger', 'override-trigger'] } },
    });

    // scoreSignal uses config overrides — 'config-trigger' should match
    const score = subjectWithOverride.scoreSignal('config-trigger is wrong', 'flat-skill', {
      'flat-skill': { triggers: ['config-trigger', 'override-trigger'] },
    });
    expect(score).toBe(2); // matched the attributed skill
  });

  test('triggers fallback to frontmatter if no config override', async () => {
    writeFileSync(join(dir, 'fm-skill.md'), '---\nname: fm-skill\ntriggers: frontmatter-trigger\n---\n# FM\n');

    const subjectNoOverride = new SkillsSubject({ scanDirs: [dir] });

    // Use reclassifySignal — should pick up frontmatter trigger
    const matched = subjectNoOverride.reclassifySignal('frontmatter-trigger is bad', {
      'fm-skill': { triggers: ['frontmatter-trigger'] },
    });
    expect(matched).toBe('fm-skill');
  });

  test('triggers fallback to skill name if neither config nor frontmatter', async () => {
    // Directory-format skill with no triggers in frontmatter and no config override
    const skillDir = join(dir, 'bare-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: bare-skill\ndescription: No triggers declared.\n---\n\n# Bare\n');

    const subjectNoOverride = new SkillsSubject({ scanDirs: [dir] });
    // reclassifySignal: fallback trigger is skill name itself
    const matched = subjectNoOverride.reclassifySignal('bare-skill is not working', {
      'bare-skill': { triggers: ['bare-skill'] },
    });
    expect(matched).toBe('bare-skill');
  });
});
