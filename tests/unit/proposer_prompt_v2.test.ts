import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsSubject } from '../../src/subjects/skills.js';
import type { LLMClient, Role } from '../../src/core/llm.js';
import type { Observation } from '../../src/core/types.js';

class CapturingLLM implements LLMClient {
  capturedSystem = '';
  capturedUser = '';
  modelFor(_role: Role): string { return 'mock'; }
  async call(_role: Role, system: string, messages: { role: string; content: string }[], _maxTokens?: number): Promise<string> {
    this.capturedSystem = system;
    this.capturedUser = messages[0]?.content ?? '';
    return JSON.stringify([
      { id: 'A', label: 'L1', diff_or_content: 'X', tradeoff: 'T1' },
      { id: 'B', label: 'L2', diff_or_content: 'Y', tradeoff: 'T2' },
      { id: 'C', label: 'L3', diff_or_content: 'Z', tradeoff: 'T3' },
    ]);
  }
}

describe('Proposer prompt v2 — diagnose-first structure', () => {
  test('llmPropose system prompt requires diagnosis and rejects cosmetic variants', async () => {
    const tmp = join(tmpdir(), `tuner-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env['TUNER_AUDIT_PATH'] = join(tmp, 'audit.jsonl');
    try {
      const skillsDir = join(tmp, 'skills');
      mkdirSync(skillsDir);
      writeFileSync(join(skillsDir, 'foo.md'), '---\nname: foo\ndescription: x\n---\nbody');

      const llm = new CapturingLLM();
      const subj = new SkillsSubject({ llm, scanDirs: [skillsDir], language: 'fr-quebec' });
      const obs: Observation[] = Array(3).fill(null).map(() => ({
        session_id: 's', observed_at: new Date(), signal_type: 'correction',
        verbatim: 'allume pas la bonne lampe', metadata: { skill_name: 'foo' },
      }));
      const clusters = await subj.detectProblems(obs);
      expect(clusters.length).toBeGreaterThan(0);
      await subj.proposeChange(clusters[0]!);

      // v2 system prompt must include the diagnose step + behavior-changing constraint
      expect(llm.capturedSystem).toContain('Diagnose');
      expect(llm.capturedSystem).toContain('cosmetic');
      expect(llm.capturedSystem).toContain('DIFFERENT strategy');
expect(llm.capturedUser).toContain('behavior-changing');
      // language hint must be propagated
      expect(llm.capturedSystem).toContain('fr-quebec');
      // must not be the old vague form
      expect(llm.capturedSystem).not.toContain('expert in prompt improvement');
    } finally {
      delete process.env['TUNER_AUDIT_PATH'];
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('llmProposeNewSkill system prompt forces distinct angles and frontmatter discipline', async () => {
    const tmp = join(tmpdir(), `tuner-prompt2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env['TUNER_AUDIT_PATH'] = join(tmp, 'audit.jsonl');
    try {
      const skillsDir = join(tmp, 'skills');
      mkdirSync(skillsDir);

      const llm = new CapturingLLM();
      const subj = new SkillsSubject({ llm, scanDirs: [skillsDir], language: 'en' });
      const obs: Observation[] = Array(3).fill(null).map((_, i) => ({
        session_id: `s${i}`, observed_at: new Date(), signal_type: 'orphan',
        verbatim: 'I need a way to schedule reminders', metadata: { skill_name: '__new_entity__' },
      }));
      const clusters = await subj.detectProblems(obs);
      expect(clusters.length).toBeGreaterThan(0);
      await subj.proposeChange(clusters[0]!);

      // v2 new_skill prompt characteristics
      expect(llm.capturedSystem).toContain('DIFFERENT angle');
      expect(llm.capturedSystem).toContain("'name' and 'description'");
      expect(llm.capturedSystem).toContain('en');
    } finally {
      delete process.env['TUNER_AUDIT_PATH'];
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});
