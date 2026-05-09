import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TelegramAdapter } from '../../src/adapters/telegram.js';
import type { Proposal } from '../../src/core/types.js';
import type { CallbackPayload } from '../../src/adapters/base.js';

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

type FetchCall = { url: string; body: Record<string, unknown> };

function mockFetch(statusOk = true): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ url: url.toString(), body });
    return {
      ok: statusOk,
      status: statusOk ? 200 : 400,
      text: async () => statusOk ? 'ok' : 'Bad Request',
    } as Response;
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

describe('TelegramAdapter', () => {
  test('renderProposal POSTs to sendMessage', async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new TelegramAdapter({ botToken: 'tok123', chatId: '999', baseUrl: 'http://mock' });
      await adapter.renderProposal(makeProposal());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain('/sendMessage');
      expect(calls[0]!.url).toContain('tok123');
    } finally { restore(); }
  });

  test('renderProposal includes inline_keyboard with alternatives', async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new TelegramAdapter({ botToken: 'tok', chatId: '1', baseUrl: 'http://mock' });
      await adapter.renderProposal(makeProposal());
      const body = calls[0]!.body;
      const keyboard = (body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
      expect(keyboard).toHaveLength(2);
      expect((keyboard[0] as unknown[]).length).toBe(2); // A and B alternatives
      const firstRow = keyboard[0] as Array<{ callback_data: string }>;
      expect(firstRow[0]!.callback_data).toBe('apply:42:A');
    } finally { restore(); }
  });

  test('renderProposal includes Refuse and Edit buttons', async () => {
    const { calls, restore } = mockFetch();
    try {
      const adapter = new TelegramAdapter({ botToken: 'tok', chatId: '1', baseUrl: 'http://mock' });
      await adapter.renderProposal(makeProposal());
      const keyboard = (calls[0]!.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
      const lastRow = keyboard[1] as Array<{ callback_data: string }>;
      expect(lastRow.some(b => b.callback_data === 'refuse:42')).toBe(true);
      expect(lastRow.some(b => b.callback_data === 'edit:42')).toBe(true);
    } finally { restore(); }
  });

  test('renderProposal throws on HTTP error', async () => {
    const { restore } = mockFetch(false);
    try {
      const adapter = new TelegramAdapter({ botToken: 'tok', chatId: '1', baseUrl: 'http://mock' });
      await expect(adapter.renderProposal(makeProposal())).rejects.toThrow('failed');
    } finally { restore(); }
  });

  test('handleCallback parses apply action and calls handler', async () => {
    const received: CallbackPayload[] = [];
    const adapter = new TelegramAdapter({
      botToken: 'tok', chatId: '1',
      callbackHandler: async (p) => { received.push(p); },
      allowedUserIds: [123],
    });
    await adapter.handleCallback('apply:42:A', 123);
    expect(received).toHaveLength(1);
    expect(received[0]!.proposalId).toBe(42);
    expect(received[0]!.alternativeId).toBe('A');
    expect(received[0]!.action).toBe('apply');
  });

  test('handleCallback rejects unauthorized user', async () => {
    const adapter = new TelegramAdapter({ botToken: 'tok', chatId: '1', allowedUserIds: [123] });
    await expect(adapter.handleCallback('apply:42:A', 999)).rejects.toThrow('not in allowedUserIds');
  });

  test('handleCallback handles refuse callback (no alternativeId)', async () => {
    const received: CallbackPayload[] = [];
    const adapter = new TelegramAdapter({
      botToken: 'tok', chatId: '1',
      callbackHandler: async (p) => { received.push(p); },
    });
    await adapter.handleCallback('refuse:42', 0);
    expect(received[0]!.action).toBe('refuse');
    expect(received[0]!.alternativeId).toBeUndefined();
  });
});
