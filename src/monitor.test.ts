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

import { monitorVkProvider, readPollingCursor } from "./monitor.js";
// VK импортируется значением (не типом): тесты политики watchdog перенастраивают
// мок транспорта, чтобы двигать курсор и переключать isStarted.
import { VK } from "vk-io";
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

vi.mock("vk-io", () => ({
  // Must use a regular function (not an arrow) so `new VK(...)` works.
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        groups: {
          getById: mockGroupsGetById,
          getLongPollServer: mockGroupsGetLongPollServer,
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

describe("readPollingCursor", () => {
  const vkWith = (ts: unknown): VK =>
    ({ updates: { pollingTransport: { ts } } }) as unknown as VK;

  it("reads a numeric ts (User Long Poll) as a string", () => {
    expect(readPollingCursor(vkWith(5))).toBe("5");
  });

  it("reads a string ts (Bots Long Poll) — primary liveness path engages", () => {
    // Regression guard for finding #1: VK's groups.getLongPollServer returns
    // `ts` as a JSON string ("9"), and vk-io stores it unchanged. The old
    // numeric-only check dropped it, so in Bots LP mode the cursor was always
    // unreadable and the watchdog silently degraded to the fallback probe.
    expect(readPollingCursor(vkWith("9"))).toBe("9");
  });

  it("treats an empty string ts as unreadable", () => {
    expect(readPollingCursor(vkWith(""))).toBeUndefined();
  });

  it("returns undefined when ts is missing or the transport is absent", () => {
    expect(readPollingCursor(vkWith(undefined))).toBeUndefined();
    expect(readPollingCursor({ updates: {} } as unknown as VK)).toBeUndefined();
    expect(readPollingCursor({} as unknown as VK)).toBeUndefined();
  });
});

// ── Watchdog liveness policy (end-to-end over the supervision loop) ──────────
//
// The unit tests above cover how the cursor is READ; these cover what the
// watchdog DOES with it. That distinction matters: the policy was rewritten
// after an upstream audit (a static cursor used to imply a restart, which would
// tear down perfectly healthy idle channels), and nothing guarded the new
// state transitions — a regression there is invisible until VK ingress either
// dies silently or flaps in production.
describe("monitorVkProvider — watchdog liveness policy", () => {
  const WATCHDOG_TICK_MS = 30_000;
  const IDLE_BEFORE_PROBE_MS = 90_000;

  /** Drives the supervision loop `ticks` watchdog intervals forward. */
  async function advanceTicks(ticks: number) {
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS);
      await flush();
    }
  }

  /** Makes the mocked transport report a given cursor and started state. */
  function transport(ts: unknown, isStarted = true) {
    const updates = {
      start: mockUpdatesStart,
      startPolling: mockUpdatesStartPolling,
      stop: mockUpdatesStop,
      on: mockUpdatesOn,
      isStarted,
      pollingTransport: { ts },
    };
    (VK as unknown as { mockImplementation: (f: () => unknown) => void })
      .mockImplementation(function () {
        return {
          api: {
            groups: {
              getById: mockGroupsGetById,
              getLongPollServer: mockGroupsGetLongPollServer,
            },
          },
          updates,
        };
      });
    return updates;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a moving string cursor as proof of life and never probes", async () => {
    // Bots Long Poll delivers `ts` as a string; a cursor that advances means the
    // poll loop is delivering events, so the token must not be probed at all.
    const updates = transport("100");
    const { controller, promise } = startMonitor();
    await flush();
    mockGroupsGetById.mockClear();

    for (let i = 1; i <= 6; i++) {
      updates.pollingTransport.ts = String(100 + i);
      await advanceTicks(1);
    }

    expect(mockGroupsGetById).not.toHaveBeenCalled();
    expect(mockUpdatesStop).not.toHaveBeenCalled();
    controller.abort();
    await promise;
  });

  it("keeps a quiet channel alive for an hour while probes succeed", async () => {
    // A static cursor is ambiguous — an idle chat looks exactly like a wedged
    // poll loop. As long as the token answers, quiet must never cost a restart.
    transport("42");
    const { controller, promise } = startMonitor();
    await flush();
    mockUpdatesStop.mockClear();
    mockGroupsGetById.mockClear();

    await advanceTicks(120); // an hour of silence

    expect(mockGroupsGetById.mock.calls.length).toBeGreaterThan(0); // probed
    expect(mockUpdatesStop).not.toHaveBeenCalled(); // but never restarted
    controller.abort();
    await promise;
  });

  it("restarts only after repeated probe failures", async () => {
    transport("42");
    const { controller, promise } = startMonitor();
    await flush();
    mockUpdatesStop.mockClear();
    mockGroupsGetById.mockClear();
    mockGroupsGetById.mockRejectedValue(new Error("network down"));

    // One failed probe is not enough — a single hiccup must not tear down VK.
    await advanceTicks(IDLE_BEFORE_PROBE_MS / WATCHDOG_TICK_MS + 1);
    expect(mockUpdatesStop).not.toHaveBeenCalled();

    // Three consecutive failures mean a real outage → restart in place.
    await advanceTicks(20);
    expect(mockGroupsGetById.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(mockUpdatesStop).toHaveBeenCalled();

    mockGroupsGetById.mockResolvedValue({
      groups: [{ id: 12345678, name: "Test Group" }],
    });
    controller.abort();
    await promise;
  });

  it("treats an unreadable cursor like a static one, not as a failure", async () => {
    // Cursor unreadable (transport shape changed, empty ts, …) → same policy:
    // probe, and restart only if the probe itself keeps failing.
    transport(undefined);
    const { controller, promise } = startMonitor();
    await flush();
    mockUpdatesStop.mockClear();
    mockGroupsGetById.mockClear();

    await advanceTicks(20);

    expect(mockGroupsGetById.mock.calls.length).toBeGreaterThan(0);
    expect(mockUpdatesStop).not.toHaveBeenCalled();
    controller.abort();
    await promise;
  });

  it("restarts immediately when the transport reports isStarted=false", async () => {
    // The poller stopped outright — no ambiguity here, no need to wait or probe.
    transport("42", false);
    const { controller, promise } = startMonitor();
    await flush();
    mockUpdatesStop.mockClear();

    await advanceTicks(1);

    expect(mockUpdatesStop).toHaveBeenCalled();
    controller.abort();
    await promise;
  });
});
