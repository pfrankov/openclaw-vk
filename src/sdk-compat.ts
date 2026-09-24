// Plugin SDK types for the step-progress draft, kept in one place.
//
// The streaming config entry type was published in `channel-message` /
// `channel-outbound` up to 2026.7 and is internal since 2026.8; it describes
// data this plugin reads from its own config, so a local copy costs nothing.
// The mode type is still published and is re-exported rather than copied.

/** Streaming section of the VK channel config, as this plugin reads it. */
export type StreamingCompatEntry = {
  streaming?: unknown;
};

/**
 * Draft rendering mode accepted by `channels.vk.streaming.mode`.
 *
 * Re-exported from the core rather than restated: the literals were written out
 * here, in the config schema and in the core, and a mode added upstream would
 * have left this copy silently behind.
 */
export type { StreamingMode as ChannelProgressDraftMode } from "openclaw/plugin-sdk/channel-outbound";
