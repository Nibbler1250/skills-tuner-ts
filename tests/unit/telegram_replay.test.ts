import { describe, test, expect } from "bun:test";
import { TelegramAdapter } from "../../src/adapters/telegram.js";

describe("TelegramAdapter replay attack prevention", () => {
  test("callback replay — verifyProposalFn returning false prevents second apply", async () => {
    let callCount = 0;
    let handlerCallCount = 0;

    // First call returns true (proposal is still pending), second returns false (already applied)
    const verifyProposalFn = async (proposalId: number): Promise<boolean> => {
      callCount++;
      return callCount === 1; // true on first, false on second
    };

    const callbackHandler = async (cb: { proposalId: number; alternativeId?: string; action: string }) => {
      handlerCallCount++;
    };

    const adapter = new TelegramAdapter({
      botToken: "fake-token",
      chatId: "12345",
      allowedUserIds: [99999],
      verifyProposalFn,
      callbackHandler,
    });

    // First call — should succeed (verifyProposalFn returns true)
    await adapter.handleCallback("apply:1:A", 99999);
    expect(handlerCallCount).toBe(1);

    // Second call with same data — should throw (verifyProposalFn returns false)
    await expect(adapter.handleCallback("apply:1:A", 99999)).rejects.toThrow(
      /verifyProposalFn rejected proposal 1/
    );
    expect(handlerCallCount).toBe(1); // handler NOT called again
  });

  test("unauthorized user is rejected before verifyProposalFn is called", async () => {
    let verifyCalled = false;
    const verifyProposalFn = async (_id: number) => {
      verifyCalled = true;
      return true;
    };

    const adapter = new TelegramAdapter({
      botToken: "fake-token",
      chatId: "12345",
      allowedUserIds: [99999],
      verifyProposalFn,
    });

    await expect(adapter.handleCallback("apply:1:A", 11111)).rejects.toThrow(
      /not in allowedUserIds/
    );
    // verifyProposalFn should not be called for unauthorized users
    expect(verifyCalled).toBe(false);
  });

  test("malformed callback data is rejected", async () => {
    const adapter = new TelegramAdapter({
      botToken: "fake-token",
      chatId: "12345",
      allowedUserIds: [99999],
    });

    await expect(adapter.handleCallback("bad", 99999)).rejects.toThrow(/malformed/);
    await expect(adapter.handleCallback("apply:notanumber:A", 99999)).rejects.toThrow(/invalid proposalId/);
    await expect(adapter.handleCallback("unknown:1:A", 99999)).rejects.toThrow(/unknown action/);
  });

  test("verifyProposalFn is called with correct proposalId", async () => {
    const verifiedIds: number[] = [];
    const verifyProposalFn = async (id: number) => {
      verifiedIds.push(id);
      return true;
    };

    const adapter = new TelegramAdapter({
      botToken: "fake-token",
      chatId: "12345",
      allowedUserIds: [99999],
      verifyProposalFn,
    });

    await adapter.handleCallback("apply:42:B", 99999);
    expect(verifiedIds).toEqual([42]);
  });

  test("refuse action also goes through verifyProposalFn", async () => {
    let verifiedId: number | null = null;
    const verifyProposalFn = async (id: number) => {
      verifiedId = id;
      return true;
    };

    const adapter = new TelegramAdapter({
      botToken: "fake-token",
      chatId: "12345",
      allowedUserIds: [99999],
      verifyProposalFn,
    });

    await adapter.handleCallback("refuse:7", 99999);
    expect(verifiedId).toBe(7);
  });
});
