import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_TIMING,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  logInboundDrop,
  toInboundMediaFacts,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
} from "openclaw/plugin-sdk/channel-policy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { resolveVkButtonsFromPayload, resolveVkCommandFromPayload } from "./keyboard.js";
import { resolveVkInboundBodyText, resolveVkInboundResolvedMedia } from "./media.js";
import { createVkStatusReactionController } from "./reactions-controller.js";
import { getVkRuntime } from "./runtime.js";
import { markMessageReadVk, sendPayloadVk, sendTypingVk } from "./send.js";
import type { ResolvedVkAccount } from "./types.js";
import type { CoreConfig, VkInboundMessage } from "./types.js";

const CHANNEL_ID = "vk" as const;

// VK group chats have peerId >= 2000000000
const VK_GROUP_CHAT_OFFSET = 2_000_000_000;

function isVkGroupChat(peerId: number): boolean {
  return peerId >= VK_GROUP_CHAT_OFFSET;
}

function normalizeVkAllowlist(allowFrom: Array<string | number> | undefined): string[] {
  if (!allowFrom) {
    return [];
  }
  return allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

function resolveVkAllowlistMatch(params: { allowFrom: string[]; senderId: number }): {
  allowed: boolean;
} {
  const senderStr = String(params.senderId);
  if (params.allowFrom.length === 0) {
    return { allowed: false };
  }
  if (params.allowFrom.includes("*")) {
    return { allowed: true };
  }
  return {
    allowed: params.allowFrom.some((entry) => entry === senderStr || entry === `vk:${senderStr}`),
  };
}

type VkInboundMediaKind = NonNullable<ChannelInboundMediaInput["kind"]>;

function resolveVkInboundMediaKind(kind: string): VkInboundMediaKind {
  switch (kind) {
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return kind;
    default:
      return "unknown";
  }
}

type VkDispatchPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  channelData?: Record<string, unknown>;
};

