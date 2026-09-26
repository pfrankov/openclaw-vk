import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/core";
import { globalAgent } from "node:https";
import { PollingTransport, VK } from "vk-io";
import { createStallWatchdog, type StallWatchdog } from "./stall-watchdog.js";
import { resolveVkAccount } from "./accounts.js";
import { handleVkInbound } from "./inbound.js";
import {
  extractVkInboundAttachments,
  extractVkInboundForwards,
  resolveVkInboundReplyContext,
} from "./media.js";
import { getVkRuntime, readVkRuntimeConfig } from "./runtime.js";
import { primeVkGroupId } from "./send.js";
import type { CoreConfig, VkAccountConfig, VkInboundMessage } from "./types.js";

const FIRST_LONG_POLL_CHECK_TIMEOUT_MS = 35_000;
const FIRST_LONG_POLL_CHECK_ERROR = "VK Long Poll transport check failed";

/**
 * Uses the first real poll as the readiness check, then hands control back to
 * vk-io's normal retrying fetch loop. This avoids a second preflight consumer
 * and ensures updates returned by the readiness poll enter the normal
 * middleware pipeline.
 */
/**
 * How long the transport may stay silent before we treat it as stalled.
 *
 * A long poll waits up to ~25 seconds for an event and then returns, so no
 * completed request for minutes is an anomaly rather than a quiet chat. The
 * gateway watches `lastTransportActivityAt` too, but with a half-hour default;
 * this only makes the same check faster.
 */
const DEFAULT_TRANSPORT_SILENCE_MS = 150_000;

/**
 * Resolved per account start, from the config the gateway hands in, never at
 * import time: the module is evaluated before the plugin runtime exists, so a
 * module-level read would only ever see the default, and a later config change
 * would not reach a constant. The environment still wins when set, because
 * changing a variable on a running gateway is the fastest way to answer
 * "is this knob the problem?".
 */
function resolveTransportSilenceMs(config: VkAccountConfig): number {
  const fromEnv = parseStrictPositiveInteger(process.env.VK_TRANSPORT_SILENCE_MS);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  return parseStrictPositiveInteger(config.transport?.silenceMs) ?? DEFAULT_TRANSPORT_SILENCE_MS;
}

class ReadinessPollingTransport extends PollingTransport {
  private readinessSettled = false;
  private firstFetchController: AbortController | undefined;
  private activeFetch: Promise<void> | undefined;
  private readonly firstSuccessfulPoll: Promise<void>;
  private resolveFirstSuccessfulPoll!: () => void;
  private rejectFirstSuccessfulPoll!: (error: Error) => void;
  private readonly onSuccessfulPoll: () => void;

  constructor(
    options: ConstructorParameters<typeof PollingTransport>[0],
    onSuccessfulPoll: () => void,
  ) {
    super(options);
    this.onSuccessfulPoll = onSuccessfulPoll;
    this.firstSuccessfulPoll = new Promise<void>((resolve, reject) => {
      this.resolveFirstSuccessfulPoll = resolve;
      this.rejectFirstSuccessfulPoll = reject;
    });
    // The observer is attached after transport bootstrap succeeds. Keep an
    // immediate failed poll from becoming an unhandled rejection meanwhile.
    void this.firstSuccessfulPoll.catch(() => {});
  }

  waitForFirstSuccessfulPoll(timeoutMs = FIRST_LONG_POLL_CHECK_TIMEOUT_MS): Promise<void> {
    const timeout = setTimeout(() => {
      this.settleReadinessFailure();
      this.firstFetchController?.abort();
    }, timeoutMs);
    return this.firstSuccessfulPoll.finally(() => clearTimeout(timeout));
  }

  private settleReadinessSuccess(): void {
    if (this.readinessSettled) {
      return;
    }
    this.readinessSettled = true;
    this.resolveFirstSuccessfulPoll();
  }

  private settleReadinessFailure(): void {
    if (this.readinessSettled) {
      return;
    }
    this.readinessSettled = true;
    this.rejectFirstSuccessfulPoll(new Error(FIRST_LONG_POLL_CHECK_ERROR));
  }

