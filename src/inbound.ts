import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import { getReplyPayloadTtsSupplement } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { StreamingCompatEntry } from "./sdk-compat.js";
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
  buildChannelProgressDraftLineForEntry,
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
  resolveChannelPreviewStreamMode,
  selectLongerFinalText,
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
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { redactVkId, vkDiag } from "./diagnostics.js";
import { renderVkMarkdownChunks } from "./format.js";
import { resolveVkButtonsFromPayload, resolveVkCommandFromPayload } from "./keyboard.js";
import {
  resolveVkInboundAgentText,
  resolveVkInboundBodyText,
  resolveVkInboundResolvedMedia,
} from "./media.js";
import {
  createVkProgressDraftCompositor,
  resolveVkProgressLabel,
  type VkProgressDraftHandle,
} from "./progress-draft.js";
import { createVkStatusReactionController } from "./reactions-controller.js";
import { getVkRuntime } from "./runtime.js";
import {
  editMessageVk,
  markMessageReadVk,
  resolveVkOwnGroup,
  sendMessageVk,
  sendPayloadVk,
  sendTypingVk,
  splitVkMarkdownAttachments,
} from "./send.js";
import type { ResolvedVkAccount } from "./types.js";
import type {
  CoreConfig,
  VkAccountConfig,
  VkContextVisibility,
  VkInboundAttachment,
  VkInboundForward,
  VkInboundMessage,
} from "./types.js";

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

/** The core's precedence: account, then channel (merged into the account), then channel defaults. */
function resolveVkContextVisibility(accountConfig: VkAccountConfig, config: unknown): VkContextVisibility {
  const defaults = (config as { channels?: { defaults?: { contextVisibility?: VkContextVisibility } } })
    ?.channels?.defaults;
  return accountConfig.contextVisibility ?? defaults?.contextVisibility ?? "all";
}

function filterVkForwards(
  forwards: readonly VkInboundForward[] | undefined,
  isVisible: (forward: VkInboundForward) => boolean,
): VkInboundForward[] {
  return (forwards ?? [])
    .filter(isVisible)
    .map((forward) =>
      forward.forwards ? { ...forward, forwards: filterVkForwards(forward.forwards, isVisible) } : forward,
    );
}

/**
 * Only the images of forwards are downloaded. A forwarded voice message or audio
 * would be transcribed into the turn as if the sender had said it; those stay a
 * placeholder inside the forward.
 */
/**
 * Media the sender is answerable for: their own attachments, plus the images of
 * a wall post they shared. A post's audio or voice attachment stays a
 * placeholder in the text — downloading it would let the core transcribe a
 * third party's recording into the turn as if the sender had said it, the same
 * reason forwards give up everything but images.
 */
function collectVkOwnMedia(
  attachments: readonly VkInboundAttachment[] | undefined,
): VkInboundAttachment[] {
  return (attachments ?? []).filter(
    (attachment) => !attachment.fromPost || attachment.kind === "image",
  );
}

