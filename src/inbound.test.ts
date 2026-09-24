import { beforeEach, describe, expect, it, vi } from "vitest";
import { WallAttachment } from "vk-io";

// ── SDK mocks ────────────────────────────────────────────────────────────────

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactIdentifier: (value?: string) => `sha256:${String(value ?? "-").length}`,
  redactSensitiveText: (text: string) => text,
}));

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
      setRuntime: (value: unknown) => {
        runtime = value;
      },
      getRuntime: () => {
        if (!runtime) {
          throw new Error(errorMsg);
        }
        return runtime;
      },
    };
  },
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingController: ({ core, channel, accountId }: Record<string, unknown>) => {
    const upsertPairingRequest = (params: Record<string, unknown>) =>
      (core as any).channel.pairing.upsertPairingRequest({ channel, accountId, ...params });

    return {
      readStoreForDmPolicy: (provider: string, targetAccountId: string) =>
        (core as any).channel.pairing.readAllowFromStore({
          channel: provider,
          accountId: targetAccountId,
        }),
      upsertPairingRequest,
      issueChallenge: async ({
        buildReplyText,
        meta,
        onCreated,
        onReplyError,
        sendPairingReply,
        senderId,
        senderIdLine,
      }: Record<string, any>) => {
        const result = await upsertPairingRequest({ id: senderId, meta });
        if (!result.created) {
          return { created: false };
        }

        onCreated?.({ code: result.code });
        const replyText =
          buildReplyText?.({ code: result.code, senderIdLine }) ??
          (core as any).channel.pairing.buildPairingReply({
            channel,
            idLine: senderIdLine,
            code: result.code,
          });
        try {
          await sendPairingReply(replyText);
        } catch (err) {
          onReplyError?.(err);
        }
        return { created: true, code: result.code };
      },
    };
  },
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  logInboundDrop: vi.fn(),
  toInboundMediaFacts: (media: Array<Record<string, unknown>> = [], defaults: Record<string, unknown> = {}) =>
    media.map((entry) => ({
      ...entry,
      messageId: entry.messageId ?? defaults.messageId,
    })),
}));

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
  DEFAULT_TIMING: {
    debounceMs: 250,
    stallSoftMs: 10000,
    stallHardMs: 30000,
    doneHoldMs: 1500,
    errorHoldMs: 2500,
  },
  createStatusReactionController: vi.fn(() => ({
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
}));

vi.mock("openclaw/plugin-sdk/channel-policy", () => ({
  readStoreAllowFromForDmPolicy: async ({ readStore }: Record<string, any>) =>
    readStore ? await readStore() : [],
  resolveEffectiveAllowFromLists: ({
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
  }: Record<string, unknown[]>) => ({
    effectiveAllowFrom: [...(allowFrom ?? []), ...(storeAllowFrom ?? [])],
    effectiveGroupAllowFrom: [...(groupAllowFrom ?? [])],
  }),
}));

// Faithful to the core (`reply-payload`): a supplement is recognised only when it
// carries spoken text AND media, and the "already delivered" flag survives only
// when it is literally true. A looser stub would let the tests below pass while
// the plugin still deleted the draft.
vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  getReplyPayloadTtsSupplement: (payload: {
    ttsSupplement?: { spokenText?: string; visibleTextAlreadyDelivered?: boolean };
    mediaUrl?: string;
    mediaUrls?: string[];
  }) => {
    const spokenText = payload?.ttsSupplement?.spokenText?.trim();
    const hasMedia = Boolean(payload?.mediaUrl || payload?.mediaUrls?.length);
    if (!spokenText || !hasMedia) {
      return undefined;
    }
    return {
      spokenText,
      ...(payload.ttsSupplement?.visibleTextAlreadyDelivered === true
        ? { visibleTextAlreadyDelivered: true }
        : {}),
    };
  },
}));

vi.mock("openclaw/plugin-sdk/command-auth-native", () => ({
  resolveControlCommandGate: vi.fn(() => ({
    shouldBlock: false,
    commandAuthorized: false,
  })),
}));

vi.mock("openclaw/plugin-sdk/runtime-group-policy", () => ({
  resolveAllowlistProviderRuntimeGroupPolicy: ({ groupPolicy }: Record<string, unknown>) => ({
    groupPolicy: groupPolicy ?? "open",
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: () => "open",
  GROUP_POLICY_BLOCKED_LABEL: { channel: "blocked" },
  warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

const mockCreateReplyPrefixOptions = vi.hoisted(() => vi.fn());
const mockCreateTypingCallbacks = vi.hoisted(() => vi.fn());
const mockLogTypingFailure = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  resolveChannelPreviewStreamMode: mockResolveStreamMode,
  // Return the raw input as the "line" so tests can assert what was built.
  buildChannelProgressDraftLineForEntry: (_entry: unknown, input: unknown) => input,
  // The core decides whether a final is truncated and which text wins. Mirrors
  // the core (channel-outbound): only a final that ends in an ellipsis after at
  // least 48 characters counts as truncated, and only a candidate that extends
  // it by a real continuation wins — an empty final never selects anything.
  isPotentialTruncatedFinal: (text: string) => {
    const trimmed = text.trimEnd();
    const untruncated = trimmed.replace(/(?<!\s)(?:\s*(?:\.{3}|\u2026))+$/u, "").trimEnd();
    return untruncated.length >= 48 && untruncated !== trimmed;
  },
  selectLongerFinalText: ({
    finalText,
    candidateTexts,
  }: {
    finalText: string;
    candidateTexts: readonly (string | undefined)[];
  }) => {
    const final = finalText.trimEnd();
    const untruncated = final.replace(/(?<!\s)(?:\s*(?:\.{3}|\u2026))+$/u, "").trimEnd();
    if (untruncated.length < 48 || untruncated === final) return undefined;
    for (const candidate of candidateTexts) {
      const text = candidate?.trimEnd();
      if (!text || text.length <= final.length || !text.startsWith(untruncated)) continue;
      const continuation = text.slice(untruncated.length).trimStart();
      if (continuation.length >= 24 && /^[\p{L}\p{N}]/u.test(continuation)) return text;
    }
    return undefined;
  },
  createReplyPrefixOptions: mockCreateReplyPrefixOptions,
  createTypingCallbacks: mockCreateTypingCallbacks,
  logTypingFailure: mockLogTypingFailure,
}));

// Mirrors the core (2026.9.4, context-visibility): "all" shows everything, an allowed
// sender is always shown, "allowlist_quote" also shows quotes.
vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  evaluateSupplementalContextVisibility: (p: { mode: string; kind: string; senderAllowed: boolean }) =>
    p.mode === "all"
      ? { include: true, reason: "mode_all" }
      : p.senderAllowed
        ? { include: true, reason: "sender_allowed" }
        : p.mode === "allowlist_quote" && p.kind === "quote"
          ? { include: true, reason: "quote_override" }
          : { include: false, reason: "blocked" },
}));

// Step-progress: default mode "off" keeps the existing (reactions/plain) paths;
// individual tests flip resolveChannelPreviewStreamMode to "progress".
const mockResolveStreamMode = vi.hoisted(() => vi.fn(() => "off"));
const mockProgressCompositor = vi.hoisted(() => ({
  noteActivity: vi.fn().mockResolvedValue(true),
  pushToolProgress: vi.fn().mockResolvedValue(true),
  pushReasoningProgress: vi.fn().mockResolvedValue(true),
  markFinalReplyStarted: vi.fn(),
  markFinalReplyDelivered: vi.fn(),
  cancel: vi.fn(),
}));
// currentMessageId defaults to undefined (no live draft); the edit-into-answer
// test overrides it to a number to exercise the single-bubble finalize.
const mockCurrentMessageId = vi.hoisted(() => vi.fn<() => number | undefined>(() => undefined));
const mockDraftRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDraftClose = vi.hoisted(() => vi.fn());
// `overwrite` resolves to whether the text made it into the draft; shared so a
// test can make one write fail.
const mockDraftOverwrite = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockCreateVkProgressDraft = vi.hoisted(() =>
  vi.fn(() => ({
    compositor: mockProgressCompositor,
    currentMessageId: mockCurrentMessageId,
    overwrite: mockDraftOverwrite,
    remove: mockDraftRemove,
    // Like the real handle: the message is let go of, nothing is deleted.
    detach: vi.fn(() => mockCurrentMessageId.mockReturnValue(undefined)),
    close: mockDraftClose,
  })),
);

