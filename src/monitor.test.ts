import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks (for transitive accounts.ts and runtime.ts imports) ────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/account-id", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: (errorMsg: string) => {
    let runtime: unknown;
    return {
      setRuntime: (r: unknown) => { runtime = r; },
      getRuntime: () => {
        if (!runtime) throw new Error(errorMsg);
        return runtime;
      },
    };
  },
}));

import { monitorVkProvider } from "./monitor.js";
import { setVkRuntime } from "./runtime.js";
import {
  createVkRuntimeEnv,
  makeVkRuntime,
} from "./test-helpers.js";
import type { CoreConfig } from "./types.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockUpdatesStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdatesStartPolling = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockUpdatesStop = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdatesOn = vi.hoisted(() => vi.fn());

const mockGroupsGetById = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] }),
);
const mockGroupsGetLongPollServer = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ server: "lp.vk.com", key: "abc", ts: 1 }),
);
const mockMessagesGetById = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ items: [] }),
);
const mockMessagesGetByConversationMessageId = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ items: [] }),
);
const mockMessagesGetHistory = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ items: [] }),
);

vi.mock("vk-io", () => ({
  // Must use a regular function (not an arrow) so `new VK(...)` works.
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        groups: {
          getById: mockGroupsGetById,
          getLongPollServer: mockGroupsGetLongPollServer,
        },
        messages: {
          getById: mockMessagesGetById,
          getByConversationMessageId: mockMessagesGetByConversationMessageId,
          getHistory: mockMessagesGetHistory,
        },
      },
      updates: {
        start: mockUpdatesStart,
        startPolling: mockUpdatesStartPolling,
        stop: mockUpdatesStop,
        on: mockUpdatesOn,
      },
    };
  }),
}));

const mockHandleVkInbound = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("./inbound.js", () => ({ handleVkInbound: mockHandleVkInbound }));

const mockPrimeVkGroupId = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ primeVkGroupId: mockPrimeVkGroupId }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseCfg(): CoreConfig {
  return { channels: { vk: { token: "test-token" } } };
}

/**
 * Start the monitor in the background with an AbortController.
 * monitorVkProvider hangs at waitForAbort() until the signal fires,
 * so we never await it directly — we flush microtasks to let setup complete,
 * then abort to clean up.
 */
function startMonitor(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const promise = monitorVkProvider({
    token: "test-token",
    accountId: "default",
    config: baseCfg(),
    runtime: createVkRuntimeEnv(),
    abortSignal: controller.signal,
    ...overrides,
  } as Parameters<typeof monitorVkProvider>[0]);

  return { promise, controller };
}

/** Drain microtask queue so mocked async operations (start, canUseBotsLongPoll) complete. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Retrieve the handler registered for `message_new` via `vk.updates.on`. */
function getMessageHandler(): (ctx: Record<string, unknown>) => Promise<void> {
  const call = mockUpdatesOn.mock.calls.find(([event]) => event === "message_new");
  if (!call) {
    throw new Error("message_new handler was not registered");
  }
  return call[1] as (ctx: Record<string, unknown>) => Promise<void>;
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    peerId: 555_000,
    senderId: 555_000,
    text: "hello",
    messagePayload: undefined,
    createdAt: 1_700_000_000,
    isOutbox: false,
    ...overrides,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let activeMonitor: { promise: Promise<void>; controller: AbortController } | undefined;

beforeEach(() => {
  mockUpdatesStart.mockReset().mockResolvedValue(undefined);
  mockUpdatesStartPolling.mockReset().mockResolvedValue(undefined);
  mockUpdatesStop.mockReset().mockResolvedValue(undefined);
  mockUpdatesOn.mockReset();
  mockGroupsGetById
    .mockReset()
    .mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] });
  mockGroupsGetLongPollServer
    .mockReset()
    .mockResolvedValue({ server: "lp.vk.com", key: "abc", ts: 1 });
  mockMessagesGetById.mockReset().mockResolvedValue({ items: [] });
  mockMessagesGetByConversationMessageId.mockReset().mockResolvedValue({ items: [] });
  mockMessagesGetHistory.mockReset().mockResolvedValue({ items: [] });
  mockHandleVkInbound.mockReset().mockResolvedValue(undefined);
  mockPrimeVkGroupId.mockReset();
  setVkRuntime(makeVkRuntime());
});

afterEach(async () => {
  if (activeMonitor) {
    activeMonitor.controller.abort();
    await activeMonitor.promise.catch(() => {});
    activeMonitor = undefined;
  }
});

