import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { CliAdapter } from '../../src/adapters/cli.js';
import type { Proposal } from '../../src/core/types.js';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 42, cluster_id: 'c1', subject: 'skills', kind: 'patch',
    target_path: '/home/simon/agent/skills/test.md',
    alternatives: [
      { id: 'A', label: 'Use new approach', diff_or_content: 'foo', tradeoff: 'Faster' },
      { id: 'B', label: 'Keep old approach', diff_or_content: 'bar', tradeoff: '' },
    ],
    pattern_signature: 'sig-test',
    created_at: new Date('2026-05-09T00:00:00Z'),
    ...overrides,
  };
}

describe('CliAdapter', () => {
  let adapter: CliAdapter;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    adapter = new CliAdapter();
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  });

  afterEach(() => {
    console.log = origLog;
  });

  test('renderProposal includes proposal id and subject', async () => {
    await adapter.renderProposal(makeProposal());
    const output = logs.join('\n');
    expect(output).toContain('#42');
    expect(output).toContain('skills');
  });

  test('renderProposal includes target path', async () => {
    await adapter.renderProposal(makeProposal());
    expect(logs.join('\n')).toContain('/home/simon/agent/skills/test.md');
  });

  test('renderProposal lists alternatives', async () => {
    await adapter.renderProposal(makeProposal());
    const output = logs.join('\n');
    expect(output).toContain('Use new approach');
    expect(output).toContain('Keep old approach');
  });

  test('renderProposal shows tradeoff when present', async () => {
    await adapter.renderProposal(makeProposal());
    expect(logs.join('\n')).toContain('Faster');
  });

  test('renderApplyConfirmation includes alternativeId and proposalId', async () => {
    await adapter.renderApplyConfirmation(makeProposal(), 'A');
    expect(logs.join('\n')).toContain('A');
    expect(logs.join('\n')).toContain('42');
  });
});