vi.mock("./progress-draft.js", () => ({
  // The label resolver lives in the same module — the mock keeps the real config
  // parsing, otherwise the test would never check that the label comes from
  // settings at all.
  // Takes the channel entry now, not the whole config: the label is resolved
  // through the core, which reads the same entry the compositor is given.
  resolveVkProgressLabel: (entry: any) => {
    const label = entry?.streaming?.progress?.label;
    return typeof label === "string" && label.trim() && label.trim() !== "auto"
      ? label.trim()
      : undefined;
  },
  createVkProgressDraftCompositor: mockCreateVkProgressDraft,
}));

// ── Internal module mocks ────────────────────────────────────────────────────

const mockSendPayloadVk = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "1", chatId: "0" }),
);
const mockMarkMessageReadVk = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendTypingVk = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockEditMessageVk = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockResolveVkOwnGroup = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 239104331, name: "Карамелька" }),
);

vi.mock("./send.js", () => ({
  markMessageReadVk: mockMarkMessageReadVk,
  sendPayloadVk: mockSendPayloadVk,
  sendTypingVk: mockSendTypingVk,
  // editMessageVk backs the edit-in-place finalize.
  editMessageVk: mockEditMessageVk,
  sendMessageVk: vi.fn().mockResolvedValue({ messageId: "9", chatId: "0" }),
  // No markdown attachments in these tests; the real parser is exercised in
  // inbound.draft.sdk.test.ts.
  splitVkMarkdownAttachments: (text: string) => ({ text, attachments: [] }),
  resolveVkOwnGroup: mockResolveVkOwnGroup,
}));

import { resolveVkAccount } from "./accounts.js";
import { extractVkInboundAttachments } from "./media.js";
import { handleVkInbound } from "./inbound.js";
import { setVkRuntime } from "./runtime.js";
import {
  createVkRuntimeEnv,
  makeAccount,
  makeMessage,
  makeVkRuntime,
} from "./test-helpers.js";
import type { CoreConfig } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SENDER_ID = 555_000;
const GROUP_PEER_ID = 2_000_000_001;
const PREFIX_OPTIONS = {
  responsePrefix: undefined,
  enableSlackInteractiveReplies: undefined,
  responsePrefixContextProvider: vi.fn().mockReturnValue({}),
  onModelSelected: vi.fn(),
};

function baseCfg(vkOverrides: Record<string, unknown> = {}): CoreConfig {
  return { channels: { vk: { token: "tok", ...vkOverrides } } };
}

function installRuntime(opts: Parameters<typeof makeVkRuntime>[0] = {}) {
  const runtime = makeVkRuntime(opts);
  setVkRuntime(runtime);
  return runtime;
}

function getDispatchCall(runtime: ReturnType<typeof makeVkRuntime>) {
  const call = vi
    .mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
    .mock
    .calls[0]?.[0];
  if (!call) {
    throw new Error("dispatchReplyWithBufferedBlockDispatcher was not called");
  }
  return call;
}

beforeEach(() => {
  mockMarkMessageReadVk.mockReset().mockResolvedValue(undefined);
  mockSendPayloadVk.mockReset().mockResolvedValue({ messageId: "1", chatId: "0" });
  mockSendTypingVk.mockReset().mockResolvedValue(undefined);
  mockResolveStreamMode.mockReset().mockReturnValue("off");
  mockCreateVkProgressDraft.mockClear();
  mockCurrentMessageId.mockReset().mockReturnValue(undefined);
  mockDraftRemove.mockClear();
  mockDraftClose.mockClear();
  mockDraftOverwrite.mockReset().mockResolvedValue(true);
  mockEditMessageVk.mockReset().mockResolvedValue(true);
  mockProgressCompositor.noteActivity.mockClear();
  mockProgressCompositor.pushToolProgress.mockClear();
  mockProgressCompositor.pushReasoningProgress.mockClear();
  mockProgressCompositor.markFinalReplyStarted.mockClear();
  mockProgressCompositor.markFinalReplyDelivered.mockClear();
  mockProgressCompositor.cancel.mockClear();
  PREFIX_OPTIONS.responsePrefixContextProvider.mockReset().mockReturnValue({});
  PREFIX_OPTIONS.onModelSelected.mockReset();
  mockCreateReplyPrefixOptions.mockReset().mockReturnValue(PREFIX_OPTIONS);
  mockCreateTypingCallbacks.mockReset().mockImplementation(({ start }) => ({
    onReplyStart: vi.fn(async () => {
      await start();
    }),
    onIdle: vi.fn(),
    onCleanup: vi.fn(),
  }));
  mockLogTypingFailure.mockReset();
  installRuntime();
});

// ── Empty body ────────────────────────────────────────────────────────────────

describe("empty message body", () => {
  it("drops message with empty text immediately", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ text: "" }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
  });

  it("drops message with whitespace-only text when payload does not override it", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ text: "   \n  " }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
  });
});

// ── DM access control ─────────────────────────────────────────────────────────

describe("DM access control", () => {
  it("drops DM when dmPolicy=disabled", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "disabled" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
  });

  it("dispatches DM when dmPolicy=open", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.channel.session.recordInboundSession)).toHaveBeenCalledOnce();
  });

  it("dispatches DM when sender is in allowFrom list", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [SENDER_ID],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("drops DM when sender is not in allowFrom list", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [999_999],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
  });

  it("issues pairing challenge to unknown sender when dmPolicy=pairing", async () => {
    const upsertPairingRequest = vi
      .fn()
      .mockResolvedValue({ code: "PAIR99", created: true });

    const runtime = installRuntime({ upsertPairingRequest });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "vk",
        id: String(SENDER_ID),
        accountId: "default",
      }),
    );
    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      { text: "pairing-reply-text" },
      { accountId: "default" },
    );
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
    expect(mockSendTypingVk).not.toHaveBeenCalled();
  });

  it("scopes pairing request and reply to a named account", async () => {
    const accountId = "support";
    const upsertPairingRequest = vi
      .fn()
      .mockResolvedValue({ code: "PAIR42", created: true });

    installRuntime({ upsertPairingRequest });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        accountId,
        config: { dmPolicy: "pairing", allowFrom: [] },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "vk",
        accountId,
        id: String(SENDER_ID),
      }),
    );
    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      { text: "pairing-reply-text" },
      { accountId },
    );
  });

  it("does not re-send pairing challenge when request already exists", async () => {
    const upsertPairingRequest = vi
      .fn()
      .mockResolvedValue({ code: "PAIR99", created: false });

    const runtime = installRuntime({ upsertPairingRequest });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
  });

  it("dispatches DM when allowFrom contains wildcard '*'", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: 999_999, peerId: 999_999 }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["*"],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("dispatches DM when sender matches via vk: prefix in allowFrom", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [`vk:${SENDER_ID}`],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("dispatches DM when sender is in the pairing store", async () => {
    const runtime = installRuntime({
      readAllowFromStore: vi.fn().mockResolvedValue([String(SENDER_ID)]),
    });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });
});

// ── Group access control ──────────────────────────────────────────────────────

