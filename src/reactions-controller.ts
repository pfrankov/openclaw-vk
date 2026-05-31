import {
  createStatusReactionController,
  DEFAULT_EMOJIS,
  type StatusReactionAdapter,
  type StatusReactionController,
  type StatusReactionEmojis,
  type StatusReactionTiming,
} from "openclaw/plugin-sdk/channel-feedback";
import { deleteReactionVk, sendReactionVk } from "./send.js";
import type { ResolvedVkAccount } from "./types.js";

/**
 * VK reactions are a fixed catalog of 16 emojis (see mapEmojiToVkReactionId
 * in send.ts), so the default OpenClaw status emoji set (👀🧠🛠️✅❌⏳⏱️ …)
 * would all fall back to the same VK reaction. Override every status with
 * the closest available VK emoji so the user can tell the states apart.
 */
export const VK_DEFAULT_STATUS_REACTION_EMOJIS: Required<StatusReactionEmojis> = {
  ...DEFAULT_EMOJIS,
  // 🎉 (id=16) marks the terminal "done" so it stands out from queued 👍.
  queued: "👍",
  thinking: "🤔",
  tool: "👌",
  coding: "👌",
  web: "🔥",
  deploy: "🔥",
  build: "👌",
  concierge: "👌",
  done: "🎉",
  error: "😡",
  stallSoft: "🤔",
  stallHard: "⁉️",
  compacting: "🙏",
};

export type VkStatusReactionParams = {
  peerId: number | string;
  cmid: number;
  account: ResolvedVkAccount;
  initialEmoji?: string;
  emojiOverrides?: StatusReactionEmojis;
  timing?: StatusReactionTiming;
  onError?: (err: unknown) => void;
};

export function createVkStatusReactionController(
  params: VkStatusReactionParams,
): StatusReactionController {
  const adapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      await sendReactionVk(String(params.peerId), params.cmid, emoji, params.account);
    },
    clearReaction: async () => {
      await deleteReactionVk(String(params.peerId), params.cmid, params.account);
    },
  };

  const emojis: StatusReactionEmojis = {
    ...VK_DEFAULT_STATUS_REACTION_EMOJIS,
    ...(params.emojiOverrides ?? {}),
  };

  return createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: params.initialEmoji ?? VK_DEFAULT_STATUS_REACTION_EMOJIS.queued,
    emojis,
    timing: params.timing,
    onError: params.onError,
  });
}
