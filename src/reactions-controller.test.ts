import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateStatusReactionController = vi.hoisted(() =>
  vi.fn(() => ({
    setQueued: vi.fn(),
    setThinking: vi.fn(),
    setTool: vi.fn(),
    setCompacting: vi.fn(),
    setDone: vi.fn().mockResolvedValue(undefined),
    setError: vi.fn().mockResolvedValue(undefined),
    cancelPending: vi.fn(),
    clear: vi.fn().mockResolvedValue(undefined),
    restoreInitial: vi.fn().mockResolvedValue(undefined),
  })),
);

const mockSendReaction = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockDeleteReaction = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  DEFAULT_EMOJIS: {
    queued: "👀",
    thinking: "🧠",
    tool: "🛠️",
    coding: "🛠️",
    web: "🛠️",
    deploy: "🛠️",
    build: "🛠️",
    concierge: "🛠️",
    done: "✅",
    error: "❌",
    stallSoft: "⏳",
    stallHard: "⏱️",
    compacting: "🗜️",
  },
  createStatusReactionController: mockCreateStatusReactionController,
}));

vi.mock("./send.js", () => ({
  sendReactionVk: mockSendReaction,
  deleteReactionVk: mockDeleteReaction,
}));

import {
  createVkStatusReactionController,
  VK_DEFAULT_STATUS_REACTION_EMOJIS,
} from "./reactions-controller.js";
import { makeAccount } from "./test-helpers.js";

describe("VK_DEFAULT_STATUS_REACTION_EMOJIS", () => {
  it("overrides every status emoji with a VK-supported reaction", () => {
    // VK only supports a fixed catalog (see mapEmojiToVkReactionId).
    // These are the 16 emojis we accept; anything else falls back to 👍.
    const supported = new Set([
      "❤️", "❤", "🔥", "😂", "🤣", "👍", "💩", "⁉️", "⁉",
      "😭", "😡", "👎", "👌", "😄", "🤔", "🙏", "😘", "😍", "🎉",
    ]);
    for (const [state, emoji] of Object.entries(VK_DEFAULT_STATUS_REACTION_EMOJIS)) {
      expect(supported.has(emoji), `${state} → ${emoji}`).toBe(true);
    }
  });

  it("uses distinct emojis for the key states (queued/thinking/tool/done/error)", () => {
    const { queued, thinking, tool, done, error } = VK_DEFAULT_STATUS_REACTION_EMOJIS;
    expect(new Set([queued, thinking, tool, done, error]).size).toBe(5);
  });
});

describe("createVkStatusReactionController", () => {
  beforeEach(() => {
    mockCreateStatusReactionController.mockClear();
    mockSendReaction.mockClear();
    mockDeleteReaction.mockClear();
  });

  it("wires sendReactionVk / deleteReactionVk into the adapter", async () => {
    const account = makeAccount();
    createVkStatusReactionController({ peerId: 42, cmid: 7, account });

    expect(mockCreateStatusReactionController).toHaveBeenCalledTimes(1);
    const { adapter } = mockCreateStatusReactionController.mock.calls[0][0];

    await adapter.setReaction("🤔");
    expect(mockSendReaction).toHaveBeenCalledWith("42", 7, "🤔", account);

    await adapter.clearReaction!();
    expect(mockDeleteReaction).toHaveBeenCalledWith("42", 7, account);
  });

  it("applies VK_DEFAULT_STATUS_REACTION_EMOJIS by default", () => {
    createVkStatusReactionController({ peerId: 1, cmid: 1, account: makeAccount() });
    const { emojis, initialEmoji } = mockCreateStatusReactionController.mock.calls[0][0];

    expect(emojis.thinking).toBe(VK_DEFAULT_STATUS_REACTION_EMOJIS.thinking);
    expect(emojis.error).toBe(VK_DEFAULT_STATUS_REACTION_EMOJIS.error);
    expect(initialEmoji).toBe(VK_DEFAULT_STATUS_REACTION_EMOJIS.queued);
  });

  it("merges caller emojiOverrides on top of defaults", () => {
    createVkStatusReactionController({
      peerId: 1,
      cmid: 1,
      account: makeAccount(),
      emojiOverrides: { thinking: "🔥", done: "🎉" },
    });
    const { emojis } = mockCreateStatusReactionController.mock.calls[0][0];

    expect(emojis.thinking).toBe("🔥");
    expect(emojis.done).toBe("🎉");
    expect(emojis.error).toBe(VK_DEFAULT_STATUS_REACTION_EMOJIS.error);
  });

  it("passes timing and onError through unchanged", () => {
    const onError = vi.fn();
    const timing = { debounceMs: 500 };
    createVkStatusReactionController({
      peerId: 1,
      cmid: 1,
      account: makeAccount(),
      timing,
      onError,
    });

    const args = mockCreateStatusReactionController.mock.calls[0][0];
    expect(args.timing).toBe(timing);
    expect(args.onError).toBe(onError);
    expect(args.enabled).toBe(true);
  });

  it("honors an explicit initialEmoji override", () => {
    createVkStatusReactionController({
      peerId: 1,
      cmid: 1,
      account: makeAccount(),
      initialEmoji: "🤔",
    });
    expect(mockCreateStatusReactionController.mock.calls[0][0].initialEmoji).toBe("🤔");
  });
});
