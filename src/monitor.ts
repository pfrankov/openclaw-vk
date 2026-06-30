import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { VK } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import { handleVkInbound } from "./inbound.js";
import {
  extractVkInboundAttachments,
  resolveVkInboundBodyText,
  resolveVkInboundGeo,
  resolveVkInboundReplyContext,
} from "./media.js";
import { getVkRuntime } from "./runtime.js";
import { primeVkGroupId } from "./send.js";
import type { CoreConfig, VkInboundMessage } from "./types.js";

export type VkMonitorOptions = {
  token: string;
  accountId: string;
  config: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
};

type VkApiMessagePayload = {
  id?: number;
  conversation_message_id?: number;
  from_id?: number;
  date?: number;
  text?: string;
  attachments?: unknown[];
  geo?: unknown;
  reply_message?: unknown;
  payload?: unknown;
};

function resolveVkContextGeo(context: {
  geo?: unknown;
  message?: { geo?: unknown } | undefined;
  payload?: { message?: { geo?: unknown } | undefined } | undefined;
}): unknown {
  return context.geo ?? context.message?.geo ?? context.payload?.message?.geo;
}

function isVkContextHydrated(context: { $filled?: unknown }): boolean {
  return context.$filled === true;
}

function shouldEnrichFromApi(context: {
  $filled?: unknown;
  geo?: unknown;
  message?: { geo?: unknown } | undefined;
  payload?: { message?: { geo?: unknown } | undefined } | undefined;
}): boolean {
  return !isVkContextHydrated(context) || resolveVkContextGeo(context) == null;
}

function hasVkGeoSignal(context: {
  hasGeo?: unknown;
  geo?: unknown;
  message?: { geo?: unknown } | undefined;
  payload?: { message?: { geo?: unknown } | undefined } | undefined;
}): boolean {
  return Boolean(context.hasGeo || resolveVkContextGeo(context));
}

function resolveVkMessagePayload(rawPayload: unknown): unknown {
  if (typeof rawPayload !== "string") {
    return rawPayload;
  }
  try {
    return JSON.parse(rawPayload);
  } catch {
    return rawPayload;
  }
}

async function fetchVkApiMessagePayload(params: {
  vk: VK;
  context: {
    id: number;
    peerId: number;
    conversationMessageId: number;
  };
  runtime: RuntimeEnv;
}): Promise<VkApiMessagePayload | undefined> {
  try {
    const response =
      params.context.id !== 0
        ? await params.vk.api.messages.getById({
            message_ids: params.context.id,
          })
        : await params.vk.api.messages.getByConversationMessageId({
            peer_id: params.context.peerId,
            conversation_message_ids: params.context.conversationMessageId,
          });
    return response.items[0] as VkApiMessagePayload | undefined;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    params.runtime.log?.(
      `vk: direct API fetch failed for peerId=${params.context.peerId} messageId=${params.context.id}: ${errorMessage}`,
    );
    return undefined;
  }
}