// ── Long Poll mode selection ──────────────────────────────────────────────────

describe("Long Poll mode selection", () => {
  it("uses Bots Long Poll when groups.getLongPollServer succeeds", async () => {
    activeMonitor = startMonitor();
    await flush();

    expect(mockGroupsGetById).toHaveBeenCalled();
    expect(mockPrimeVkGroupId).toHaveBeenCalledWith("test-token", 12345678);
    expect(mockGroupsGetLongPollServer).toHaveBeenCalledWith({
      group_id: 12345678,
    });
    expect(mockUpdatesStart).toHaveBeenCalledOnce();
    expect(mockUpdatesStartPolling).not.toHaveBeenCalled();
  });

  it("falls back to User Long Poll when getLongPollServer throws", async () => {
    mockGroupsGetLongPollServer.mockRejectedValueOnce(
      new Error("Access denied: no access to call this method"),
    );

    activeMonitor = startMonitor();
    await flush();

    expect(mockPrimeVkGroupId).toHaveBeenCalledWith("test-token", 12345678);
    expect(mockUpdatesStart).not.toHaveBeenCalled();
    expect(mockUpdatesStartPolling).toHaveBeenCalledOnce();
  });

  it("falls back to User Long Poll when groups array is empty", async () => {
    mockGroupsGetById.mockResolvedValueOnce({ groups: [] });

    activeMonitor = startMonitor();
    await flush();

    expect(mockUpdatesStart).not.toHaveBeenCalled();
    expect(mockUpdatesStartPolling).toHaveBeenCalledOnce();
  });

  it("falls back to User Long Poll when getById throws", async () => {
    mockGroupsGetById.mockRejectedValueOnce(new Error("network error"));

    activeMonitor = startMonitor();
    await flush();

    expect(mockUpdatesStart).not.toHaveBeenCalled();
    expect(mockUpdatesStartPolling).toHaveBeenCalledOnce();
  });
});

// ── Abort signal & stop ───────────────────────────────────────────────────────

describe("stop/abort", () => {
  it("abort signal calls updates.stop()", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    expect(mockUpdatesStop).not.toHaveBeenCalled();
    controller.abort();
    await promise;

    expect(mockUpdatesStop).toHaveBeenCalledOnce();
  });

  it("does not call stop twice on repeated abort", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    controller.abort();
    await promise;

    // The finally block already called stopUpdates; a second abort should be a no-op.
    expect(mockUpdatesStop).toHaveBeenCalledOnce();
  });
});

// ── message_new handler ───────────────────────────────────────────────────────