describe("group access control", () => {
  it("drops group message when groupPolicy=disabled", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "disabled" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("dispatches group message when groupPolicy=open", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("dispatches group message when sender is in groupAllowFrom", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
          groupAllowFrom: [SENDER_ID],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("drops group message when sender is not in groupAllowFrom", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
          groupAllowFrom: [999_999],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("drops group message when the group is explicitly disabled", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: {
            [String(GROUP_PEER_ID)]: { enabled: false },
          },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("uses per-group allowFrom override instead of the account-wide group allowlist", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
          groupAllowFrom: [999_999],
          groups: {
            [String(GROUP_PEER_ID)]: { allowFrom: [SENDER_ID] },
          },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });
});

// ── Mention gating ────────────────────────────────────────────────────────────

describe("group mention gating", () => {
  it("drops group message when requireMention=true and bot was not mentioned", async () => {
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/\@bot/i]),
      matchesMentionPatterns: vi.fn().mockReturnValue(false),
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "hi everyone",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("dispatches group message when requireMention=true and bot was mentioned", async () => {
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/\@bot/i]),
      matchesMentionPatterns: vi.fn().mockReturnValue(true),
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "@bot help",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("dispatches group message when requireMention=false regardless of mention", async () => {
    const runtime = installRuntime({
      matchesMentionPatterns: vi.fn().mockReturnValue(false),
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "no mention here",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("uses per-group config before wildcard config", async () => {
    const runtime = installRuntime({
      matchesMentionPatterns: vi.fn().mockReturnValue(false),
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "message without mention",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: {
            "*": { requireMention: true },
            [String(GROUP_PEER_ID)]: { requireMention: false },
          },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });
});

// ── Dispatch payload ──────────────────────────────────────────────────────────

describe("dispatch payload", () => {
  it("uses hidden OpenClaw command payload instead of visible button text", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "OpenAI",
        messagePayload: { oc: "/models openai" },
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "OpenAI",
        BodyForAgent: "/models openai",
        CommandBody: "/models openai",
      }),
    );
  });

  it("starts typing before dispatch and passes callbacks into reply dispatch", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockCreateReplyPrefixOptions).toHaveBeenCalledWith({
      cfg: baseCfg(),
      agentId: "default",
      channel: "vk",
      accountId: "default",
    });

    const dispatchCall = getDispatchCall(runtime);
    const typingCallbacks = dispatchCall.dispatcherOptions.typingCallbacks as
      | { onReplyStart: unknown }
      | undefined;
    const onReplyStart = dispatchCall.dispatcherOptions.onReplyStart as (() => Promise<void>) | undefined;
    expect(typingCallbacks?.onReplyStart).toBeTypeOf("function");
    expect(onReplyStart).toBeTypeOf("function");
    expect(dispatchCall.dispatcherOptions.typingCallbacks).toBe(
      mockCreateTypingCallbacks.mock.results[0]?.value,
    );

    expect(mockSendTypingVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      expect.objectContaining({ accountId: "default" }),
    );

    const callsBeforeSecondStart = mockSendTypingVk.mock.calls.length;
    await onReplyStart?.();
    expect(mockSendTypingVk).toHaveBeenCalledTimes(callsBeforeSecondStart);
  });

  it("marks the inbound message as read before dispatching", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        messageId: "77",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockMarkMessageReadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      "77",
      expect.objectContaining({ accountId: "default" }),
    );

    expect(mockMarkMessageReadVk.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("removes reply ids from ordinary direct replies without stripping channelData", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({
          text: "Providers:",
          replyToId: "77",
          channelData: {
            vk: {
              buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
            },
          },
        });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      {
        text: "Providers:",
        channelData: {
          vk: {
            buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
          },
        },
      },
      { accountId: "default" },
    );
  });

  it("quotes the inbound message in group replies", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "Group reply" });
      },
    );

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: GROUP_PEER_ID,
        messageId: "group-77",
        isGroup: true,
      }),
      account: makeAccount({ config: { groupPolicy: "open", requireMention: false } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(GROUP_PEER_ID),
      { text: "Group reply", replyToId: "group-77" },
      { accountId: "default" },
    );
  });

  it("clears the old keyboard after a button-triggered final reply with no new choices", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver(
          {
            text: "Thinking level set to high.",
          },
          { kind: "final" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "high",
        messagePayload: { oc: "/think high" },
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      {
        text: "Thinking level set to high.",
        replyToId: "msg-1",
      },
      { accountId: "default", clearKeyboard: true },
    );
  });

  it("keeps the keyboard when a button-triggered final reply still has choices", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver(
          {
            text: [
              "Current thinking level: high.",
              "Options: off, minimal, low, medium, high, adaptive.",
            ].join("\n"),
          },
          { kind: "final" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "high",
        messagePayload: { oc: "/think high" },
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      {
        text: [
          "Current thinking level: high.",
          "Options: off, minimal, low, medium, high, adaptive.",
        ].join("\n"),
        replyToId: "msg-1",
      },
      { accountId: "default" },
    );
  });

  it("dispatches attachment-only messages with media placeholders and media context", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          {
            type: "photo",
            kind: "image",
            url: "https://example.com/photo.png",
            title: "photo.png",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        media: [
          expect.objectContaining({
            url: "https://example.com/photo.png",
            kind: "image",
            messageId: "msg-1",
          }),
        ],
      }),
    );
  });

  it("preserves attachment MIME types in ordered media facts", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          {
            type: "doc",
            kind: "image",
            url: "https://example.com/phone-photo",
            mimeType: "image/heic",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        media: [
          expect.objectContaining({
            url: "https://example.com/phone-photo",
            contentType: "image/heic",
            kind: "image",
            messageId: "msg-1",
          }),
        ],
      }),
    );
  });

  it("adds the local path when inbound media is materialized", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.media.fetchRemoteMedia).mockResolvedValueOnce({
      buffer: Buffer.from("heic"),
      contentType: "image/heic",
    } as Awaited<ReturnType<typeof runtime.channel.media.fetchRemoteMedia>>);
    vi.mocked(runtime.channel.media.saveMediaBuffer).mockResolvedValueOnce({
      path: "/tmp/openclaw/media/inbound/IMG_0001.HEIC",
      contentType: "image/heic",
      size: 4,
      name: "IMG_0001.HEIC",
    } as Awaited<ReturnType<typeof runtime.channel.media.saveMediaBuffer>>);

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          {
            type: "doc",
            kind: "image",
            url: "https://example.com/phone-photo",
            title: "IMG_0001.HEIC",
            mimeType: "image/heic",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        media: [
          expect.objectContaining({
            path: "/tmp/openclaw/media/inbound/IMG_0001.HEIC",
            url: "https://example.com/phone-photo",
            contentType: "image/heic",
            kind: "image",
            messageId: "msg-1",
          }),
        ],
      }),
    );
  });

  it("preserves media order for multi-photo messages", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          { type: "photo", kind: "image", url: "https://example.com/1.jpg" },
          { type: "photo", kind: "image", url: "https://example.com/2.jpg" },
          { type: "photo", kind: "image", url: "https://example.com/3.jpg" },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [
          expect.objectContaining({ url: "https://example.com/1.jpg", kind: "image" }),
          expect.objectContaining({ url: "https://example.com/2.jpg", kind: "image" }),
          expect.objectContaining({ url: "https://example.com/3.jpg", kind: "image" }),
        ],
      }),
    );
  });

  it("uses text as body when message has both text and attachments", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "Look at this photo",
        attachments: [
          { type: "photo", kind: "image", url: "https://example.com/photo.jpg" },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "Look at this photo",
        BodyForAgent: "Look at this photo",
        media: [
          expect.objectContaining({
            url: "https://example.com/photo.jpg",
            kind: "image",
            messageId: "msg-1",
          }),
        ],
      }),
    );
  });

  it("preserves mixed attachment kinds in ordered media facts", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          { type: "photo", kind: "image", url: "https://example.com/pic.jpg" },
          { type: "doc", kind: "document", url: "https://example.com/file.pdf" },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [
          expect.objectContaining({ url: "https://example.com/pic.jpg", kind: "image" }),
          expect.objectContaining({ url: "https://example.com/file.pdf", kind: "document" }),
        ],
      }),
    );
  });

  it("omits media facts when message has no attachments", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "plain text",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        media: undefined,
      }),
    );
  });

  it("includes reply metadata in the inbound context", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        replyToMessageId: "77",
        replyToText: "quoted reply",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "77",
        ReplyToIdFull: "77",
        ReplyToBody: "quoted reply",
      }),
    );
  });

  it.each([
    ["the bot itself, the way Telegram marks it", -239104331, {}, "Карамелька (you)"],
    ["the bot under its configured name", -239104331, { name: "Помощник" }, "Помощник (you)"],
    ["another community by id", -142153191, {}, "vk:-142153191"],
    ["a person by id", SENDER_ID, {}, `vk:${SENDER_ID}`],
  ])("labels the author of a quote: %s", async (_case, replyToSenderId, accountFields, label) => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        replyToMessageId: "9723",
        replyToText: "ответ",
        replyToSenderId,
      }),
      account: makeAccount({ ...accountFields, config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(lastInboundContext(runtime).ReplyToSender).toBe(label);
  });

  it("sets ChatType=direct for DM messages", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, isGroup: false }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({ ChatType: "direct" }),
    );
  });

  it("sets ChatType=group for group messages", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({ ChatType: "group" }),
    );
  });

  it("records inbound activity before dispatching", async () => {
    const runtime = installRuntime();
    const statusSink = vi.fn();
    const message = makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID });

    await handleVkInbound({
      message,
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
      statusSink,
    });

    const statusUpdate = statusSink.mock.calls[0]?.[0] as { lastInboundAt?: number } | undefined;
    expect(statusUpdate?.lastInboundAt).toBeTypeOf("number");
    expect(statusUpdate!.lastInboundAt).toBe(message.timestamp);
    expect(vi.mocked(runtime.channel.session.recordInboundSession)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.channel.session.recordInboundSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SessionKey: "vk:123456",
        }),
      }),
    );
  });

  it("passes GroupSystemPrompt from per-group config", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { [String(GROUP_PEER_ID)]: { systemPrompt: "Be concise." } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: "Be concise.",
      }),
    );
  });

  it("passes WasMentioned=true when mention is detected in group", async () => {
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/@bot/i]),
      matchesMentionPatterns: vi.fn().mockReturnValue(true),
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "@bot hello",
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        WasMentioned: true,
      }),
    );
  });

  it("tolerates markRead failure without blocking dispatch", async () => {
    const runtime = installRuntime();
    const runtimeEnv = createVkRuntimeEnv();
    const logSpy = vi.spyOn(runtimeEnv, "log").mockImplementation(() => {});
    mockMarkMessageReadVk.mockRejectedValueOnce(new Error("markRead failed"));

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: runtimeEnv,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("mark read failed"),
    );
    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("logs typing failures via logTypingFailure", async () => {
    installRuntime();
    mockSendTypingVk.mockRejectedValueOnce(new Error("typing error"));
    mockCreateTypingCallbacks.mockReset().mockImplementation(({ start, onStartError }) => ({
      onReplyStart: vi.fn(async () => {
        try {
          await start();
        } catch (err) {
          onStartError?.(err);
        }
      }),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    }));

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockLogTypingFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "vk",
        target: String(SENDER_ID),
      }),
    );
  });

  it("logs pairing reply errors without crashing", async () => {
    const runtimeEnv = createVkRuntimeEnv();
    const errorSpy = vi.spyOn(runtimeEnv, "error").mockImplementation(() => {});
    mockSendPayloadVk.mockRejectedValueOnce(new Error("send failed"));

    installRuntime({
      upsertPairingRequest: vi.fn().mockResolvedValue({ code: "X", created: true }),
    });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: runtimeEnv,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pairing reply failed"),
    );
  });
});

