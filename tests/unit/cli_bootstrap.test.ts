import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { bootstrapEngine } from '../../src/cli/bootstrap.js';
import type { TunerConfig } from '../../src/core/config.js';

describe('CLI bootstrap', () => {
  let tmp: string;
  let gitRepo: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `tuner-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    gitRepo = join(tmp, 'repo');
    mkdirSync(gitRepo);
    execSync('git init -q', { cwd: gitRepo });
    execSync('git config user.email t@e.com && git config user.name t', { cwd: gitRepo });
    writeFileSync(join(gitRepo, 'README.md'), '# t');
    execSync('git add . && git commit -q -m init', { cwd: gitRepo });
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test('bootstrapEngine registers SkillsSubject when config.subjects.skills is enabled', () => {
    const skillsDir = join(tmp, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    const config = {
      models: {} as any,
      llm: {} as any,
      detection: {} as any,
      proposer: {} as any,
      subjects: { skills: { enabled: true, scan_dirs: [skillsDir], auto_merge: false } as any },
      ui: {} as any,
      storage: {
        proposals_jsonl: join(tmp, 'p.jsonl'),
        refused_jsonl: join(tmp, 'r.jsonl'),
        schema_version: 1,
        backup_keep: 7,
        git_repo: gitRepo,
      },
    } as unknown as TunerConfig;

    const { engine, registry } = bootstrapEngine(config);
    expect(engine).toBeDefined();
    const subjects = registry.enabledSubjects(config);
    expect(subjects.length).toBe(1);
    expect(subjects[0]!.name).toBe('skills');
  });

  test('bootstrapEngine skips skills subject when explicitly disabled', () => {
    const config = {
      models: {} as any, llm: {} as any, detection: {} as any, proposer: {} as any,
      subjects: { skills: { enabled: false, scan_dirs: [], auto_merge: false } as any },
      ui: {} as any,
      storage: {
        proposals_jsonl: join(tmp, 'p.jsonl'), refused_jsonl: join(tmp, 'r.jsonl'),
        schema_version: 1, backup_keep: 7, git_repo: gitRepo,
      },
    } as unknown as TunerConfig;
    const { registry } = bootstrapEngine(config);
    expect(registry.enabledSubjects(config).length).toBe(0);
  });

  test('bootstrapEngine throws when storage.git_repo is missing', () => {
    const config = {
      models: {} as any, llm: {} as any, detection: {} as any, proposer: {} as any,
      subjects: {}, ui: {} as any,
      storage: {
        proposals_jsonl: join(tmp, 'p.jsonl'), refused_jsonl: join(tmp, 'r.jsonl'),
        schema_version: 1, backup_keep: 7,
      },
    } as unknown as TunerConfig;
    expect(() => bootstrapEngine(config)).toThrow(/git_repo/);
  });
});

describe('BaseSubject loadFrontmatter resilience', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `tuner-yaml-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test('malformed YAML frontmatter does not crash; scan continues with empty frontmatter', async () => {
    const skillsDir = join(tmp, 'skills');
    mkdirSync(skillsDir);
    const goodPath = join(skillsDir, 'good.md');
    writeFileSync(goodPath, '---\nname: good\ndescription: ok\n---\nbody');
    const badPath = join(skillsDir, 'bad.md');
    // Deliberately broken: comma-separated unquoted strings (real-world skill author mistake)
    writeFileSync(badPath, '---\nname: bad\ntrigger: "a", "b", "c"\n---\nbody');

    const { SkillsSubject } = await import('../../src/subjects/skills.js');
    const subj = new SkillsSubject({ scanDirs: [skillsDir] });
    // currentStateHash walks files via loadFrontmatter; should not throw
    const hash = subj.currentStateHash();
    expect(typeof hash).toBe('string');
    expect(hash!.length).toBeGreaterThan(0);
  });
});