async function deliverVkReply(params: {
  payload: VkDispatchPayload;
  peerId: number;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
  clearKeyboard?: boolean;
}) {
  const result = await sendPayloadVk(String(params.peerId), params.payload, {
    accountId: params.accountId,
    clearKeyboard: params.clearKeyboard,
  });
  if (!result) {
    return;
  }
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleVkInbound(params: {
  message: VkInboundMessage;
  account: ResolvedVkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getVkRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const payloadCommand = resolveVkCommandFromPayload(message.messagePayload);
  const visibleBody = resolveVkInboundBodyText({
    text: message.text,
    attachments: message.attachments,
  });
  const rawBody = payloadCommand ?? visibleBody;
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = String(message.senderId);
  const isGroup = message.isGroup;
  const groupConfig = isGroup
    ? (account.config.groups?.[String(message.peerId)] ?? account.config.groups?.["*"])
    : undefined;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.vk !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "vk",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (msg) => runtime.log?.(msg),
  });

  const configAllowFrom = normalizeVkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeVkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeVkAllowlist(storeAllowFrom);

  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    dmPolicy,
    groupAllowFromFallbackToAllowFrom: false,
  });
  const groupAllowOverride =
    groupConfig && Object.hasOwn(groupConfig, "allowFrom")
      ? normalizeVkAllowlist(groupConfig.allowFrom)
      : undefined;
  const effectiveGroupSenderAllowFrom = groupAllowOverride ?? effectiveGroupAllowFrom;

  // Group access check
  if (isGroup) {
    if (groupConfig?.enabled === false) {
      runtime.log?.(`vk: drop group peerId=${message.peerId} (group disabled by config)`);
      return;
    }
    if (groupPolicy === "disabled") {
      runtime.log?.(`vk: drop group peerId=${message.peerId} (groupPolicy=${groupPolicy})`);
      return;
    }
  }

  // Sender authorization
  if (isGroup) {
    if (groupPolicy === "allowlist") {
      const senderAllowed = resolveVkAllowlistMatch({
        allowFrom: effectiveGroupSenderAllowFrom,
        senderId: message.senderId,
      });
      if (!senderAllowed.allowed) {
        runtime.log?.(`vk: drop group sender ${senderDisplay} (groupPolicy=allowlist)`);
        return;
      }
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`vk: drop DM sender=${senderDisplay} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveVkAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        senderId: message.senderId,
      });
      if (!dmAllowed.allowed) {
        if (dmPolicy === "pairing") {
          await pairing.issueChallenge({
            senderId: senderDisplay,
            senderIdLine: `Your VK user id: ${senderDisplay}`,
            meta: {},
            sendPairingReply: async (text) => {
              await deliverVkReply({
                payload: { text },
                peerId: message.senderId,
                accountId: account.accountId,
                statusSink,
              });
            },
            onReplyError: (err) => {
              runtime.error?.(`vk: pairing reply failed for ${senderDisplay}: ${String(err)}`);
            },
          });
        }
        runtime.log?.(`vk: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  // Command gating
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = (config as Record<string, unknown>).commands
    ? ((config as Record<string, Record<string, unknown>>).commands.useAccessGroups as
        | boolean
        | undefined) !== false
    : true;
  const senderAllowedForCommands = resolveVkAllowlistMatch({
    allowFrom: isGroup ? effectiveGroupSenderAllowFrom : effectiveAllowFrom,
    senderId: message.senderId,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderDisplay,
    });
    return;
  }

  // Mention check for group chats
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);
  const requireMention = isGroup ? (groupConfig?.requireMention ?? false) : false;

  if (isGroup && requireMention && !wasMentioned && !hasControlCommand) {
    runtime.log?.(`vk: drop group peerId=${message.peerId} (mention required)`);
    return;
  }

  // Build route and dispatch
  const peerId = String(message.peerId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = isGroup ? `vk:chat:${message.peerId}` : `vk:${message.senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config as Record<string, Record<string, unknown>>).session?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "VK",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupConfig?.systemPrompt?.trim() || undefined;
  const resolvedMedia = await resolveVkInboundResolvedMedia({
    attachments: message.attachments,
    mediaRuntime: core.channel.media,
    logError: (line) => runtime.log?.(line),
  });
  const media = toInboundMediaFacts(
    resolvedMedia.map((entry) => ({
      path: entry.path,
      url: entry.url,
      contentType: entry.contentType ?? entry.attachment.mimeType,
      fileName: entry.attachment.title,
      kind: resolveVkInboundMediaKind(entry.attachment.kind),
    })),
    { messageId: message.messageId },
  );

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: visibleBody || rawBody,
    CommandBody: rawBody,
    From: fromLabel,
    To: `vk:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: undefined,
    SenderId: senderDisplay,
    GroupSubject: isGroup ? `vk:chat:${message.peerId}` : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `vk:${peerId}`,
    CommandAuthorized: commandGate.commandAuthorized,
    media: media.length > 0 ? media : undefined,
    ReplyToId: message.replyToMessageId,
    ReplyToIdFull: message.replyToMessageId,
    ReplyToBody: message.replyToText,
  });

  const onDispatchError = (err: unknown, info: { kind: string }) => {
    runtime.error?.(`vk ${info.kind} reply failed: ${String(err)}`);
  };
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      await sendTypingVk(String(message.peerId), account);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        target: String(message.peerId),
        error: err,
      });
    },
  });
  let typingStarted = false;
  const startTypingOnce = async () => {
    if (typingStarted) {
      return;
    }
    typingStarted = true;
    await typingCallbacks.onReplyStart();
  };
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    ctx: ctxPayload,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    onRecordError: (err) => {
      runtime.error?.(`vk: failed updating session meta: ${String(err)}`);
    },
  });

  try {
    await markMessageReadVk(String(message.peerId), message.messageId, account);
  } catch (err) {
    runtime.log?.(
      `vk: mark read failed for peerId=${message.peerId} messageId=${message.messageId}: ${String(err)}`,
    );
  }

  const cfgRecord = config as Record<string, Record<string, unknown>>;
  const ackReactionScope =
    (cfgRecord.messages?.ackReactionScope as
      | "all"
      | "direct"
      | "group-all"
      | "group-mentions"
      | "off"
      | "none"
      | undefined) ?? undefined;
  const statusReactionsCfg = cfgRecord.messages?.statusReactions as
    | { enabled?: boolean; emojis?: Record<string, string>; timing?: Record<string, number> }
    | undefined;
  const statusReactionsEnabled =
    statusReactionsCfg?.enabled === true &&
    typeof message.conversationMessageId === "number" &&
    core.channel.reactions.shouldAckReaction({
      scope: ackReactionScope,
      isDirect: !isGroup,
      isGroup,
      isMentionableGroup: isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention: true,
      effectiveWasMentioned: isGroup ? wasMentioned : false,
    });
  const removeAckAfterReply =
    (cfgRecord.messages?.removeAckAfterReply as boolean | undefined) ?? false;
  let statusReactions: StatusReactionController | null = null;
  if (statusReactionsEnabled && typeof message.conversationMessageId === "number") {
    statusReactions = createVkStatusReactionController({
      peerId: message.peerId,
      cmid: message.conversationMessageId,
      account,
      emojiOverrides: statusReactionsCfg?.emojis,
      timing: statusReactionsCfg?.timing,
      onError: (err) => {
        runtime.log?.(`vk: status-reaction error for cmid=${message.conversationMessageId}: ${String(err)}`);
      },
    });
    void statusReactions.setQueued();
  }

  await startTypingOnce();

  let dispatchError = false;
  // Defensive guard mirroring the bundled channels' isProcessAborted() check
  // (see core message-handler.process / telegram bot). VK has no abortSignal in
  // this scope, so we use a local "settled" flag: once the turn finalizes
  // (setDone/setError in finally), late-arriving progress callbacks become
  // no-ops. The SDK controller already guards on `finished`, so this is
  // belt-and-suspenders — but it keeps intent explicit and avoids redundant
  // setReaction churn after the turn is done.
  let turnSettled = false;
  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config as OpenClawConfig,
      dispatcherOptions: {
        ...prefixOptions,
        onReplyStart: async () => {
          await startTypingOnce();
          if (statusReactions) await statusReactions.setThinking();
        },
        typingCallbacks,
        deliver: async (payload: unknown, info?: { kind?: string }) => {
          const normalized =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as VkDispatchPayload)
              : {};
          const resolvedButtons = resolveVkButtonsFromPayload(normalized);
          await deliverVkReply({
            payload: normalized,
            peerId: message.peerId,
            accountId: account.accountId,
            statusSink,
            clearKeyboard:
              payloadCommand && info?.kind === "final" && !resolvedButtons ? true : undefined,
          });
        },
        onError: onDispatchError,
      },
      replyOptions: {
        onModelSelected,
        ...(statusReactions
          ? {
              // Without these, the core gates onToolStart/onCompactionStart
              // behind tool-summary visibility (requiresToolSummaryVisibility),
              // so the 👌/🙏 reactions never fire in DMs even though
              // onReasoningStream (🤔) does. These flags enable the "quiet
              // direct native progress" path: reaction callbacks run without
              // emitting default tool-progress text messages.
              suppressDefaultToolProgressMessages: true,
              allowProgressCallbacksWhenSourceDeliverySuppressed: true,
              onReasoningStream: async () => {
                if (turnSettled) return;
                await statusReactions!.setThinking();
              },
              onToolStart: async (payload: { name?: string }) => {
                if (turnSettled) return;
                await statusReactions!.setTool(payload?.name);
              },
              onCompactionStart: async () => {
                if (turnSettled) return;
                await statusReactions!.setCompacting();
              },
              onCompactionEnd: async () => {
                if (turnSettled) return;
                statusReactions!.cancelPending();
                await statusReactions!.setThinking();
              },
            }
          : {}),
      },
    });
  } catch (err) {
    dispatchError = true;
    throw err;
  } finally {
    turnSettled = true;
    if (statusReactions) {
      try {
        if (dispatchError) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
      } catch (err) {
        runtime.log?.(`vk: status-reaction finalize failed: ${String(err)}`);
      }
      if (removeAckAfterReply) {
        const holdMs = dispatchError
          ? DEFAULT_TIMING.errorHoldMs
          : DEFAULT_TIMING.doneHoldMs;
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
          try {
            await statusReactions!.clear();
          } catch (err) {
            runtime.log?.(`vk: status-reaction clear failed: ${String(err)}`);
          }
        })();
      }
      // NB: we intentionally do NOT call statusReactions.restoreInitial()
      // here. The Discord/bundled flow uses restoreInitial after setDone
      // to peel away intermediate reactions on platforms that support a
      // stack of reactions. VK lets the bot keep at most one reaction
      // per message, so setDone/setError already *replaced* the previous
      // emoji — calling restoreInitial would just overwrite the final
      // state with the initial "queued" emoji again (👍 instead of 🎉).
    }
  }
}