// ── Command gating ──────────────────────────────────────────────────────────

describe("command gating", () => {
  it("drops group message when command gate blocks unauthorized control command", async () => {
    const { resolveControlCommandGate } = await import("openclaw/plugin-sdk/command-auth-native");
    vi.mocked(resolveControlCommandGate).mockReturnValueOnce({
      shouldBlock: true,
      commandAuthorized: false,
    });

    const runtime = installRuntime({ hasControlCommand: true });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "/admin reset",
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("does not block DM messages even when command gate blocks", async () => {
    const { resolveControlCommandGate } = await import("openclaw/plugin-sdk/command-auth-native");
    vi.mocked(resolveControlCommandGate).mockReturnValueOnce({
      shouldBlock: true,
      commandAuthorized: false,
    });

    const runtime = installRuntime({ hasControlCommand: true });

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "/admin reset",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });
});

// ── Step-progress draft ──────────────────────────────────────────────────────

describe("step-progress (channels.vk.streaming.mode=progress)", () => {
  it("routes execution steps to the edit-in-place draft and finalizes on the last block", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions, replyOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "Bash" });
        await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    // A draft compositor was created and fed by the execution steps.
    expect(mockCreateVkProgressDraft).toHaveBeenCalledTimes(1);
    // The step is rendered from a built line (not undefined) and shown at once.
    expect(mockProgressCompositor.pushToolProgress).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool", name: "Bash" }),
      expect.objectContaining({ toolName: "Bash", startImmediately: true }),
    );
    // The final answer still flows through the normal deliver path…
    expect(mockSendPayloadVk).toHaveBeenCalled();
    // …bracketed by the compositor's finalize signals.
    expect(mockProgressCompositor.markFinalReplyStarted).toHaveBeenCalledTimes(1);
    expect(mockProgressCompositor.markFinalReplyDelivered).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft when the final carries no text but the draft already holds the answer", async () => {
    // Some models deliver the answer text as a block along the way, so it lands
    // in the draft, and then send an empty final (voice only). Deleting the draft
    // there leaves the recipient with no text at all. Models that put the whole
    // text in the final never hit this.
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockDraftRemove.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        // The answer arrives as a block and lands in the draft…
        await dispatcherOptions.deliver({ text: "вот полный ответ" }, { kind: "block" });
        // …while the final carries only the voice message, no text.
        await dispatcherOptions.deliver(
          { text: "", mediaUrl: "/tmp/voice.ogg" },
          { kind: "final" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    // The draft stays: it is the answer.
    expect(mockDraftRemove).not.toHaveBeenCalled();
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("keeps the fuller draft when the final arrives truncated", async () => {
    // The old test was `!finalText` — a final that is present but plainly cut
    // short still lost the fuller answer along with the draft. The core decides
    // both questions now: whether the final looks truncated, and which text wins.
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockEditMessageVk.mockClear();
    mockDraftRemove.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(async ({ dispatcherOptions }: any) => {
      await dispatcherOptions.onReplyStart?.();
      await dispatcherOptions.deliver(
        { text: "полный ответ, который сложился из блоков по ходу работы" },
        { kind: "block" },
      );
      await dispatcherOptions.deliver({ text: "   " }, { kind: "final" });
    });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).not.toHaveBeenCalled();
    expect(mockEditMessageVk).toHaveBeenCalledWith(
      expect.anything(),
      4242,
      expect.stringContaining("сложился из блоков"),
      expect.anything(),
      expect.anything(),
    );
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  // ── Voice supplement must not decide the draft's fate ─────────────────────
  // The core follows a delivered answer with a SECOND final that carries only
  // audio and no text, marked `visibleTextAlreadyDelivered`. Read as an ordinary
  // final, its empty text means "no answer came" and the draft holding the answer
  // is deleted, and the recipient is left with a picture plus a voice note and
  // no text at all.
  const voiceSupplement = (spokenText = "полный ответ, который уже отправлен") => ({
    mediaUrl: "/tmp/speech.opus",
    audioAsVoice: true,
    ttsSupplement: { spokenText, visibleTextAlreadyDelivered: true },
  });

  it("keeps the draft holding the answer when a voice supplement follows", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockDraftRemove.mockClear();
    mockEditMessageVk.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions, replyOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "Bash" });
        await dispatcherOptions.deliver(
          { text: "вот график, который ты просил", mediaUrl: "/tmp/chart.png" },
          { kind: "final" },
        );
        await dispatcherOptions.deliver(voiceSupplement(), { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).not.toHaveBeenCalled();
    // Both attachments still reach the person: the picture and then its voice.
    const sent = JSON.stringify(mockSendPayloadVk.mock.calls);
    expect(sent).toContain("/tmp/speech.opus");
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("keeps the draft when a supplement follows an answer without a picture", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockDraftRemove.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions, replyOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "Bash" });
        await dispatcherOptions.deliver({ text: "ответ целиком" }, { kind: "final" });
        await dispatcherOptions.deliver(voiceSupplement(), { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).not.toHaveBeenCalled();
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("delivers the voice supplement when there is no draft at all", async () => {
    mockResolveStreamMode.mockReturnValue("off");
    mockDraftRemove.mockClear();
    mockSendPayloadVk.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "ответ" }, { kind: "final" });
        await dispatcherOptions.deliver(voiceSupplement(), { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "off" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).not.toHaveBeenCalled();
    expect(JSON.stringify(mockSendPayloadVk.mock.calls)).toContain("/tmp/speech.opus");
  });

  it("keeps the draft even after the accumulated block text was reset by a tool step", async () => {
    // A tool step wipes `draftAnswerText`, so by the time the
    // supplement arrives the plugin has no accumulated answer of its own — which
    // is exactly the state in which it used to delete the draft.
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(8416);
    mockDraftRemove.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions, replyOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await dispatcherOptions.deliver({ text: "начало работы" }, { kind: "block" });
        await replyOptions.onToolStart?.({ name: "Bash" });
        await dispatcherOptions.deliver(
          { text: "итог с картинкой", mediaUrl: "/tmp/chart.png" },
          { kind: "final" },
        );
        await dispatcherOptions.deliver(voiceSupplement(), { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).not.toHaveBeenCalled();
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("lets the draft keep the fuller answer when a truncated final is followed by a supplement", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockDraftRemove.mockClear();
    mockEditMessageVk.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await dispatcherOptions.deliver(
          { text: "полный ответ, который сложился из блоков по ходу работы" },
          { kind: "block" },
        );
        await dispatcherOptions.deliver({ text: "   " }, { kind: "final" });
        await dispatcherOptions.deliver(voiceSupplement(), { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).not.toHaveBeenCalled();
    expect(mockEditMessageVk).toHaveBeenCalledWith(
      expect.anything(),
      4242,
      expect.stringContaining("сложился из блоков"),
      expect.anything(),
      expect.anything(),
    );
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("still drops the draft when an empty final is NOT marked as a supplement", async () => {
    // The guard is the mark, not the empty text: an ordinary media-only final
    // with nothing kept in the draft still drops it, exactly as before.
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockDraftRemove.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions, replyOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "Bash" });
        await dispatcherOptions.deliver(
          { mediaUrl: "/tmp/speech.opus", audioAsVoice: true },
          { kind: "final" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).toHaveBeenCalled();
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("survives several voice supplements in a row", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockDraftRemove.mockClear();
    mockSendPayloadVk.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions, replyOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "Bash" });
        await dispatcherOptions.deliver(
          { text: "две картинки", mediaUrl: "/tmp/a.png" },
          { kind: "final" },
        );
        await dispatcherOptions.deliver(voiceSupplement("первая часть"), { kind: "final" });
        await dispatcherOptions.deliver(voiceSupplement("вторая часть"), { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).not.toHaveBeenCalled();
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("sends the block the usual way when the draft write fails", async () => {
    // `overwrite` reports the outcome instead of throwing, so a failed VK edit
    // has to be checked. Missing that left the person with nothing at all on a
    // blocks-plus-empty-final turn: the block went into a draft that was never
    // written, and the final carried no text of its own.
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(4242);
    mockDraftOverwrite.mockResolvedValueOnce(false);
    mockSendPayloadVk.mockClear();
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await dispatcherOptions.deliver({ text: "ответ блоком" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    // The block reached the person as an ordinary message rather than vanishing.
    expect(mockSendPayloadVk).toHaveBeenCalled();
    const sentText = JSON.stringify(mockSendPayloadVk.mock.calls);
    expect(sentText).toContain("ответ блоком");
    mockCurrentMessageId.mockReturnValue(undefined);
  });

  it("builds no draft when streaming mode is off (default reactions/plain path)", async () => {
    mockResolveStreamMode.mockReturnValue("off");
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockCreateVkProgressDraft).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("runs reactions AND the step draft together when both are enabled (Telegram parity)", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    const { createStatusReactionController } = await import(
      "openclaw/plugin-sdk/channel-feedback"
    );
    const mockStatusReactionCtrl = {
      setQueued: vi.fn(),
      setThinking: vi.fn(),
      setTool: vi.fn(),
      setCompacting: vi.fn(),
      setDone: vi.fn().mockResolvedValue(undefined),
      setError: vi.fn().mockResolvedValue(undefined),
      cancelPending: vi.fn(),
      clear: vi.fn().mockResolvedValue(undefined),
      restoreInitial: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createStatusReactionController).mockReturnValueOnce(mockStatusReactionCtrl as never);
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reactions.shouldAckReaction).mockReturnValue(true);
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ replyOptions }: any) => {
        await replyOptions.onToolStart?.({ name: "Bash" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: {
        ...baseCfg({ streaming: { mode: "progress" } }),
        messages: { statusReactions: { enabled: true }, ackReactionScope: "all" },
      } as CoreConfig,
      runtime: createVkRuntimeEnv(),
    });

    // Both controllers exist and the single onToolStart fans out to each.
    expect(mockCreateVkProgressDraft).toHaveBeenCalledTimes(1);
    expect(mockStatusReactionCtrl.setTool).toHaveBeenCalledWith("Bash");
    expect(mockProgressCompositor.pushToolProgress).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool", name: "Bash" }),
      expect.objectContaining({ toolName: "Bash", startImmediately: true }),
    );
  });

  it("edits the live draft INTO the final answer (single bubble) for a plain text reply", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(555); // a live draft exists
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "The answer." }, { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    // The draft message is edited into the answer; no separate reply is sent.
    expect(mockEditMessageVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      555,
      "The answer.",
      expect.anything(),
      expect.anything(),
    );
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
    expect(mockProgressCompositor.markFinalReplyDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to a normal reply when the draft edit fails (answer never lost)", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(555);
    mockEditMessageVk.mockResolvedValue(false); // edit fails
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "The answer." }, { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDraftRemove).toHaveBeenCalled();
    expect(mockSendPayloadVk).toHaveBeenCalled();
  });

  it("sends an intermediate block with a picture as its own message, labelled", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(777);
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver(
          { text: "Кадр 38, проба 1", mediaUrl: "https://example/frame.jpg" },
          { kind: "block" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 9 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({
        streaming: { mode: "progress", progress: { label: "⏳ Работаю" } },
      }),
      runtime: createVkRuntimeEnv(),
    });

    // A picture cannot go into the draft, so such a chunk goes as its own
    // message — the label keeps it from looking like a finished answer.
    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining("⏳ Работаю"),
        mediaUrl: "https://example/frame.jpg",
      }),
      expect.anything(),
    );
  });

  it("editing into the answer also works for media replies (voice follows separately)", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    mockCurrentMessageId.mockReturnValue(555);
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver(
          { text: "See this", mediaUrl: "https://example/y.jpg" },
          { kind: "final" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    // The progress draft is rewritten with the answer text…
    expect(mockEditMessageVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      555,
      expect.stringContaining("See this"),
      expect.anything(),
      expect.anything(),
    );
    // …and the image or voice message follows as a separate message.
    expect(mockSendPayloadVk).toHaveBeenCalled();
  });
});

// ── Status reaction lifecycle ────────────────────────────────────────────────

describe("status reaction lifecycle", () => {
  async function installStatusController(overrides: Record<string, unknown> = {}) {
    const { createStatusReactionController } = await import(
      "openclaw/plugin-sdk/channel-feedback"
    );
    const controller = {
      setQueued: vi.fn().mockResolvedValue(undefined),
      setThinking: vi.fn().mockResolvedValue(undefined),
      setTool: vi.fn().mockResolvedValue(undefined),
      setCompacting: vi.fn().mockResolvedValue(undefined),
      setDone: vi.fn().mockResolvedValue(undefined),
      setError: vi.fn().mockResolvedValue(undefined),
      cancelPending: vi.fn(),
      clear: vi.fn().mockResolvedValue(undefined),
      restoreInitial: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    vi.mocked(createStatusReactionController).mockReturnValueOnce(controller as never);
    return controller;
  }

  function statusReactionConfig(overrides: Record<string, unknown> = {}): CoreConfig {
    return {
      ...baseCfg(),
      messages: {
        ackReactionScope: "direct",
        statusReactions: {
          enabled: true,
          emojis: { thinking: "🤔" },
          timing: { debounceMs: 0 },
        },
        ...overrides,
      },
    } as unknown as CoreConfig;
  }

  it("maps agent progress to queued, thinking, tool, compaction, and done states", async () => {
    const controller = await installStatusController();
    const runtime = installRuntime();
    const statusSink = vi.fn();
    vi.mocked(runtime.channel.reactions.shouldAckReaction).mockReturnValue(true);
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions, replyOptions }: any) => {
        expect(replyOptions).toEqual(
          expect.objectContaining({
            suppressDefaultToolProgressMessages: true,
            allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          }),
        );
        await dispatcherOptions.onReplyStart();
        await replyOptions.onReasoningStream();
        await replyOptions.onToolStart({ name: "web_search" });
        await replyOptions.onCompactionStart();
        await replyOptions.onCompactionEnd();
        await dispatcherOptions.deliver("invalid core payload", { kind: "partial" });
      },
    );

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        conversationMessageId: 42,
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: statusReactionConfig(),
      runtime: createVkRuntimeEnv(),
      statusSink,
    });

    expect(runtime.channel.reactions.shouldAckReaction).toHaveBeenCalledWith({
      scope: "direct",
      isDirect: true,
      isGroup: false,
      isMentionableGroup: false,
      requireMention: false,
      canDetectMention: true,
      effectiveWasMentioned: false,
    });
    expect(controller.setQueued).toHaveBeenCalledOnce();
    expect(controller.setThinking).toHaveBeenCalledTimes(3);
    expect(controller.setTool).toHaveBeenCalledWith("web_search");
    expect(controller.setCompacting).toHaveBeenCalledOnce();
    expect(controller.cancelPending).toHaveBeenCalledOnce();
    expect(controller.setDone).toHaveBeenCalledOnce();
    expect(controller.setError).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).toHaveBeenCalledWith(String(SENDER_ID), {}, {
      accountId: "default",
    });
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
  });

  it("reports dispatch and reaction cleanup failures while preserving the dispatch error", async () => {
    vi.useFakeTimers();
    try {
      const controller = await installStatusController({
        setError: vi.fn().mockRejectedValue(new Error("final reaction failed")),
        clear: vi.fn().mockRejectedValue(new Error("clear reaction failed")),
      });
      const runtime = installRuntime();
      const runtimeEnv = createVkRuntimeEnv();
      const logSpy = vi.spyOn(runtimeEnv, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(runtimeEnv, "error").mockImplementation(() => {});
      vi.mocked(runtime.channel.reactions.shouldAckReaction).mockReturnValue(true);
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
        async ({ dispatcherOptions }: any) => {
          dispatcherOptions.onError(new Error("delivery failed"), { kind: "final" });
          throw new Error("dispatch failed");
        },
      );

      await expect(
        handleVkInbound({
          message: makeMessage({
            senderId: SENDER_ID,
            peerId: SENDER_ID,
            conversationMessageId: 43,
          }),
          account: makeAccount({ config: { dmPolicy: "open" } }),
          config: statusReactionConfig({ removeAckAfterReply: true }),
          runtime: runtimeEnv,
        }),
      ).rejects.toThrow("dispatch failed");

      expect(errorSpy).toHaveBeenCalledWith("vk final reply failed: Error: delivery failed");
      expect(controller.setError).toHaveBeenCalledOnce();
      expect(controller.setDone).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        "vk: status-reaction finalize failed: Error: final reaction failed",
      );
      expect(controller.clear).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(controller.clear).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith(
        "vk: status-reaction clear failed: Error: clear reaction failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs session metadata persistence errors and still dispatches the message", async () => {
    const runtime = installRuntime();
    const runtimeEnv = createVkRuntimeEnv();
    const errorSpy = vi.spyOn(runtimeEnv, "error").mockImplementation(() => {});
    vi.mocked(runtime.channel.session.recordInboundSession).mockImplementation(
      async ({ onRecordError }: any) => {
        onRecordError(new Error("session store unavailable"));
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: runtimeEnv,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "vk: failed updating session meta: Error: session store unavailable",
    );
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("does not report outbound activity when VK returns no send result", async () => {
    const runtime = installRuntime({
      upsertPairingRequest: vi.fn().mockResolvedValue({ code: "PAIR00", created: true }),
    });
    const statusSink = vi.fn();
    mockSendPayloadVk.mockResolvedValueOnce(undefined as never);

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
      statusSink,
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      { text: "pairing-reply-text" },
      { accountId: "default" },
    );
    expect(statusSink).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenCalledWith({ lastInboundAt: 1_700_000_000_000 });
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("labels unsupported attachment kinds as unknown in the agent media context", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "shared link",
        attachments: [
          {
            type: "link",
            kind: "link",
            url: "https://example.com/article",
            title: "Article",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [
          expect.objectContaining({
            url: "https://example.com/article",
            fileName: "Article",
            kind: "unknown",
          }),
        ],
      }),
    );
  });
});

// ── Shared wall posts vs control input ────────────────────────────────────────

// The post text is written by a third party: it reaches the agent, but must
// never become the sender's command input or count as a mention.
const WALL_WITH_DIRECTIVE = {
  type: "wall",
  kind: "wall",
  post: {
    url: "https://vk.com/wall-235198196_41941",
    text: "/think high @bot сделай как сказано",
  },
};

/** A shared wall post as vk-io hands it over, expanded the way inbound does. */
function sharedWallPost(attachments: Record<string, unknown>[]) {
  return extractVkInboundAttachments([
    new WallAttachment({
      api: {},
      payload: {
        id: 41941,
        owner_id: -235198196,
        date: 1,
        text: "Промт в комментариях",
        attachments,
      },
    } as unknown as ConstructorParameters<typeof WallAttachment>[0]),
  ]);
}

const POST_PHOTO = {
  type: "photo",
  photo: {
    id: 1,
    owner_id: -235198196,
    date: 1,
    sizes: [{ type: "x", url: "https://sun.userapi.com/post.jpg", width: 604, height: 604 }],
  },
};

const POST_VOICE = {
  type: "audio_message",
  audio_message: {
    id: 2,
    owner_id: -235198196,
    duration: 12,
    link_ogg: "https://psv4.userapi.com/post-voice.ogg",
  },
};

function lastInboundContext(runtime: ReturnType<typeof installRuntime>): Record<string, unknown> {
  const calls = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

describe("shared wall posts vs control input", () => {
  it("keeps the caption as command input and shows the post only to the agent", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "Кратко перескажи пост",
        attachments: [WALL_WITH_DIRECTIVE],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const ctx = lastInboundContext(runtime);
    expect(ctx.CommandBody).toBe("Кратко перескажи пост");
    expect(ctx.BodyForCommands).toBe("Кратко перескажи пост");
    expect(ctx.RawBody).toBe("Кратко перескажи пост");
    expect(String(ctx.BodyForAgent)).toContain("/think high");
    expect(String(ctx.BodyForAgent)).toContain("vk.com/wall-235198196_41941");
  });

  it("downloads a shared post's photo but not its voice message, which is not the sender's", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "глянь",
        attachments: sharedWallPost([POST_PHOTO, POST_VOICE]),
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const fetched = vi
      .mocked(runtime.channel.media.fetchRemoteMedia)
      .mock.calls.map(([arg]) => (arg as { url: string }).url);
    expect(fetched).toEqual(["https://sun.userapi.com/post.jpg"]);
    // The agent still gets the post itself — link and text — so it can ask about
    // the recording; what it must not get is the recording transcribed as if the
    // sender had spoken it.
    expect(String(lastInboundContext(runtime).BodyForAgent)).toContain(
      "[VK wall post https://vk.com/wall-235198196_41941]",
    );
  });

  it("still downloads a voice message the sender recorded themselves", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          {
            type: "audio_message",
            kind: "audio",
            url: "https://psv4.userapi.com/own-voice.ogg",
            mimeType: "audio/ogg",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const fetched = vi
      .mocked(runtime.channel.media.fetchRemoteMedia)
      .mock.calls.map(([arg]) => (arg as { url: string }).url);
    expect(fetched).toEqual(["https://psv4.userapi.com/own-voice.ogg"]);
  });

  it("dispatches a post-only message without letting the post become the command", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [WALL_WITH_DIRECTIVE],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const ctx = lastInboundContext(runtime);
    expect(ctx.CommandBody).toBe("<media:wall>");
    expect(ctx.BodyForCommands).toBe("<media:wall>");
    expect(String(ctx.BodyForAgent)).toContain("vk.com/wall-235198196_41941");
    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("does not count a mention inside a shared post as a mention of the bot", async () => {
    const matches = vi.fn((text: string) => /@bot/i.test(text));
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/@bot/i]),
      matchesMentionPatterns: matches,
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "гляньте",
        attachments: [WALL_WITH_DIRECTIVE],
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(matches).toHaveBeenCalledWith("гляньте", expect.anything());
    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("still honours a mention written by the sender when a post is attached", async () => {
    const matches = vi.fn((text: string) => /@bot/i.test(text));
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/@bot/i]),
      matchesMentionPatterns: matches,
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "@bot глянь",
        attachments: [
          { type: "wall", kind: "wall", post: { url: "https://vk.com/wall-1_2", text: "обычный пост" } },
        ],
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
    expect(lastInboundContext(runtime).WasMentioned).toBe(true);
  });

  it("keeps a keyboard payload command as the command input when a post is attached", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        messagePayload: { oc: "/think high" },
        attachments: [WALL_WITH_DIRECTIVE],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const ctx = lastInboundContext(runtime);
    expect(ctx.CommandBody).toBe("/think high");
    expect(ctx.BodyForCommands).toBe("/think high");
  });
});