async function fetchVkApiMessagePayloadFromHistory(params: {
  vk: VK;
  context: {
    id: number;
    peerId: number;
    conversationMessageId: number;
    senderId?: number;
    text?: string;
    createdAt?: number;
  };
  runtime: RuntimeEnv;
}): Promise<VkApiMessagePayload | undefined> {
  try {
    const response = await params.vk.api.messages.getHistory({
      peer_id: params.context.peerId,
      count: 10,
    });
    const items = response.items as VkApiMessagePayload[] | undefined;
    if (!Array.isArray(items) || items.length === 0) {
      return undefined;
    }
    const normalizedText = params.context.text?.trim();
    return items.find((item) => {
      if (typeof item !== "object" || item == null) {
        return false;
      }
      if (item.id === params.context.id && params.context.id !== 0) {
        return true;
      }
      if (item.conversation_message_id === params.context.conversationMessageId) {
        return true;
      }
      if (
        normalizedText &&
        item.text?.trim() === normalizedText &&
        item.from_id === params.context.senderId
      ) {
        return true;
      }
      if (
        typeof item.date === "number" &&
        typeof params.context.createdAt === "number" &&
        Math.abs(item.date - params.context.createdAt) <= 120 &&
        item.from_id === params.context.senderId
      ) {
        return true;
      }
      return false;
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    params.runtime.log?.(
      `vk: history API fetch failed for peerId=${params.context.peerId} messageId=${params.context.id}: ${errorMessage}`,
    );
    return undefined;
  }
}

/**
 * Check whether the Bots Long Poll API is accessible for this token.
 * Requires the `manage` scope; tokens with only `messages` scope will fail.
 */
async function canUseBotsLongPoll(vk: VK): Promise<{ ok: boolean; groupId?: number }> {
  try {
    const { groups } = await vk.api.groups.getById({});
    const groupId = groups[0]?.id;
    if (!groupId) {
      return { ok: false };
    }
    try {
      // Verify the token can actually start Bots LP
      await vk.api.groups.getLongPollServer({ group_id: groupId });
      return { ok: true, groupId };
    } catch {
      return { ok: false, groupId };
    }
  } catch {
    return { ok: false };
  }
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>(() => {});
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Start monitoring VK community messages via Long Poll API.
 * Prefers Bots Long Poll when the token has the `manage` scope;
 * falls back to User Long Poll (messages.getLongPollServer) when only
 * the `messages` scope is available.
 */
export async function monitorVkProvider(opts: VkMonitorOptions): Promise<void> {
  const core = getVkRuntime();
  const account = resolveVkAccount({
    cfg: opts.config,
    accountId: opts.accountId,
  });

  const vk = new VK({ token: opts.token, apiLimit: 20 });
  let stopped = false;

  const stopUpdates = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      await vk.updates.stop();
    } catch {
      // ignore stop race/errors on shutdown
    }
  };

  // Ensure gateway stop triggers VK polling shutdown.
  opts.abortSignal?.addEventListener("abort", () => {
    void stopUpdates();
  });

  // Register message handler
  vk.updates.on("message_new", async (context) => {
    if (stopped) {
      return;
    }

    // Skip outgoing messages
    if (context.isOutbox) {
      return;
    }

    const geoSignalPresent = hasVkGeoSignal(context);
    let fetchedMessage: VkApiMessagePayload | undefined;
    if (geoSignalPresent && shouldEnrichFromApi(context)) {
      fetchedMessage = await fetchVkApiMessagePayload({
        vk,
        context: {
          id: context.id,
          peerId: context.peerId,
          conversationMessageId: context.conversationMessageId,
        },
        runtime: opts.runtime,
      });
      if (!fetchedMessage) {
        try {
          await context.loadMessagePayload?.();
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          opts.runtime.log?.(
            `vk: failed to hydrate message payload for peerId=${context.peerId} messageId=${context.id}: ${errorMessage}`,
          );
        }
      }
    }

    if (geoSignalPresent && !fetchedMessage?.geo) {
      const historyMessage = await fetchVkApiMessagePayloadFromHistory({
        vk,
        context: {
          id: context.id,
          peerId: context.peerId,
          conversationMessageId: context.conversationMessageId,
          senderId: context.senderId,
          text: context.text,
          createdAt: context.createdAt,
        },
        runtime: opts.runtime,
      });
      if (historyMessage) {
        fetchedMessage = {
          ...historyMessage,
          ...fetchedMessage,
          geo: fetchedMessage?.geo ?? historyMessage.geo,
          attachments: fetchedMessage?.attachments ?? historyMessage.attachments,
          payload: fetchedMessage?.payload ?? historyMessage.payload,
          reply_message: fetchedMessage?.reply_message ?? historyMessage.reply_message,
          text: fetchedMessage?.text ?? historyMessage.text,
        };
      }
    }

    const peerId = context.peerId;
    const senderId = context.senderId;
    const text = fetchedMessage?.text ?? context.text ?? "";
    const isGroup = peerId >= 2_000_000_000;
    const attachments = extractVkInboundAttachments(fetchedMessage?.attachments ?? context.attachments);
    const rawGeo = fetchedMessage?.geo ?? resolveVkContextGeo(context);
    const geo = resolveVkInboundGeo(rawGeo);
    opts.runtime.log?.(
      `vk: inbound message_new peerId=${peerId} messageId=${context.id} hydrated=${isVkContextHydrated(
        context,
      )} hasGeo=${Boolean(context.hasGeo || rawGeo || fetchedMessage?.geo)} resolvedGeo=${Boolean(
        geo,
      )} textLen=${text.length} attachments=${attachments.length}`,
    );
    const visibleBody = resolveVkInboundBodyText({
      text,
      attachments,
      geo,
    });
    const replyContext = resolveVkInboundReplyContext(
      fetchedMessage?.reply_message ?? context.replyMessage,
    );
    const createdAtSeconds =
      typeof context.createdAt === "number" && Number.isFinite(context.createdAt)
        ? context.createdAt
        : undefined;

    const message: VkInboundMessage = {
      messageId: String(context.id),
      conversationMessageId:
        typeof context.conversationMessageId === "number" &&
        Number.isFinite(context.conversationMessageId)
          ? context.conversationMessageId
          : typeof fetchedMessage?.conversation_message_id === "number" &&
              Number.isFinite(fetchedMessage.conversation_message_id)
            ? fetchedMessage.conversation_message_id
            : undefined,
      peerId,
      senderId,
      text: visibleBody,
      timestamp: createdAtSeconds ? createdAtSeconds * 1000 : Date.now(),
      isGroup,
      messagePayload: resolveVkMessagePayload(fetchedMessage?.payload ?? context.messagePayload),
      geo,
      attachments,
      replyToMessageId: replyContext.replyToMessageId,
      replyToText: replyContext.replyToText,
    };

    if ((context.hasGeo || rawGeo || fetchedMessage?.geo) && !geo) {
      opts.runtime.log?.(
        `vk: geo present but unresolved for peerId=${peerId} messageId=${context.id}; rawGeo=${JSON.stringify(rawGeo)}`,
      );
    }

    core.channel.activity.record({
      channel: "vk",
      accountId: account.accountId,
      direction: "inbound",
      at: message.timestamp,
    });

    try {
      const currentCfg = core.config.loadConfig() as CoreConfig;
      const currentAccount = resolveVkAccount({
        cfg: currentCfg,
        accountId: account.accountId,
      });

      await handleVkInbound({
        message,
        account: currentAccount,
        config: currentCfg,
        runtime: opts.runtime,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      opts.runtime.error?.(`vk: message handler error for peerId=${peerId}: ${errorMessage}`);
    }
  });

  try {
    // Detect whether Bots LP is available; fall back to User LP otherwise
    const botsLp = await canUseBotsLongPoll(vk);
    if (botsLp.groupId !== undefined) {
      primeVkGroupId(opts.token, botsLp.groupId);
    }
    if (botsLp.ok && botsLp.groupId !== undefined) {
      opts.runtime.log?.(`[${opts.accountId}] using Bots Long Poll (group ${botsLp.groupId})`);
      await vk.updates.start();
    } else {
      // User Long Poll: call startPolling() directly, which skips auto-detection
      // and uses messages.getLongPollServer since pollingGroupId is unset.
      opts.runtime.log?.(
        `[${opts.accountId}] Bots Long Poll unavailable, falling back to User Long Poll`,
      );
      await vk.updates.startPolling();
    }

    // Keep lifecycle alive until gateway requests stop.
    await waitForAbort(opts.abortSignal);
  } finally {
    await stopUpdates();
  }
}
