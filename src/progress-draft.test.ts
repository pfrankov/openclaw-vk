import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateCompositor = vi.hoisted(() =>
  vi.fn((params: Record<string, unknown>) => ({
    __params: params,
    markFinalReplyStarted: vi.fn(),
    markFinalReplyDelivered: vi.fn(),
  })),
);
const mockSendMessage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "55", chatId: "42" }),
);
const mockEditMessage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockDeleteMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  // Progress label resolution: mirrors the core contract ("auto"/false plus a
  // default label list) so the draft label can be asserted.
  resolveChannelProgressDraftConfig: (entry: any) => ({
    ...(entry?.streaming?.progress ?? {}),
    labels: entry?.streaming?.progress?.labels ?? ["⏳ Работаю"],
  }),
  createChannelProgressDraftCompositor: mockCreateCompositor,
}));

// Draft writes are traced through the channel diagnostics, which need the host.
vi.mock("./diagnostics.js", () => ({ vkDiag: vi.fn() }));

vi.mock("./send.js", () => ({
  sendMessageVk: mockSendMessage,
  editMessageVk: mockEditMessage,
  deleteMessageVk: mockDeleteMessage,
}));

import {
  createVkProgressDraftCompositor,
  resolveVkProgressLabel,
} from "./progress-draft.js";
import { makeAccount } from "./test-helpers.js";

function make(overrides: Record<string, unknown> = {}) {
  return createVkProgressDraftCompositor({
    to: "42",
    account: makeAccount(),
    accountId: "default",
    entry: { channels: { vk: {} } } as never,
    mode: "progress",
    seed: "turn-1",
    ...overrides,
  });
}

function capturedParams() {
  return mockCreateCompositor.mock.calls[0]?.[0] as {
    mode: string;
    seed: string;
    active: boolean;
    update: unknown;
    deleteCurrent: unknown;
  };
}

