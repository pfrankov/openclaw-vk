import type { ChannelProgressDraftMode, StreamingCompatEntry } from "./sdk-compat.js";
import {
  createChannelProgressDraftCompositor,
  resolveChannelProgressDraftConfig,
} from "openclaw/plugin-sdk/channel-outbound";

/**
 * The compositor type is derived from the factory rather than imported.
 *
 * `ChannelProgressDraftCompositor` was only declared in the 2026.7 SDK; 2026.8
 * has no such type, so the import was broken and survived merely because the
 * build runs esbuild without typechecking. `ReturnType` gives the same type and
 * does not depend on the core version.
 */
type ChannelProgressDraftCompositor = ReturnType<typeof createChannelProgressDraftCompositor>;
import { vkDiag } from "./diagnostics.js";
import { deleteMessageVk, editMessageVk, sendMessageVk } from "./send.js";
import type { CoreConfig, ResolvedVkAccount } from "./types.js";

/**
 * VK step-progress draft: keeps a SINGLE bot message and rewrites it in place
 * with the running list of execution steps (🛠️ tool calls, 🔎 web search …),
 * mirroring Telegram's `streaming.mode: "progress"`.
 *
 * The hard part — the delayed-start gate, dedup, truncation and multi-line
 * rendering — lives in the core `createChannelProgressDraftCompositor`
 * (openclaw/plugin-sdk/channel-outbound). This module only supplies the two
 * VK-specific primitives the compositor drives:
 *   - `update(text)`      → lazily create the draft (messages.send) then edit it
 *                           in place (messages.edit) on every subsequent render;
 *   - `deleteCurrent()`   → drop the draft (messages.delete).
 * It is the exact analogue of reactions-controller.ts, which adapts VK reactions
 * onto the core status-reaction controller.
 */
export type VkProgressDraftParams = {
  /** Normalized VK peer id the draft is sent to. */
  to: string;
  /** Resolved account (used for in-place edit/delete of our own message). */
  account: ResolvedVkAccount;
  /** Account id + config threaded to the first `sendMessageVk` call. */
  accountId?: string;
  cfg?: CoreConfig;
  /** Channel config entry — the compositor reads streaming.preview/labels from it. */
  entry: StreamingCompatEntry | null | undefined;
  /** Resolved streaming mode (progress|block|partial|off); pass "progress". */
  mode: ChannelProgressDraftMode;
  /** Stable per-turn seed so the compositor can distinguish turns. */
  seed: string;
  /**
   * Message the draft quotes, when the ordinary reply would quote it (a group
   * chat, a button press). Only the first draft message of the turn carries it,
   * as only the first message of an ordinary reply does.
   */
  replyTo?: string;
  onError?: (err: unknown) => void;
};

/**
 * Live draft label for the progress bubble.
 *
 * Resolved through the core rather than by walking the config by hand. The core
 * treats `label: "auto"` as "pick one of `labels`" and `label: false` as "hide
 * it"; reading the raw value printed the literal string "auto" as a header and
 * had no way to express `false`. It also reads the same `entry` the compositor
 * is given, so the two cannot disagree on a per-account config.
 */
export function resolveVkProgressLabel(
  entry: StreamingCompatEntry | null | undefined,
): string | undefined {
  const label = resolveChannelProgressDraftConfig(entry).label;
  // `false` hides the title and "auto" asks the core to pick one; neither means
  // "prefix this literal string", which is what reading the raw value did — it
  // printed "auto" as a header and could not express `false` at all. Only an
  // explicit label is prefixed here, so the default stays "no header", as
  // before.
  return typeof label === "string" && label.trim() && label.trim() !== "auto"
    ? label.trim()
    : undefined;
}

/**
 * Handle to the single live draft message. Exposed so the deliver/finalize path
 * can rewrite it into the final answer (or delete it) without re-sending.
 */