describe("message_new handler", () => {
  it("registers a message_new event handler", async () => {
    activeMonitor = startMonitor();
    await flush();

    const events = mockUpdatesOn.mock.calls.map(([event]) => event);
    expect(events).toContain("message_new");
  });

  it("calls handleVkInbound with correct payload on incoming message", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({
        id: 99,
        conversationMessageId: 42,
        peerId: 123_456,
        senderId: 555_000,
        text: "hi",
        messagePayload: { oc: "/models anthropic" },
      }),
    );

    expect(mockHandleVkInbound).toHaveBeenCalledOnce();
    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message).toMatchObject({
      messageId: "99",
      conversationMessageId: 42,
      peerId: 123_456,
      senderId: 555_000,
      text: "hi",
      isGroup: false,
      messagePayload: { oc: "/models anthropic" },
      timestamp: 1_700_000_000_000,
    });
  });

  it("propagates attachments, reply context, and VK timestamps", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({
        id: 100,
        createdAt: 1_700_000_123,
        attachments: [{ type: "photo", largeSizeUrl: "https://example.com/photo.png" }],
        replyMessage: { id: 7, text: "quoted" },
      }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message).toMatchObject({
      timestamp: 1_700_000_123_000,
      attachments: [
        {
          type: "photo",
          kind: "image",
          url: "https://example.com/photo.png",
        },
      ],
      replyToMessageId: "7",
      replyToText: "quoted",
    });
  });

  it("normalizes vk-io style document image attachments from preview photos", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({
        attachments: [
          {
            get type() {
              return "doc";
            },
            get isImage() {
              return true;
            },
            get ext() {
              return "heic";
            },
            get preview() {
              return {
                photo: [{ url: "https://example.com/phone-photo-preview" }],
              };
            },
          },
        ],
      }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.attachments).toEqual([
      {
        type: "doc",
        kind: "image",
        url: "https://example.com/phone-photo-preview",
        title: undefined,
        mimeType: "image/heic",
      },
    ]);
  });

  it("sets isGroup=true for group chat peer IDs (>= 2_000_000_000)", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({ peerId: 2_000_000_001, senderId: 555_000 }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.isGroup).toBe(true);
  });

  it("skips outbox messages", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(makeCtx({ isOutbox: true }));

    expect(mockHandleVkInbound).not.toHaveBeenCalled();
  });

  it("coerces missing text to empty string", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(makeCtx({ text: undefined }));

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.text).toBe("");
  });

  it("keeps location-only messages visible via geo fallback", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({
        text: "",
        hasGeo: true,
        geo: {
          coordinates: "37.815848 55.916704",
          place: {
            title: "Королёв",
            city: "Россия",
          },
        },
      }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.text).toBe("[VK location] 55.916704, 37.815848 (Королёв, Россия)");
    expect(message.geo).toEqual({
      latitude: 55.916704,
      longitude: 37.815848,
      placeTitle: "Королёв",
      city: "Россия",
    });
  });

  it("fetches geo from messages.getHistory when context itself has no geo", async () => {
    activeMonitor = startMonitor();
    await flush();

    mockMessagesGetById.mockResolvedValueOnce({ items: [] });
    mockMessagesGetHistory.mockResolvedValueOnce({
      items: [
        {
          id: 42,
          from_id: 555_000,
          text: "",
          geo: {
            coordinates: "37.815848 55.916704",
          },
        },
      ],
    });

    await getMessageHandler()(makeCtx({ text: "", hasGeo: true }));

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(mockMessagesGetById).toHaveBeenCalledWith({ message_ids: 42 });
    expect(mockMessagesGetHistory).toHaveBeenCalledWith({
      peer_id: 555_000,
      count: 10,
    });
    expect(message.text).toBe("[VK location] 55.916704, 37.815848");
    expect(message.geo).toEqual({
      latitude: 55.916704,
      longitude: 37.815848,
      placeTitle: undefined,
      city: undefined,
    });
  });

  it("does not call geo enrichment APIs for ordinary text-only messages", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(makeCtx({ text: "just text", hasGeo: false, geo: undefined }));

    expect(mockMessagesGetById).not.toHaveBeenCalled();
    expect(mockMessagesGetByConversationMessageId).not.toHaveBeenCalled();
    expect(mockMessagesGetHistory).not.toHaveBeenCalled();
  });

  it("preserves conversationMessageId for downstream status reactions", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(makeCtx({ conversationMessageId: 777 }));

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.conversationMessageId).toBe(777);
  });

  it("records inbound activity before dispatching", async () => {
    const core = makeVkRuntime();
    setVkRuntime(core);

    activeMonitor = startMonitor();
    await flush();
    await getMessageHandler()(makeCtx());

    expect(vi.mocked(core.channel.activity.record)).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "vk", direction: "inbound" }),
    );
  });

  it("does not dispatch messages after abort", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    controller.abort();
    await promise;

    await getMessageHandler()(makeCtx());

    expect(mockHandleVkInbound).not.toHaveBeenCalled();
  });

  it("catches and logs handler errors without propagating", async () => {
    const runtime = createVkRuntimeEnv();
    const errorSpy = vi.spyOn(runtime, "error").mockImplementation(() => {});

    mockHandleVkInbound.mockRejectedValueOnce(new Error("dispatch failed"));

    activeMonitor = startMonitor({ runtime });
    await flush();

    // Should not throw
    await getMessageHandler()(makeCtx({ peerId: 999 }));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("dispatch failed"),
    );
  });

  it("falls back to Date.now() when createdAt is missing", async () => {
    activeMonitor = startMonitor();
    await flush();

    const before = Date.now();
    await getMessageHandler()(makeCtx({ createdAt: undefined }));
    const after = Date.now();

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });

  it("falls back to Date.now() when createdAt is NaN", async () => {
    activeMonitor = startMonitor();
    await flush();

    const before = Date.now();
    await getMessageHandler()(makeCtx({ createdAt: NaN }));
    const after = Date.now();

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });

  it("reloads config for each message (gets fresh account state)", async () => {
    const core = makeVkRuntime();
    setVkRuntime(core);

    activeMonitor = startMonitor();
    await flush();
    await getMessageHandler()(makeCtx());

    expect(vi.mocked(core.config.loadConfig)).toHaveBeenCalled();
  });

  it("handles messages without attachments or replyMessage", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({ attachments: undefined, replyMessage: undefined }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.attachments).toEqual([]);
    expect(message.replyToMessageId).toBeUndefined();
    expect(message.replyToText).toBeUndefined();
  });
});