describe("createVkProgressDraftCompositor", () => {
  beforeEach(() => {
    mockCreateCompositor.mockClear();
    mockSendMessage.mockReset().mockResolvedValue({ messageId: "55", chatId: "42" });
    mockEditMessage.mockReset().mockResolvedValue(true);
    mockDeleteMessage.mockReset().mockResolvedValue(undefined);
  });

  it("wires entry/mode/seed and the update/deleteCurrent primitives into the core compositor", () => {
    make();
    expect(mockCreateCompositor).toHaveBeenCalledTimes(1);
    const p = capturedParams();
    expect(p.mode).toBe("progress");
    expect(p.seed).toBe("turn-1");
    expect(p.active).toBe(true);
    expect(typeof p.update).toBe("function");
    expect(typeof p.deleteCurrent).toBe("function");
  });

  it("creates the draft with sendMessageVk on first render, then edits in place", async () => {
    const handle = make();
    expect(handle.currentMessageId()).toBeUndefined();

    await handle.overwrite("🛠️ Bash");
    expect(mockSendMessage).toHaveBeenCalledWith("42", "🛠️ Bash", {
      cfg: undefined,
      accountId: "default",
    });
    expect(handle.currentMessageId()).toBe(55);

    await handle.overwrite("🛠️ Bash\n🔎 Web Search");
    expect(mockEditMessage).toHaveBeenCalledWith(
      "42",
      55,
      "🛠️ Bash\n🔎 Web Search",
      expect.anything(),
    );
    // The draft is edited, not re-sent.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to a fresh send when an in-place edit fails", async () => {
    const handle = make();
    await handle.overwrite("a"); // send → id 55
    mockEditMessage.mockResolvedValueOnce(false);
    await handle.overwrite("b"); // edit fails → forget the id
    expect(handle.currentMessageId()).toBeUndefined();
    await handle.overwrite("c"); // sends a fresh draft
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("deletes the old draft before starting a fresh one when an edit fails", async () => {
    const handle = make();
    await handle.overwrite("a"); // send → id 55
    mockEditMessage.mockResolvedValueOnce(false);
    await handle.overwrite("b"); // edit fails → the stale message must not stay behind
    expect(mockDeleteMessage).toHaveBeenCalledWith("42", 55, expect.anything());
    mockEditMessage.mockRejectedValueOnce(new Error("VK API error 909"));
    mockSendMessage.mockResolvedValueOnce({ messageId: "56", chatId: "42" });
    await handle.overwrite("c"); // fresh draft → id 56
    await handle.overwrite("d"); // edit throws → deleted too
    expect(mockDeleteMessage).toHaveBeenCalledWith("42", 56, expect.anything());
  });

  it("stops drafting for the turn when a send returns no usable message id", async () => {
    const handle = make();
    mockSendMessage.mockResolvedValueOnce({ messageId: "0", chatId: "42" });
    expect(await handle.overwrite("шаг 1")).toBe(false);
    // The message went out but cannot be edited or deleted: no second one per step.
    expect(await handle.overwrite("шаг 2")).toBe(false);
    expect(await handle.overwrite("шаг 3")).toBe(false);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockEditMessage).not.toHaveBeenCalled();
  });

  it("removes the draft via deleteMessageVk and clears the id", async () => {
    const handle = make();
    await handle.overwrite("a");
    await handle.remove();
    expect(mockDeleteMessage).toHaveBeenCalledWith("42", 55, expect.anything());
    expect(handle.currentMessageId()).toBeUndefined();
  });

  it("detach keeps the message and starts the next render as a new draft", async () => {
    const handle = make();
    await handle.overwrite("часть ответа"); // send → id 55
    handle.detach();
    expect(handle.currentMessageId()).toBeUndefined();
    await handle.remove(); // nothing of ours to delete any more
    expect(mockDeleteMessage).not.toHaveBeenCalled();
    mockSendMessage.mockResolvedValueOnce({ messageId: "56", chatId: "42" });
    await handle.overwrite("следующая часть");
    expect(mockEditMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(handle.currentMessageId()).toBe(56);
  });

  it("quotes on the first draft message only, and only when asked to", async () => {
    const quoting = make({ replyTo: "777" });
    await quoting.overwrite("шаг 1"); // send → id 55, quoted
    await quoting.overwrite("шаг 2"); // edit, no send
    quoting.detach();
    mockSendMessage.mockResolvedValueOnce({ messageId: "56", chatId: "42" });
    await quoting.overwrite("продолжение"); // a continuation below: no quote
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[0]?.[2]).toMatchObject({ replyTo: "777" });
    expect(mockSendMessage.mock.calls[1]?.[2]).not.toHaveProperty("replyTo");

    mockSendMessage.mockClear();
    await make().overwrite("личка");
    expect(mockSendMessage.mock.calls[0]?.[2]).not.toHaveProperty("replyTo");
  });

  it("keeps the quote for the next draft when the first send failed", async () => {
    const handle = make({ replyTo: "777" });
    mockSendMessage.mockRejectedValueOnce(new Error("VK API error 10"));
    expect(await handle.overwrite("шаг 1")).toBe(false);
    await handle.overwrite("шаг 1");
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[1]?.[2]).toMatchObject({ replyTo: "777" });
  });

  it("remove is a no-op when there is no draft yet", async () => {
    const handle = make();
    await handle.remove();
    expect(mockDeleteMessage).not.toHaveBeenCalled();
  });

  it("routes send failures to onError without throwing", async () => {
    const onError = vi.fn();
    mockSendMessage.mockRejectedValueOnce(new Error("boom"));
    const handle = make({ onError });
    await handle.overwrite("a");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(handle.currentMessageId()).toBeUndefined();
  });

  it("overwrite becomes a no-op after close() so no stray message is sent", async () => {
    const handle = make();
    await handle.overwrite("a"); // sends → id 55
    handle.close();
    await handle.overwrite("b"); // sealed: neither edit nor send
    expect(mockEditMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("resolveVkProgressLabel", () => {
  it("prefixes an explicit label", () => {
    expect(resolveVkProgressLabel({ streaming: { progress: { label: "⏳ Работаю" } } })).toBe(
      "⏳ Работаю",
    );
  });

  it("does not print `auto` as a header", () => {
    // "auto" tells the core to pick a label; reading the raw value used to put
    // the literal string at the top of every draft.
    expect(resolveVkProgressLabel({ streaming: { progress: { label: "auto" } } })).toBeUndefined();
  });

  it("honours `label: false`", () => {
    // `false` means "hide the title" in the core contract; the raw reader had no
    // way to express it.
    expect(resolveVkProgressLabel({ streaming: { progress: { label: false } } })).toBeUndefined();
  });

  it("adds nothing when no label is configured", () => {
    expect(resolveVkProgressLabel(undefined)).toBeUndefined();
    expect(resolveVkProgressLabel({ streaming: {} })).toBeUndefined();
  });
});