function collectVkForwardImages(forwards: readonly VkInboundForward[]): VkInboundAttachment[] {
  return forwards.flatMap((forward) => [
    ...(forward.attachments ?? []).filter((attachment) => attachment.kind === "image"),
    ...collectVkForwardImages(forward.forwards ?? []),
  ]);
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

/**
 * Who wrote a message, labelled the way the core's Telegram labels senders: the
 * bot itself by name with " (you)", so the agent knows it is quoting itself;
 * anyone else by VK id, as in `ForwardedFrom`.
 */
async function resolveVkSenderLabel(account: ResolvedVkAccount, senderId: number): Promise<string> {
  if (senderId < 0) {
    const ownGroup = await resolveVkOwnGroup(account.token);
    if (ownGroup && senderId === -ownGroup.id) {
      return `${account.name ?? ownGroup.name ?? "OpenClaw"} (you)`;
    }
  }
  return `vk:${senderId}`;
}

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
  // Two inputs, deliberately separate. The control input is what the sender
  // authored: it decides commands, directives and the mention gate. The agent
  // body may carry a third party’s text (a shared post), so it reaches neither.
  const visibleBody = resolveVkInboundBodyText({
    text: message.text,
    attachments: message.attachments,
    forwards: message.forwards,
  });
  const commandInput = payloadCommand ?? visibleBody;
  if (!commandInput) {
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

  // Forwards follow the core's supplemental context visibility, as in Telegram:
  // filtered in groups only — in a direct chat the sender already passed allowFrom,
  // and an empty group allowlist lets every author through.
  const contextVisibility = resolveVkContextVisibility(account.config, config);
  // An author VK did not give us is NOT an allowed author while the allowlist is
  // non-empty — the core's isSenderIdAllowed says the same, and the mode then
  // decides: "allowlist" hides such a quote, "allowlist_quote" may keep it. An
  // empty allowlist still lets every author through, known or not.
  const isSupplementalVisible = (
    kind: "quote" | "forwarded",
    senderId: number | undefined,
  ): boolean => {
    if (!isGroup) {
      return true;
    }
    const senderAllowed =
      effectiveGroupSenderAllowFrom.length === 0 ||
      (senderId !== undefined &&
        resolveVkAllowlistMatch({ allowFrom: effectiveGroupSenderAllowFrom, senderId }).allowed);
    return evaluateSupplementalContextVisibility({ mode: contextVisibility, kind, senderAllowed }).include;
  };
  const isForwardVisible = (forward: VkInboundForward): boolean =>
    isSupplementalVisible("forwarded", forward.senderId);
  // The quote target is judged by its own author first, as Telegram's
  // resolveVisibleReplyTarget does: hidden means the whole target — text, author
  // and ids — and only a visible quote has its forwards filtered on their own.
  const isQuoteVisible = isSupplementalVisible("quote", message.replyToSenderId);
  const visibleForwards = filterVkForwards(message.forwards, isForwardVisible);
  const firstForward = visibleForwards[0];
  const rawBody =
    payloadCommand ??
    resolveVkInboundAgentText({
      text: message.text,
      attachments: message.attachments,
      forwards: visibleForwards,
    });
  if (!rawBody) {
    // Only reachable when every forward was hidden: the empty-message check above
    // already let this one through. Say so, without naming the hidden authors.
    runtime.log?.(
      `vk: drop group peerId=${message.peerId} (all ${message.forwards?.length ?? 0} forwards hidden by contextVisibility=${contextVisibility})`,
    );
    return;
  }

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
  const hasControlCommand = core.channel.text.hasControlCommand(
    commandInput,
    config as OpenClawConfig,
  );
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
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(
    commandInput,
    mentionRegexes,
  );
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
    attachments: [
      ...collectVkOwnMedia(message.attachments),
      ...collectVkForwardImages(visibleForwards),
    ],
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

  const replyToSender =
    message.replyToSenderId === undefined || !isQuoteVisible
      ? undefined
      : await resolveVkSenderLabel(account, message.replyToSenderId);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: visibleBody || commandInput,
    CommandBody: commandInput,
    BodyForCommands: commandInput,
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
    ...(isQuoteVisible && {
      ReplyToId: message.replyToMessageId,
      ReplyToIdFull: message.replyToMessageId,
      ReplyToSender: replyToSender,
      ReplyToBody:
        resolveVkInboundAgentText({
          text: message.replyToText,
          forwards: filterVkForwards(message.replyToForwards, isForwardVisible),
        }) || undefined,
    }),
    ...(firstForward && {
      ForwardedFrom: `vk:${firstForward.senderId}`,
      ForwardedFromId: String(firstForward.senderId),
      ForwardedFromType: firstForward.senderId < 0 ? "group" : "user",
      ForwardedDate: firstForward.timestamp,
    }),
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

  // ── Step-progress draft (opt-in via channels.vk.streaming.mode:"progress") ──
  // Shows the live list of execution steps (🛠️ tool calls, 🔎 web search …) in
  // ONE message edited in place, mirroring Telegram's "progress" stream. It is
  // INDEPENDENT of status reactions — both can run together (as Telegram does):
  // the reaction tracks the coarse state on the user's message, the draft shows
  // the steps. Each progress callback below fans out to whichever is enabled.
  const vkStreamingEntry = cfgRecord.channels?.vk as StreamingCompatEntry | undefined;
  const progressStreamMode = resolveChannelPreviewStreamMode(vkStreamingEntry, "off");
  const progressDraftEnabled =
    progressStreamMode === "progress" &&
    typeof message.conversationMessageId === "number";

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

  let progressDraft: VkProgressDraftHandle | null = null;
  // The ANSWER currently sitting in the draft (not the step list), as the
  // markdown the blocks arrived in. It lives for the whole turn rather than one
  // delivery: blocks arrive before the final. Reset when the draft is
  // overwritten with tool steps — otherwise the step list itself would be kept
  // as the "answer".
  let draftAnswerSource: string | null = null;
  /**
   * Whether the answer already in the draft outlives this final.
   *
   * With block streaming the core drops the final's text once the blocks went
   * out (`shouldDropFinalPayloads` in the agent runner) and delivers only the
   * media left over — so an empty final is the normal ending of a block-streamed
   * answer, not "no answer". The core's `selectLongerFinalText` answers a
   * different question: it returns nothing unless the final is a truncated
   * prefix (`isPotentialTruncatedFinal`), and for an empty final that is never
   * the case. Relying on it for the empty case deleted the only copy of the
   * answer and left the recipient with a voice note alone.
   */
  const draftKeepsAnswer = (finalText: string): boolean => {
    if (draftAnswerSource === null) {
      return false;
    }
    const trimmed = finalText.trim();
    if (!trimmed) {
      return true;
    }
    return (
      selectLongerFinalText({ finalText: trimmed, candidateTexts: [draftAnswerSource] }) !==
      undefined
    );
  };
  /**
   * Rewrite the draft into the finished answer: the same text, formatted, and
   * WITHOUT the progress label — `overwrite` always prepends it, so a finished
   * answer would otherwise keep a "working" header forever.
   */
  const keepDraftAsAnswer = async (): Promise<void> => {
    const source = draftAnswerSource;
    const draftMsgId = progressDraft?.currentMessageId();
    if (source === null || draftMsgId === undefined) {
      return;
    }
    const [chunk] = renderVkMarkdownChunks(source);
    try {
      await editMessageVk(String(message.peerId), draftMsgId, chunk?.text ?? source, account, {
        formatData: chunk?.formatData,
      });
      vkDiag("draft kept as answer", { len: (chunk?.text ?? source).length });
    } catch (err) {
      runtime.log?.(`vk: draft finalize failed: ${String(err)}`);
    }
  };
  /**
   * Freeze the answer part sitting in the draft and let go of that message, so
   * whatever comes next — a block that no longer fits, a picture — lands BELOW
   * it instead of overwriting it. Without this the next block rewrote the draft
   * and the text already in it was gone, or it stayed above a part that came
   * after it.
   */
  const sealDraftAnswer = async (): Promise<void> => {
    if (!progressDraft || draftAnswerSource === null) {
      return;
    }
    await keepDraftAsAnswer();
    progressDraft.detach();
    draftAnswerSource = null;
  };
  if (progressDraftEnabled) {
    // The draft quotes what the ordinary reply would quote: the incoming
    // message in a group chat and the message with the pressed button. In a
    // direct chat, as there, nothing is quoted.
    const draftReplyTo = payloadCommand || isGroup ? message.messageId : undefined;
    progressDraft = createVkProgressDraftCompositor({
      to: String(message.peerId),
      account,
      accountId: account.accountId,
      cfg: config as CoreConfig,
      entry: vkStreamingEntry,
      mode: progressStreamMode,
      seed: String(message.conversationMessageId),
      replyTo: draftReplyTo,
      onError: (err) => {
        runtime.log?.(
          `vk: progress-draft error for cmid=${redactVkId(message.conversationMessageId)}: ${String(err)}`,
        );
      },
    });
    vkDiag("step-progress draft enabled", {
      mode: progressStreamMode,
      cmid: message.conversationMessageId,
    });
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
          // NB: the step draft is intentionally NOT seeded here. Telegram seeds
          // its draft only from real tool/reasoning events, so a text-only turn
          // never spawns an empty placeholder message. We do the same — the draft
          // is created lazily on the first onToolStart below.
        },
        typingCallbacks,
        deliver: async (payload: unknown, info?: { kind?: string }) => {
          const normalized =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as VkDispatchPayload)
              : {};
          const replyToId = payloadCommand
            ? (normalized.replyToId ?? message.messageId)
            : isGroup
              ? message.messageId
              : undefined;
          const outboundPayload: VkDispatchPayload = {
            ...normalized,
            ...(replyToId ? { replyToId } : {}),
          };
          if (!replyToId) {
            delete outboundPayload.replyToId;
          }
          const resolvedButtons = resolveVkButtonsFromPayload(normalized);
          const isFinal = info?.kind === "final";
          // ── A voice supplement is not an answer ──────────────────────────
          // The core may follow a delivered answer with a SECOND final that
          // carries only audio and no text, marked `visibleTextAlreadyDelivered`:
          // the words already went out, this payload is just their voice. Its
          // empty text says nothing about whether an answer exists, so it must
          // not decide the step draft's fate. Letting it through deleted the
          // very message that held the answer — the recipient was left with a
          // picture and a voice note and no text.
          const isTtsSupplement =
            isFinal &&
            getReplyPayloadTtsSupplement(normalized)?.visibleTextAlreadyDelivered === true;
          // Owns the draft outcome: may rewrite it into the answer, keep it, or
          // drop it. A supplement owns none of that and only carries its media.
          const ownsDraftOutcome = isFinal && !isTtsSupplement;
          let draftHandled = false;

          // ── Intermediate block → into the draft, not a separate message ──
          // With block streaming on, the core delivers the narration in chunks
          // (kind=block) and the result separately (kind=final). Each chunk used
          // to go out as its own message, and the chat grew into a wall. Now a
          // chunk rewrites the draft: progress lives in one bubble and changes
          // as work goes on, and at the end that same bubble becomes the answer.
          // Media and buttons keep their old path — they cannot go into a
          // draft.
          // Markdown links the send path turns into attachments (a picture,
          // a local file) cannot live in the draft either: rendered there they
          // became a link to nowhere and the attachment was never sent.
          const markdownAttachments = splitVkMarkdownAttachments(normalized.text ?? "");
          const isTextBlock = Boolean(
            progressDraft &&
              !isFinal &&
              normalized.text?.trim() &&
              !normalized.mediaUrl &&
              !(normalized.mediaUrls?.length ?? 0) &&
              markdownAttachments.attachments.length === 0 &&
              !resolvedButtons,
          );
          if (progressDraft && isTextBlock) {
            // Blocks are CHUNKS of the answer, not its accumulated version (the
            // core splits the stream through a block chunker). The draft is
            // rewritten in full, so we accumulate ourselves: otherwise an empty
            // final would keep only the last paragraph as the "answer" while the
            // voice-over carried the whole text.
            const blockText = normalized.text!.trim();
            let accumulated = draftAnswerSource
              ? `${draftAnswerSource}\n\n${blockText}`
              : blockText;
            let chunks = renderVkMarkdownChunks(accumulated);
            if (chunks.length > 1 && draftAnswerSource !== null) {
              // The answer no longer fits one VK message. What is in the draft
              // is a finished part of it: freeze it there and start a new
              // draft with this block, below the frozen part.
              vkDiag("block overflows draft", { len: accumulated.length });
              await sealDraftAnswer();
              accumulated = blockText;
              chunks = renderVkMarkdownChunks(accumulated);
            }
            if (chunks.length === 1) {
              // The label is added by the draft itself (the single write point).
              const draftText = chunks[0]?.text ?? accumulated;
              // `overwrite` never rejects — it reports the outcome, so a failed
              // draft write has to be checked rather than caught. Missing that
              // meant a VK edit failure on a blocks-plus-empty-final turn left
              // the person with nothing at all.
              if (await progressDraft.overwrite(draftText)) {
                draftAnswerSource = accumulated;
                vkDiag("block into draft", { len: draftText.length });
                return;
              }
              runtime.log?.("vk: block → draft failed, sending it the usual way");
            } else {
              // A single block longer than one VK message: it goes the usual
              // way, split into several.
              vkDiag("block overflows draft", { len: accumulated.length });
            }
            draftAnswerSource = null;
          } else if (progressDraft && !isFinal) {
            // A block with media or buttons goes as its own message. Freeze
            // the answer part in the draft first, so it stays above it.
            await sealDraftAnswer();
          }

          // ── Intermediate block WITH MEDIA → own message, but labelled ────
          // A picture cannot go into the draft: that is a single text message we
          // edit through messages.edit, and an attachment cannot be slipped in.
          // Moving the caption into the draft is wrong too — it belongs to the
          // image and is read together with it. So such messages carry the same
          // label as the draft: progress stays distinguishable from the answer
          // even when progress consists of pictures.
          //
          // The label goes into `outboundPayload`, not `normalized`: what is sent
          // is the copy taken above (where the quote target is decided), so a
          // label written into the original would never reach the recipient.
          // A plain text block that could not go into the draft is part of the
          // answer, not progress: it carries no "working" header.
          if (progressDraft && !isFinal && !isTextBlock && outboundPayload.text?.trim()) {
            const label = resolveVkProgressLabel(vkStreamingEntry);
            if (label && !outboundPayload.text.startsWith(label)) {
              outboundPayload.text = `${label} ${outboundPayload.text}`;
            }
          }

          // ── Edit-in-place finalize (Telegram-style single bubble) ──────────
          // When a step draft is live and the final answer carries text, edit
          // the draft message INTO the answer instead of dropping it and sending
          // a new one. The first chunk rewrites the draft, the rest of a long
          // answer follows as ordinary messages, and media (a picture, a voice
          // message) follows last. An answer with buttons, or an answer to a
          // button press, goes the normal delivery path: the keyboard is sent or
          // cleared with a new message, which an edit cannot do.
          //
          // The answer is already in the draft (block streaming): the final
          // must not replace it — neither delete it when empty nor overwrite it
          // with a truncated copy. Only the final's media still has to go out.
          const keepsDraftAnswer =
            progressDraft !== null &&
            ownsDraftOutcome &&
            draftKeepsAnswer(markdownAttachments.text);
          if (keepsDraftAnswer && outboundPayload.text?.trim()) {
            vkDiag("truncated final dropped, draft holds the answer", {
              len: outboundPayload.text.length,
            });
            // The final's own attachments still go out.
            outboundPayload.text = markdownAttachments.attachments.join("\n");
          }
          if (progressDraft && ownsDraftOutcome) {
            const draftMsgId = progressDraft.currentMessageId();
            const hasMedia =
              Boolean(normalized.mediaUrl) || (normalized.mediaUrls?.length ?? 0) > 0;
            const finalText = keepsDraftAnswer ? undefined : markdownAttachments.text.trim();
            if (draftMsgId !== undefined && finalText && !resolvedButtons && !payloadCommand) {
              const chunks = renderVkMarkdownChunks(markdownAttachments.text);
              if (chunks.length >= 1) {
                progressDraft.compositor.markFinalReplyStarted();
                let edited = false;
                try {
                  edited = await editMessageVk(
                    String(message.peerId),
                    draftMsgId,
                    chunks[0].text,
                    account,
                    { formatData: chunks[0].formatData },
                  );
                } catch (err) {
                  runtime.log?.(`vk: step-progress edit-into-final failed: ${String(err)}`);
                }
                progressDraft.compositor.markFinalReplyDelivered();
                progressDraft.close();
                if (edited) {
                  // The draft IS the answer now: let go of it, so the cleanup
                  // at the end of the turn cannot delete it.
                  progressDraft.detach();
                  runtime.log?.(
                    `vk: step-progress draft edited INTO final msgId=${draftMsgId} len=${chunks[0].text.length} chunks=${chunks.length}`,
                  );
                  // The answer's head is out: the draft now carries it.
                  statusSink?.({ lastOutboundAt: Date.now() });
                  // The rest of the answer: tail chunks, markdown attachments,
                  // voice. A failure here is a partial delivery and must reach
                  // the core like any other send failure — swallowing it made
                  // `deliver` succeed and the status reaction say "done" while
                  // the recipient got the start of the answer only. Parts that
                  // did go out are not sent again.
                  try {
                    // The tail of a long answer goes as ordinary messages: VK
                    // cannot hold more than ~4096 characters in one bubble.
                    for (const chunk of chunks.slice(1)) {
                      await sendMessageVk(String(message.peerId), chunk.text, {
                        accountId: account.accountId,
                      });
                    }
                    // Attachments from markdown links go the ordinary way, as
                    // on a reply without a draft; only the links are sent, so
                    // no caption repeats the text already in the draft.
                    if (markdownAttachments.attachments.length > 0) {
                      await deliverVkReply({
                        payload: { text: markdownAttachments.attachments.join("\n") },
                        peerId: message.peerId,
                        accountId: account.accountId,
                        statusSink,
                      });
                    }
                    // Voice messages go last and without text: the text is
                    // already in the replaced draft, so a caption would only
                    // duplicate it.
                    if (hasMedia) {
                      const mediaList = normalized.mediaUrls?.length
                        ? normalized.mediaUrls
                        : normalized.mediaUrl
                          ? [normalized.mediaUrl]
                          : [];
                      for (const media of mediaList) {
                        await deliverVkReply({
                          payload: { ...normalized, text: "", mediaUrl: media, mediaUrls: undefined },
                          peerId: message.peerId,
                          accountId: account.accountId,
                          statusSink,
                        });
                      }
                    }
                  } catch (err) {
                    runtime.error?.(`vk: step-progress answer tail failed: ${String(err)}`);
                    throw err;
                  }
                  return;
                }
                // Edit failed — drop the draft and deliver the answer normally so
                // the reply is never lost.
                await progressDraft.remove();
                draftHandled = true;
              }
            }
            if (!draftHandled) {
              // Stop the step draft before the answer lands so it can't race it.
              progressDraft.compositor.markFinalReplyStarted();
            }
          }
          const leftToSend =
            Boolean(outboundPayload.text?.trim()) ||
            Boolean(outboundPayload.mediaUrl) ||
            (outboundPayload.mediaUrls?.length ?? 0) > 0 ||
            Boolean(resolvedButtons);
          // A kept draft may leave nothing else to deliver; an empty send would
          // report "no result" and needlessly reset the VK client.
          if (!keepsDraftAnswer || leftToSend) {
            await deliverVkReply({
              payload: outboundPayload,
              peerId: message.peerId,
              accountId: account.accountId,
              statusSink,
              clearKeyboard:
                payloadCommand && info?.kind === "final" && !resolvedButtons ? true : undefined,
            });
          }
          if (progressDraft && ownsDraftOutcome && !draftHandled) {
            progressDraft.compositor.markFinalReplyDelivered();
            progressDraft.close();
            // The draft is dropped only when the answer arrived some other
            // way. When the draft already holds the answer text (the model
            // delivered it as blocks along the way), deleting it destroys the
            // only copy of the answer and the recipient is left with a voice
            // message alone — see `draftKeepsAnswer`.
            if (keepsDraftAnswer) {
              await sealDraftAnswer();
            } else {
              await progressDraft.remove();
            }
          }
        },
        onError: onDispatchError,
      },
      replyOptions: {
        onModelSelected,
        // Reactions and the step draft are independent surfaces — fan each
        // progress event out to whichever is enabled (both, when both are on).
        ...(progressDraft || statusReactions
          ? {
              // Without these, the core gates onToolStart/onCompactionStart
              // behind tool-summary visibility (requiresToolSummaryVisibility),
              // so neither the 👌/🙏 reactions nor the step draft fire in DMs
              // even though onReasoningStream (🤔) does. These flags enable the
              // "quiet direct native progress" path: the callbacks run without
              // emitting default tool-progress text messages.
              suppressDefaultToolProgressMessages: true,
              allowProgressCallbacksWhenSourceDeliverySuppressed: true,
              onReasoningStream: async () => {
                if (turnSettled) return;
                // Reasoning drives only the reaction (🤔). The step draft shows
                // execution steps, not reasoning, so it is fed exclusively from
                // onToolStart below — mirroring Telegram, which never seeds the
                // draft from reply-start/reasoning.
                if (statusReactions) await statusReactions.setThinking();
              },
              onToolStart: async (payload: {
                name?: string;
                phase?: string;
                args?: Record<string, unknown>;
                itemId?: string;
                toolCallId?: string;
              }) => {
                if (turnSettled) return;
                const toolName = payload?.name?.trim();
                if (statusReactions) await statusReactions.setTool(toolName);
                if (progressDraft) {
                  vkDiag("step-progress tool", {
                    tool: toolName ?? "?",
                    phase: payload?.phase ?? "?",
                    cmid: message.conversationMessageId,
                  });
                  // Build the full draft line (like Telegram). Passing undefined
                  // leaves the compositor with nothing to render; startImmediately
                  // shows the step at once instead of waiting out the start gate.
                  // A tool step that the compositor renders overwrites the draft
                  // with its own list, so the answer text left there by a previous
                  // block is gone. Forget it only then: otherwise an empty final
                  // would keep the step list as the "answer". A step it does not
                  // render (a non-working tool, an update phase) leaves the answer
                  // in the draft, and forgetting it would let cleanup delete it.
                  const redrawn = await progressDraft.compositor.pushToolProgress(
                    buildChannelProgressDraftLineForEntry(vkStreamingEntry, {
                      event: "tool",
                      itemId: payload?.itemId,
                      toolCallId: payload?.toolCallId,
                      name: toolName,
                      phase: payload?.phase,
                      args: payload?.args,
                    }),
                    { toolName, startImmediately: true },
                  );
                  if (redrawn) draftAnswerSource = null;
                }
              },
              onCompactionStart: async () => {
                if (turnSettled) return;
                if (statusReactions) await statusReactions.setCompacting();
              },
              onCompactionEnd: async () => {
                if (turnSettled) return;
                if (statusReactions) {
                  statusReactions.cancelPending();
                  await statusReactions.setThinking();
                }
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
    if (progressDraft) {
      try {
        progressDraft.compositor.cancel();
        progressDraft.close();
        // Whatever the draft still holds when the turn ends was not taken by a
        // final — the turn ended without one (NO_REPLY, an answer sent through
        // the `message` tool, an abort) or failed. Answer text streamed into it
        // is kept as the answer; a bare step list is dropped rather than left
        // saying "working" forever. Telegram does the same at this point
        // (finalizePendingAnswerBlockDraft, then cleanupDrafts). A draft the
        // final took is already detached, so `remove` does not touch it.
        if (draftAnswerSource !== null) {
          await sealDraftAnswer();
        } else if (progressDraft.currentMessageId() !== undefined) {
          await progressDraft.remove();
        }
      } catch (err) {
        runtime.log?.(`vk: progress-draft finalize failed: ${String(err)}`);
      }
    }
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
