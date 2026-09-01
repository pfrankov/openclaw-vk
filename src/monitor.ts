import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { VK } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import { handleVkInbound } from "./inbound.js";
import {
  extractVkInboundAttachments,
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

// ── Long-poll watchdog tunables (env-overridable) ──────────────────────────
// vk-io's polling has internal retry but it is SILENT (debug-only) and can get
// wedged so that the long-poll request stops delivering updates while the API
// itself stays healthy — which manifests as "VK goes silent until the gateway
// is restarted" (commonly right after a gateway restart). The watchdog below
// supervises the poller via vk-io's internal `ts` event cursor plus an active
// token probe: a moving cursor proves liveness for free, while a static or
// unreadable cursor triggers a probe (never an immediate restart — VK's cursor
// does NOT advance on empty idle polls). When the token is genuinely
// unreachable, the poller is recreated in-place (no gateway restart), with a
// logged reason and backoff.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
// How often to inspect the poller heartbeat.
const WATCHDOG_INTERVAL_MS = envInt("VK_LP_WATCHDOG_INTERVAL_MS", 30_000);
// When the `ts` cursor is static or unreadable, probe the API after this much
// idle, and restart after this many consecutive probe failures. (VK_LP_TS_STALE_MS
// is retired: VK's `ts` is an event cursor that legitimately stays static on an
// idle channel, so cursor staleness alone must never trigger a restart.)
const IDLE_BEFORE_PROBE_MS = envInt("VK_LP_IDLE_PROBE_MS", 90_000);
const PROBE_FAIL_LIMIT = envInt("VK_LP_PROBE_FAIL_LIMIT", 3);
const RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

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

/**
 * Read vk-io's internal long-poll cursor (`ts`) as a string. VK's `ts` is an
 * EVENT cursor, not a per-request heartbeat: it advances only when the poll
 * delivers new events, and empty (idle) polls return the SAME value. User Long
 * Poll exposes it as a number; Bots Long Poll (groups.getLongPollServer) returns
 * it as a JSON string (e.g. "9") and vk-io stores it unchanged — so both types
 * must be accepted. Returns undefined when the field is not accessible (e.g.
 * webhook mode or a vk-io version that renames it).
 */
export function readPollingCursor(vk: VK): string | undefined {
  const transport = (vk.updates as unknown as { pollingTransport?: { ts?: unknown } })
    ?.pollingTransport;
  const ts = transport?.ts;
  if (typeof ts === "number") return String(ts);
  if (typeof ts === "string" && ts.length > 0) return ts;
  return undefined;
}

/**
 * Fallback liveness probe (used only when the `ts` cursor is unreadable):
 * confirms the token can still reach VK. Uses groups.getById, which does NOT
 * touch the active long-poll key.
 */
async function probeTokenAlive(vk: VK): Promise<boolean> {
  try {
    await vk.api.groups.getById({});
    return true;
  } catch {
    return false;
  }
}

/** Resolve after `ms`, or immediately when the abort signal fires. */
function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Start monitoring VK community messages via Long Poll API.
 * Prefers Bots Long Poll when the token has the `manage` scope; falls back to
 * User Long Poll (messages.getLongPollServer) when only `messages` is available.
 *
 * The poller is supervised: if it stalls (heartbeat frozen) or stops, it is
 * torn down and recreated in-place (with backoff) so VK ingress recovers
 * WITHOUT a gateway restart. Every restart is logged (vk-io's own retries are
 * debug-only/silent).
 */
export async function monitorVkProvider(opts: VkMonitorOptions): Promise<void> {
  const core = getVkRuntime();
  const account = resolveVkAccount({
    cfg: opts.config,
    accountId: opts.accountId,
  });
  const tag = `[${opts.accountId}]`;

  let stopped = false;
  const onAbort = () => {
    stopped = true;
  };
  if (opts.abortSignal?.aborted) {
    return;
  }
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  let restartAttempt = 0;

  try {
    while (!stopped) {
      const vk = new VK({ token: opts.token, apiLimit: 20 });
      let needRestart = false;
      let restartReason = "";

      const requestRestart = (reason: string) => {
        if (needRestart) return;
        needRestart = true;
        restartReason = reason;
      };

      vk.updates.on("message_new", async (context) => {
        if (stopped || needRestart) {
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
        };

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

      let groupId: number | undefined;
      const stopVk = async () => {
        try {
          await vk.updates.stop();
        } catch {
          // ignore stop race/errors on shutdown/restart
        }
      };

      try {
        // Detect whether Bots LP is available; fall back to User LP otherwise.
        const botsLp = await canUseBotsLongPoll(vk);
        groupId = botsLp.groupId;
        if (groupId !== undefined) {
          primeVkGroupId(opts.token, groupId);
        }
        if (botsLp.ok && groupId !== undefined) {
          opts.runtime.log?.(`${tag} using Bots Long Poll (group ${groupId})`);
          await vk.updates.start();
        } else {
          opts.runtime.log?.(
            `${tag} Bots Long Poll unavailable, falling back to User Long Poll`,
          );
          await vk.updates.startPolling();
        }

        // Poller started successfully — reset backoff.
        restartAttempt = 0;

        // ── Watchdog loop (probe-based liveness) ────────────────────────
        // A MOVING cursor is a free liveness proof. A static cursor is
        // ambiguous — it means EITHER a genuinely idle channel (empty polls
        // don't advance VK's event cursor) OR a wedged poll loop — so it never
        // restarts anything on its own. When the cursor is static or unreadable
        // for long enough, we actively probe the token and restart only after
        // repeated probe failures (a real outage), never on quiet alone.
        let lastCursor = readPollingCursor(vk);
        let lastBeatAt = Date.now();
        let probeFailures = 0;
        while (!stopped && !needRestart) {
          await interruptibleDelay(WATCHDOG_INTERVAL_MS, opts.abortSignal);
          if (stopped || needRestart) break;

          // The polling transport stopped entirely.
          if (!vk.updates.isStarted) {
            requestRestart("polling transport stopped (isStarted=false)");
            break;
          }

          const cursor = readPollingCursor(vk);
          if (cursor !== undefined && cursor !== lastCursor) {
            // Cursor advanced → the poll loop delivered events. Alive.
            lastCursor = cursor;
            lastBeatAt = Date.now();
            probeFailures = 0;
            continue;
          }

          // Cursor static or unreadable → probe the token after a long idle.
          // Restart only on repeated probe failures, never on a quiet cursor.
          if (Date.now() - lastBeatAt >= IDLE_BEFORE_PROBE_MS) {
            const alive = await probeTokenAlive(vk);
            lastBeatAt = Date.now();
            if (alive) {
              probeFailures = 0;
            } else {
              probeFailures += 1;
              opts.runtime.log?.(
                `${tag} VK token probe failed (${probeFailures}/${PROBE_FAIL_LIMIT})`,
              );
              if (probeFailures >= PROBE_FAIL_LIMIT) {
                requestRestart("VK token unreachable");
                break;
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        requestRestart(`poller error: ${msg}`);
      } finally {
        await stopVk();
      }

      if (stopped) {
        break;
      }

      // Backoff before recreating the poller.
      const backoff =
        RESTART_BACKOFF_MS[Math.min(restartAttempt, RESTART_BACKOFF_MS.length - 1)];
      restartAttempt += 1;
      opts.runtime.log?.(
        `${tag} VK long-poll restarting in ${Math.round(backoff / 1000)}s — ${restartReason || "unknown reason"}`,
      );
      await interruptibleDelay(backoff, opts.abortSignal);
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
  }
}