// ── Forwarded messages ────────────────────────────────────────────────────────

const ORDER_FORWARD = {
  senderId: -142153191,
  timestamp: 1_789_000_000_000,
  text: "Заказ 10316111753 готов к выдаче",
};

describe("forwarded messages", () => {
  it("shows a forward from another sender to the agent, never as command input", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "Вот сообщение пересланое чужое",
        forwards: [ORDER_FORWARD],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const ctx = lastInboundContext(runtime);
    expect(String(ctx.BodyForAgent)).toContain("[Forwarded from vk:-142153191 at 2026-09-10T00:26:40.000Z]");
    expect(String(ctx.BodyForAgent)).toContain("Заказ 10316111753 готов к выдаче");
    expect(ctx.CommandBody).toBe("Вот сообщение пересланое чужое");
    expect(ctx.BodyForCommands).toBe("Вот сообщение пересланое чужое");
    expect(ctx).toMatchObject({
      ForwardedFrom: "vk:-142153191",
      ForwardedFromId: "-142153191",
      ForwardedFromType: "group",
      ForwardedDate: 1_789_000_000_000,
    });
  });

  it("dispatches a message that is only a forward, with a placeholder as command input", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, text: "", forwards: [ORDER_FORWARD] }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
    const ctx = lastInboundContext(runtime);
    expect(ctx.CommandBody).toBe("<forwarded>");
    expect(ctx.BodyForCommands).toBe("<forwarded>");
    expect(String(ctx.BodyForAgent)).toContain("Заказ 10316111753");
  });

  it("does not filter forwards in a direct chat, even with contextVisibility=allowlist", async () => {
    // As in Telegram: the sender of a direct chat already passed allowFrom.
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, text: "смотри", forwards: [ORDER_FORWARD] }),
      account: makeAccount({
        config: { dmPolicy: "allowlist", allowFrom: [String(SENDER_ID)], contextVisibility: "allowlist" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(String(lastInboundContext(runtime).BodyForAgent)).toContain("Заказ 10316111753");
  });

  it("strips a forward from a sender outside the group allowlist, and keeps an allowed one", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "гляньте",
        forwards: [ORDER_FORWARD, { senderId: 777, timestamp: 1_789_000_000_000, text: "от своего" }],
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groupAllowFrom: [String(SENDER_ID), "777"],
          contextVisibility: "allowlist",
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const ctx = lastInboundContext(runtime);
    expect(String(ctx.BodyForAgent)).toContain("от своего");
    expect(String(ctx.BodyForAgent)).not.toContain("Заказ 10316111753");
    expect(ctx.ForwardedFromId).toBe("777");
  });

  it("shows every forward in a group when contextVisibility is not set", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "гляньте",
        forwards: [ORDER_FORWARD],
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open", groupAllowFrom: [String(SENDER_ID)] },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(String(lastInboundContext(runtime).BodyForAgent)).toContain("Заказ 10316111753");
  });

  it("carries the forwards of a quoted message into the reply target", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "что тут?",
        replyToMessageId: "9709",
        replyToText: "Вот сообщение пересланое чужое",
        replyToForwards: [ORDER_FORWARD],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const ctx = lastInboundContext(runtime);
    expect(String(ctx.ReplyToBody)).toContain("Вот сообщение пересланое чужое");
    expect(String(ctx.ReplyToBody)).toContain("[Forwarded from vk:-142153191 at 2026-09-10T00:26:40.000Z]");
    expect(String(ctx.ReplyToBody)).toContain("Заказ 10316111753");
    expect(ctx.CommandBody).toBe("что тут?");
  });

  it("does not download a forwarded voice message, so it is never transcribed as the sender's", async () => {
    const runtime = installRuntime();
    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "послушай",
        forwards: [
          {
            ...ORDER_FORWARD,
            text: "",
            attachments: [
              { type: "audio_message", kind: "audio", url: "https://example.com/voice.ogg", mimeType: "audio/ogg" },
              { type: "photo", kind: "image", url: "https://example.com/fwd.jpg", mimeType: "image/jpeg" },
            ],
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    const fetched = vi.mocked(runtime.channel.media.fetchRemoteMedia).mock.calls.map(([arg]) => (arg as { url: string }).url);
    expect(fetched).toEqual(["https://example.com/fwd.jpg"]);
    // Still shown to the agent, as a placeholder inside the forward.
    expect(String(lastInboundContext(runtime).BodyForAgent)).toContain("<media:audio>");
  });

  it("downloads the photo of a visible forward, and not of a stripped one", async () => {
    const photo = { type: "photo", kind: "image", url: "https://example.com/fwd.jpg", mimeType: "image/jpeg" };
    const visible = installRuntime();
    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "фото",
        forwards: [{ ...ORDER_FORWARD, text: "", attachments: [photo] }],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });
    expect(vi.mocked(visible.channel.media.fetchRemoteMedia)).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/fwd.jpg" }),
    );

    const stripped = installRuntime();
    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "фото",
        forwards: [{ ...ORDER_FORWARD, text: "", attachments: [photo] }],
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groupAllowFrom: [String(SENDER_ID)],
          contextVisibility: "allowlist",
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });
    expect(vi.mocked(stripped.channel.media.fetchRemoteMedia)).not.toHaveBeenCalled();
  });
});