  private async fetchReadinessPoll(): Promise<void> {
    const controller = new AbortController();
    this.firstFetchController = controller;
    this.url.searchParams.set("ts", String(this.ts));
    this.url.searchParams.set("wait", "1");
    try {
      const response = await fetch(new URL(this.url), {
        method: "GET",
        signal: controller.signal,
        headers: { connection: "keep-alive" },
      });
      if (!response.ok) {
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      const result: unknown = await response.json();
      if (!result || typeof result !== "object") {
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      if ("failed" in result) {
        if (
          result.failed === 1
          && (typeof result.ts === "string" || typeof result.ts === "number")
        ) {
          this.ts = result.ts;
          return;
        }
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      if (
        !("updates" in result)
        || !Array.isArray(result.updates)
        || !("ts" in result)
        || (typeof result.ts !== "string" && typeof result.ts !== "number")
      ) {
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      this.restarted = 0;
      this.ts = result.ts;
      if ("pts" in result && (typeof result.pts === "string" || typeof result.pts === "number")) {
        this.pts = Number(result.pts);
      }
      for (const update of result.updates) {
        this.pollingHandler(update as unknown[]);
      }
    } catch {
      // Fetch errors can include the Long Poll URL/key. Never surface them.
      throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
    } finally {
      // Only the readiness check is shortened. Normal vk-io polling retains
      // its standard 25-second server wait after the first successful check.
      this.url.searchParams.set("wait", "25");
      if (this.firstFetchController === controller) {
        this.firstFetchController = undefined;
      }
    }
  }

  override async fetchUpdates(): Promise<void> {
    const isReadinessPoll = !this.readinessSettled;
    const activeFetch = isReadinessPoll ? this.fetchReadinessPoll() : super.fetchUpdates();
    this.activeFetch = activeFetch;
    try {
      await activeFetch;
      this.onSuccessfulPoll();
    } finally {
      if (this.activeFetch === activeFetch) {
        this.activeFetch = undefined;
      }
    }
  }

  override async stop(): Promise<void> {
    this.settleReadinessFailure();
    this.firstFetchController?.abort();
    await super.stop();
  }

  async stopAndDrain(): Promise<void> {
    const readinessFetch = this.readinessSettled ? undefined : this.activeFetch;
    await this.stop();
    // Drain only the abortable readiness request. After ready, preserve
    // vk-io's normal immediate stop semantics for its 25-second poll.
    await readinessFetch?.catch(() => {});
  }

  protected override async startFetchLoop(): Promise<void> {
    // vk-io recursively invokes this method after post-ready transport errors.
    // Only the initial invocation is a readiness probe; subsequent invocations
    // must retain vk-io's normal retry/restart behavior.
    if (this.readinessSettled) {
      await super.startFetchLoop();
      return;
    }

    try {
      await this.fetchUpdates();
      this.settleReadinessSuccess();
    } catch {
      this.settleReadinessFailure();
      return;
    }

    if (this.started) {
      await super.startFetchLoop();
    }
  }
}

export type VkMonitorOptions = {
  token: string;
  accountId: string;
  config: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
};

/**
 * Check whether the Bots Long Poll API is accessible for this token.
 * Requires the `manage` scope; tokens with only `messages` scope will fail.
 */
async function canUseBotsLongPoll(
  vk: VK,
): Promise<{ ok: boolean; groupId?: number; groupName?: string }> {
  try {
    const { groups } = await vk.api.groups.getById({});
    const groupId = groups[0]?.id;
    if (!groupId) {
      return { ok: false };
    }
    const groupName = groups[0]?.name;
    try {
      // Verify the token can actually start Bots LP
      await vk.api.groups.getLongPollServer({ group_id: groupId });
      return { ok: true, groupId, groupName };
    } catch {
      return { ok: false, groupId, groupName };
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
  // Our own stop signal: when the watchdog sees a stalled transport it ends the
  // account task, and the gateway brings the channel back with its own backoff.
  const localStop = new AbortController();
  const stopSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, localStop.signal])
    : localStop.signal;
  let stopRequested = false;
  let updatesStarted = false;
  let stopPromise: Promise<void> | undefined;
  let pollingTransport: ReadinessPollingTransport | undefined;
  let publishPollActivity = false;
  // Declared here so `finally` can reach it: the watchdog owns a timer, and a
  // start that fails before the watchdog is armed must still release it.
  let stallWatchdog: StallWatchdog | undefined;

  const stopUpdates = async (): Promise<void> => {
    stopRequested = true;
    if (!updatesStarted || !pollingTransport) {
      return;
    }
    if (!stopPromise) {
      stopPromise = pollingTransport.stopAndDrain().catch(() => {
        // ignore stop race/errors on shutdown
      });
    }
    await stopPromise;
  };

  // Ensure gateway stop triggers VK polling shutdown.
  opts.abortSignal?.addEventListener("abort", () => {
    void stopUpdates();
  }, { once: true });

  // Register message handler
  vk.updates.on("message_new", async (context) => {
    if (stopRequested) {
      return;
    }

    // Skip outgoing messages
    if (context.isOutbox) {
      return;
    }

    const peerId = context.peerId;
    const senderId = context.senderId;
    const text = context.text ?? "";
    const isGroup = peerId >= 2_000_000_000;
    const attachments = extractVkInboundAttachments(context.attachments);
    const replyContext = resolveVkInboundReplyContext(context.replyMessage);
    const forwards = extractVkInboundForwards(context.forwards);
    const createdAtSeconds =
      typeof context.createdAt === "number" && Number.isFinite(context.createdAt)
        ? context.createdAt
        : undefined;

    const message: VkInboundMessage = {
      messageId: String(context.id),
      conversationMessageId:
        typeof context.conversationMessageId === "number" && Number.isFinite(context.conversationMessageId)
          ? context.conversationMessageId
          : undefined,
      peerId,
      senderId,
      text,
      timestamp: createdAtSeconds ? createdAtSeconds * 1000 : Date.now(),
      isGroup,
      messagePayload: context.messagePayload,
      attachments,
      replyToMessageId: replyContext.replyToMessageId,
      replyToText: replyContext.replyToText,
      ...(replyContext.replyToTimestamp !== undefined ? { replyToTimestamp: replyContext.replyToTimestamp } : {}),
      replyToSenderId: replyContext.replyToSenderId,
      ...(forwards.length > 0 ? { forwards } : {}),
      replyToForwards: replyContext.replyToForwards,
    };

    core.channel.activity.record({
      channel: "vk",
      accountId: account.accountId,
      direction: "inbound",
      at: message.timestamp,
    });
    opts.setStatus?.({ lastEventAt: Date.now() });

    try {
      const currentCfg = readVkRuntimeConfig(core);
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
    if (stopRequested || opts.abortSignal?.aborted) {
      return;
    }
    if (botsLp.groupId !== undefined) {
      primeVkGroupId(opts.token, botsLp.groupId, botsLp.groupName);
    }
    const useBotsLongPoll = botsLp.ok && botsLp.groupId !== undefined;
    // The only honest liveness signal is "a poll request came back". The cursor
    // is not one: it moves on EVENTS, so it sits still for hours on a quiet
    // channel; and `isStarted` stays true on a wedged transport.
    stallWatchdog = createStallWatchdog({
      label: `vk:${opts.accountId} long-poll`,
      timeoutMs: resolveTransportSilenceMs(account.config),
      abortSignal: stopSignal,
      runtime: opts.runtime,
      onTimeout: ({ idleMs }) => {
        const silentSec = Math.round(idleMs / 1000);
        opts.setStatus?.(
          channelStoppedPatch({
            lastError: `no completed long-poll request for ${silentSec}s`,
            lastDisconnect: {
              at: Date.now(),
              error: `long poll silent for ${silentSec}s`,
            },
          }),
        );
        localStop.abort();
      },
    });

    pollingTransport = new ReadinessPollingTransport(
      {
        api: vk.api,
        agent: globalAgent,
        pollingWait: 3_000,
        pollingRetryLimit: 3,
        ...(useBotsLongPoll ? { pollingGroupId: botsLp.groupId } : {}),
      },
      () => {
        stallWatchdog?.touch();
        if (publishPollActivity) {
          opts.setStatus?.({ lastTransportActivityAt: Date.now() });
        }
      },
    );
    pollingTransport.subscribe((update) =>
      useBotsLongPoll
        ? vk.updates.handleWebhookUpdate(update as unknown as Record<string, unknown>)
        : vk.updates.handlePollingUpdate(update),
    );

    if (useBotsLongPoll) {
      opts.runtime.log?.(`[${opts.accountId}] using Bots Long Poll (group ${botsLp.groupId})`);
      await pollingTransport.start();
    } else {
      opts.runtime.log?.(
        `[${opts.accountId}] Bots Long Poll unavailable, falling back to User Long Poll`,
      );
      await pollingTransport.start();
    }
    updatesStarted = true;

    // An abort may arrive while vk-io is awaiting its Long Poll server. Stop
    // the newly started transport before publishing a false-ready snapshot.
    if (stopRequested || opts.abortSignal?.aborted) {
      await stopUpdates();
      return;
    }

    try {
      await pollingTransport.waitForFirstSuccessfulPoll();
    } catch (error) {
      if (stopRequested || opts.abortSignal?.aborted) {
        return;
      }
      throw error;
    }

    if (stopRequested || opts.abortSignal?.aborted) {
      await stopUpdates();
      return;
    }

    const connectedAt = Date.now();
    publishPollActivity = true;
    opts.setStatus?.(
      channelReadyPatch({
        mode: "longpoll",
        lastConnectedAt: connectedAt,
        lastTransportActivityAt: connectedAt,
      }),
    );

    // Armed only after the first successful poll: the connect handshake has no
    // completed poll behind it and would trip the watchdog on every start.
    stallWatchdog.arm(connectedAt);

    // Keep lifecycle alive until the gateway requests stop, or the watchdog
    // ends it because the transport went silent.
    await waitForAbort(stopSignal);
  } finally {
    try {
      await stopUpdates();
    } finally {
      // Unconditional: a failed start never armed the watchdog, so nothing else
      // would ever stop it, and each retry would leave another interval behind.
      stallWatchdog?.stop();
      localStop.abort();
    }
  }
}
