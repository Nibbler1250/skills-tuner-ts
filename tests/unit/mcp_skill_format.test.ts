import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const SKILL_PATH = join(__dirname, '..', '..', 'templates', 'skills', 'mcp', 'SKILL.md');

describe('mcp companion skill format', () => {
  test('SKILL.md exists in directory format', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  test('frontmatter parses + has Anthropic-required fields', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    expect(match).not.toBeNull();
    const fm = yaml.load(match![1]!) as Record<string, any>;
    expect(fm.name).toBe('mcp');
    expect(typeof fm.description).toBe('string');
    expect(fm.description.length).toBeGreaterThan(80);  // discoverable description
  });

  test('frontmatter does NOT contain skills-tuner-specific fields', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    const fm = yaml.load(match![1]!) as Record<string, any>;
    // These belong in config.yaml overrides, not in SKILL.md frontmatter
    expect(fm.triggers).toBeUndefined();
    expect(fm.risk_tier).toBeUndefined();
    expect(fm.auto_merge).toBeUndefined();
  });

  test('all 9 modes documented', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    const modes = ['setup', 'list', 'inspect', 'diagnose', 'audit', 'trace', 'register', 'test', 'report'];
    for (const mode of modes) {
      expect(content).toContain(`## Mode: ${mode}`);
    }
  });

  test('mode dispatch table maps all 9 modes', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('Mode dispatch');
    // Verify each mode mentioned in dispatch
    expect(content).toMatch(/`\/mcp` \(no arg\)|first-time use → \*\*setup\*\*/);
    expect(content).toMatch(/`\/mcp list`/);
    expect(content).toMatch(/`\/mcp inspect/);
    expect(content).toMatch(/`\/mcp diagnose`/);
    expect(content).toMatch(/`\/mcp audit/);
    expect(content).toMatch(/`\/mcp trace/);
    expect(content).toMatch(/`\/mcp register`/);
    expect(content).toMatch(/`\/mcp test/);
    expect(content).toMatch(/`\/mcp report`/);
  });
});