export type VkProgressDraftHandle = {
  compositor: ChannelProgressDraftCompositor;
  /** message_id of the live draft, or undefined before the first render / after delete. */
  currentMessageId(): number | undefined;
  /** Replace the draft's text in place; falls back to a fresh send if the edit fails. */
  /**
   * Rewrite the draft. Resolves to `false` when the text did not make it —
   * callers fall back to sending the block as a normal message. It never
   * rejects: a throwing draft must not take the reply down with it.
   */
  overwrite(text: string): Promise<boolean>;
  /** Remove the draft message entirely (best-effort). */
  remove(): Promise<void>;
  /**
   * Let go of the current message without deleting it: it now holds a finished
   * part of the answer. The next render starts a fresh draft below it.
   */
  detach(): void;
  /**
   * Seal the draft: after this, `overwrite` is a no-op so a late compositor
   * render can never spawn a fresh message once the turn has finalized.
   */
  close(): void;
};

export function createVkProgressDraftCompositor(
  params: VkProgressDraftParams,
): VkProgressDraftHandle {
  // The single "live" message we keep editing. Lazily created on first update.
  let messageId: number | undefined;
  // Once the turn has finalized we stop touching VK, so a straggler compositor
  // render can't create a brand-new message after the answer is delivered.
  let closed = false;
  // Only the first draft message of the turn quotes; a draft started below a
  // frozen answer part is a continuation.
  let quoted = false;

  // The live draft label (`streaming.progress.label`). The compositor puts it
  // on the step renders it produces, but text blocks are written straight
  // through `overwrite` and never pass the compositor, so the label is added
  // here, at the single write point. The startsWith check keeps a step render
  // that already carries it from getting it twice.
  const resolveProgressLabel = (): string | undefined => resolveVkProgressLabel(params.entry);

  // A send that went out without a usable message id leaves a message this turn
  // can neither edit nor delete; drafting again would add one per step.
  let unusableSend = false;

  // Drops a draft message this turn can no longer edit, so no stale "working"
  // message is left behind. Best effort: a failed delete is only reported.
  const dropStaleDraft = async (id: number): Promise<void> => {
    try {
      await deleteMessageVk(params.to, id, params.account);
      vkDiag("step-progress stale draft removed", { msgId: id });
    } catch (err) {
      params.onError?.(err);
    }
  };

  const overwrite = async (rawText: string): Promise<boolean> => {
    if (closed || unusableSend) {
      return false;
    }
    const label = resolveProgressLabel();
    const text =
      label && !rawText.startsWith(label) ? `${label}\n\n${rawText}` : rawText;
    try {
      if (messageId === undefined) {
        const result = await sendMessageVk(params.to, text, {
          cfg: params.cfg,
          accountId: params.accountId,
          ...(params.replyTo && !quoted ? { replyTo: params.replyTo } : {}),
        });
        const id = Number(result.messageId);
        messageId = Number.isFinite(id) && id > 0 ? id : undefined;
        if (messageId !== undefined) {
          quoted = true;
        } else {
          unusableSend = true;
        }
        vkDiag("step-progress draft sent", { msgId: messageId ?? 0, len: text.length });
        return messageId !== undefined;
      }
      const ok = await editMessageVk(params.to, messageId, text, params.account);
      vkDiag("step-progress draft edited", { msgId: messageId, ok, len: text.length });
      if (!ok) {
        // Edit window elapsed or message gone — drop it and forget it so the
        // next render starts a fresh draft instead of silently dropping progress.
        const stale = messageId;
        messageId = undefined;
        await dropStaleDraft(stale);
      }
      return ok;
    } catch (err) {
      // A throw leaves the same dead id behind as a `false` result would, so it
      // is dropped and forgotten here too — otherwise the draft freezes on that
      // message and the documented fresh-send fallback never fires.
      const stale = messageId;
      messageId = undefined;
      params.onError?.(err);
      if (stale !== undefined) {
        await dropStaleDraft(stale);
      }
      return false;
    }
  };

  const remove = async (): Promise<void> => {
    if (messageId === undefined) {
      return;
    }
    const id = messageId;
    messageId = undefined;
    try {
      await deleteMessageVk(params.to, id, params.account);
      vkDiag("step-progress draft removed", { msgId: id });
    } catch (err) {
      params.onError?.(err);
    }
  };

  const compositor = createChannelProgressDraftCompositor({
    entry: params.entry,
    mode: params.mode,
    active: true,
    seed: params.seed,
    update: overwrite,
    deleteCurrent: remove,
  });

  return {
    compositor,
    currentMessageId: () => messageId,
    overwrite,
    remove,
    detach: () => {
      messageId = undefined;
    },
    close: () => {
      closed = true;
    },
  };
}