describe("context visibility through the resolved account", () => {
  // The account comes from resolveVkAccount, as in monitorVkProvider — never a
  // hand-built account.config, which is how a channel-level key went unapplied.
  const OUTSIDER = 999_000;
  const groupCfg = (vk: Record<string, unknown>) =>
    baseCfg({
      dmPolicy: "open",
      groupPolicy: "open",
      groupAllowFrom: [String(SENDER_ID)],
      contextVisibility: "allowlist",
      ...vk,
    });
  const groupMessage = (overrides: Parameters<typeof makeMessage>[0] = {}) =>
    makeMessage({ peerId: GROUP_PEER_ID, senderId: SENDER_ID, isGroup: true, text: "гляньте", ...overrides });

  it("applies a channel-level contextVisibility to the default account", async () => {
    const cfg = groupCfg({});
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({ forwards: [ORDER_FORWARD] }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    expect(String(lastInboundContext(runtime).BodyForAgent)).not.toContain("Заказ 10316111753");
  });

  it("applies a channel-level contextVisibility to a named account that does not set its own", async () => {
    const cfg = groupCfg({ accounts: { work: { token: "tok2" } } });
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({ forwards: [ORDER_FORWARD] }),
      account: resolveVkAccount({ cfg, accountId: "work" }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    expect(String(lastInboundContext(runtime).BodyForAgent)).not.toContain("Заказ 10316111753");
  });

  it("lets an account override the channel-level contextVisibility", async () => {
    const cfg = groupCfg({ accounts: { work: { token: "tok2", contextVisibility: "all" } } });
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({ forwards: [ORDER_FORWARD] }),
      account: resolveVkAccount({ cfg, accountId: "work" }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    expect(String(lastInboundContext(runtime).BodyForAgent)).toContain("Заказ 10316111753");
  });

  it("omits the whole quote target in a group when its author is outside the allowlist", async () => {
    const cfg = groupCfg({});
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToSenderId: OUTSIDER,
        replyToText: "/think high чужой текст",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    const ctx = lastInboundContext(runtime);
    expect(ctx.ReplyToBody).toBeUndefined();
    expect(ctx.ReplyToSender).toBeUndefined();
    expect(ctx.ReplyToId).toBeUndefined();
    expect(ctx.ReplyToIdFull).toBeUndefined();
  });

  it("keeps the quote of an allowed author", async () => {
    const cfg = groupCfg({});
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToSenderId: SENDER_ID,
        replyToText: "своё сообщение",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    const ctx = lastInboundContext(runtime);
    expect(ctx.ReplyToBody).toBe("своё сообщение");
    expect(ctx.ReplyToId).toBe("9801");
  });

  it("keeps an outsider's quote with allowlist_quote, still stripping an outsider's forward inside it", async () => {
    const cfg = groupCfg({ contextVisibility: "allowlist_quote" });
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToSenderId: OUTSIDER,
        replyToText: "чужая цитата",
        replyToForwards: [ORDER_FORWARD],
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    const ctx = lastInboundContext(runtime);
    expect(String(ctx.ReplyToBody)).toContain("чужая цитата");
    expect(String(ctx.ReplyToBody)).not.toContain("Заказ 10316111753");
    expect(ctx.ReplyToId).toBe("9801");
  });

  it("treats a quote of the bot's own message like any other author, as Telegram does", async () => {
    // Telegram checks the reply target's sender against the group allowlist with
    // no exception for the bot itself; the bot's id is not in groupAllowFrom.
    const cfg = groupCfg({});
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({
        text: "а подробнее?",
        replyToMessageId: "9800",
        replyToSenderId: -239104331,
        replyToText: "ответ бота",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    expect(lastInboundContext(runtime).ReplyToBody).toBeUndefined();
  });

  it("omits the whole quote target in a group when its author is unknown", async () => {
    // The core treats a missing sender as not allowed while the allowlist is
    // non-empty (isSenderIdAllowed), and the mode then decides. Letting an
    // unknown author through was this channel's own fail-open.
    const cfg = groupCfg({});
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToText: "цитата без автора",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    const ctx = lastInboundContext(runtime);
    expect(ctx.ReplyToBody).toBeUndefined();
    expect(ctx.ReplyToSender).toBeUndefined();
    expect(ctx.ReplyToId).toBeUndefined();
    expect(ctx.ReplyToIdFull).toBeUndefined();
  });

  it("keeps an unknown author's quote with allowlist_quote", async () => {
    const cfg = groupCfg({ contextVisibility: "allowlist_quote" });
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToText: "цитата без автора",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    const ctx = lastInboundContext(runtime);
    expect(ctx.ReplyToBody).toBe("цитата без автора");
    expect(ctx.ReplyToId).toBe("9801");
  });

  it("keeps an unknown author's quote when the group allowlist is empty", async () => {
    // An empty allowlist lets every author through, known or not; only a
    // non-empty one makes an unknown sender a refusal.
    const cfg = baseCfg({ dmPolicy: "open", groupPolicy: "open", contextVisibility: "allowlist" });
    const runtime = installRuntime();
    await handleVkInbound({
      message: groupMessage({
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToText: "цитата без автора",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    expect(lastInboundContext(runtime).ReplyToBody).toBe("цитата без автора");
  });

  it("does not filter an unknown author's quote in a direct chat", async () => {
    const cfg = baseCfg({ dmPolicy: "open", allowFrom: ["*"], contextVisibility: "allowlist" });
    const runtime = installRuntime();
    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToText: "цитата без автора",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    expect(lastInboundContext(runtime).ReplyToBody).toBe("цитата без автора");
  });

  it("does not filter quotes in a direct chat", async () => {
    const cfg = baseCfg({ dmPolicy: "open", allowFrom: ["*"], contextVisibility: "allowlist" });
    const runtime = installRuntime();
    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "что скажешь?",
        replyToMessageId: "9801",
        replyToSenderId: OUTSIDER,
        replyToText: "чужая цитата",
      }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: createVkRuntimeEnv(),
    });
    expect(lastInboundContext(runtime).ReplyToBody).toBe("чужая цитата");
  });

  it("logs why a group message made only of hidden forwards is not answered", async () => {
    const cfg = groupCfg({});
    const runtime = installRuntime();
    const env = { ...createVkRuntimeEnv(), log: vi.fn() };
    await handleVkInbound({
      message: groupMessage({ text: "", forwards: [ORDER_FORWARD] }),
      account: resolveVkAccount({ cfg }),
      config: cfg,
      runtime: env,
    });
    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    const lines = env.log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.startsWith("vk: drop group") && line.includes("contextVisibility"))).toBe(true);
    // The hidden author is exactly what this line must not name.
    expect(lines.join("\n")).not.toContain("142153191");
  });
});
