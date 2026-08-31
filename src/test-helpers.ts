import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { vi } from "vitest";
import type { ResolvedVkAccount, VkInboundMessage } from "./types.js";

export function createVkRuntimeEnv(): RuntimeEnv {
  return {
    log: () => {},
    error: () => {},
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  };
}

export function makeVkRuntime(opts: {
  readAllowFromStore?: PluginRuntime["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest?: PluginRuntime["channel"]["pairing"]["upsertPairingRequest"];
  resolveAgentRoute?: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
  hasControlCommand?: boolean;
  buildMentionRegexes?: PluginRuntime["channel"]["mentions"]["buildMentionRegexes"];
  matchesMentionPatterns?: PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"];
} = {}): PluginRuntime {
  return {
    version: "0.0.0",
    config: {
      loadConfig: vi.fn().mockReturnValue({}),
      writeConfigFile: vi.fn(),
    },
    logging: {
      shouldLogVerbose: vi.fn().mockReturnValue(false),
      getChildLogger: vi.fn(),
    },
    channel: {
      pairing: {
        readAllowFromStore:
          opts.readAllowFromStore ?? vi.fn().mockResolvedValue([]),
        upsertPairingRequest:
          opts.upsertPairingRequest ??
          vi.fn().mockResolvedValue({ code: "TESTCODE", created: true }),
        buildPairingReply: vi.fn().mockReturnValue("pairing-reply-text"),
      },
      commands: {
        shouldHandleTextCommands: vi.fn().mockReturnValue(false),
        isControlCommandMessage: vi.fn().mockReturnValue(false),
        shouldComputeCommandAuthorized: vi.fn().mockReturnValue(false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn().mockReturnValue(false),
      },
      text: {
        hasControlCommand:
          opts.hasControlCommand !== undefined
            ? vi.fn().mockReturnValue(opts.hasControlCommand)
            : vi.fn().mockReturnValue(false),
        chunkMarkdownText: vi.fn(),
        chunkByNewline: vi.fn(),
        chunkMarkdownTextWithMode: vi.fn(),
        chunkText: vi.fn(),
        chunkTextWithMode: vi.fn(),
        resolveChunkMode: vi.fn(),
        resolveTextChunkLimit: vi.fn(),
        resolveMarkdownTableMode: vi.fn(),
        convertMarkdownTables: vi.fn(),
      },
      mentions: {
        buildMentionRegexes:
          opts.buildMentionRegexes ?? vi.fn().mockReturnValue([]),
        matchesMentionPatterns:
          opts.matchesMentionPatterns ?? vi.fn().mockReturnValue(false),
        matchesMentionWithExplicit: vi.fn().mockReturnValue(false),
      },
      routing: {
        resolveAgentRoute:
          opts.resolveAgentRoute ??
          vi.fn().mockReturnValue({
            agentId: "default",
            accountId: "default",
            sessionKey: "vk:123456",
          }),
        buildAgentSessionKey: vi.fn().mockReturnValue("vk:123456"),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/test-sessions"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordSessionMetaFromInbound: vi.fn(),
        recordInboundSession: vi.fn(),
        updateLastRoute: vi.fn(),
        loadSessionStore: vi.fn(),
        saveSessionStore: vi.fn(),
        resolveSessionFilePath: vi.fn(),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatAgentEnvelope: vi
          .fn()
          .mockReturnValue("[VK] from: vk:123456\n\nhello"),
        finalizeInboundContext: vi.fn().mockImplementation((ctx) => ctx),
        formatInboundEnvelope: vi.fn().mockReturnValue(""),
        resolveEffectiveMessagesConfig: vi.fn(),
        resolveHumanDelayConfig: vi.fn(),
        dispatchReplyFromConfig: vi.fn(),
        withReplyDispatcher: vi.fn(),
        createReplyDispatcherWithTyping: vi.fn(),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      activity: { record: vi.fn(), get: vi.fn() },
      groups: {
        resolveGroupPolicy: vi.fn(),
        resolveRequireMention: vi.fn(),
      },
      media: { fetchRemoteMedia: vi.fn(), saveMediaBuffer: vi.fn() },
      reactions: {
        shouldAckReaction: vi.fn(),
        removeAckReactionAfterReply: vi.fn(),
      },
      debounce: {
        createInboundDebouncer: vi.fn(),
        resolveInboundDebounceMs: vi.fn(),
      },
      discord: {} as never,
      slack: {} as never,
      telegram: {} as never,
      signal: {} as never,
      imessage: {} as never,
      whatsapp: {} as never,
      line: {} as never,
    },
  } as unknown as PluginRuntime;
}

export function makeAccount(
  overrides: Partial<ResolvedVkAccount> = {},
): ResolvedVkAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
    },
    ...overrides,
  };
}

export function makeMessage(
  overrides: Partial<VkInboundMessage> = {},
): VkInboundMessage {
  return {
    messageId: "msg-1",
    peerId: 123456,
    senderId: 123456,
    text: "hello",
    timestamp: 1_700_000_000_000,
    isGroup: false,
    ...overrides,
  };
}
