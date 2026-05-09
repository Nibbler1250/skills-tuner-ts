import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PlusEventAdapter } from '../../src/adapters/plus_event.js';
import type { Proposal } from '../../src/core/types.js';

function makeProposal(): Proposal {
  return {
    id: 7, cluster_id: 'c1', subject: 'voice', kind: 'patch',
    target_path: '/tmp/test.md',
    alternatives: [{ id: 'A', label: 'fix', diff_or_content: '', tradeoff: '' }],
    pattern_signature: 'sig-7',
    created_at: new Date(),
  };
}

describe('PlusEventAdapter', () => {
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  });
  afterEach(() => { console.log = origLog; });

  test('renderProposal logs proposal id and subject', async () => {
    const adapter = new PlusEventAdapter();
    await adapter.renderProposal(makeProposal());
    expect(logs.join('\n')).toContain('#7');
    expect(logs.join('\n')).toContain('voice');
  });

  test('renderProposal logs target URL', async () => {
    const adapter = new PlusEventAdapter('http://plus:3000');
    await adapter.renderProposal(makeProposal());
    expect(logs.join('\n')).toContain('http://plus:3000');
  });

  test('renderApplyConfirmation logs alt id', async () => {
    const adapter = new PlusEventAdapter();
    await adapter.renderApplyConfirmation(makeProposal(), 'A');
    expect(logs.join('\n')).toContain('alt=A');
  });
});
