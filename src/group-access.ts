/**
 * Who may speak in a VK group chat, computed once for every gate that asks.
 *
 * The inbound gate and question buttons must agree: a button checked against
 * the raw account `groupPolicy` ignored `channels.defaults.groupPolicy` and the
 * provider fallback, so an inherited "open" refused a press the inbound gate
 * admitted, an inherited "disabled" still let one through, and an explicit
 * "open" with an allowlist refused senders outside it (review of #20).
 *
 * The effective policy comes from the core's resolvers, a disabled chat or
 * policy refuses first, and the sender allowlist (per-chat `allowFrom`, else
 * `groupAllowFrom`) counts only in "allowlist" mode.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveEffectiveAllowFromLists } from "openclaw/plugin-sdk/channel-policy";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeVkAllowlist, resolveVkAllowlistMatch } from "./send-support.js";
import type { CoreConfig, ResolvedVkAccount } from "./types.js";

export type VkGroupAccess = {
  groupConfig: NonNullable<ResolvedVkAccount["config"]["groups"]>[string] | undefined;
  groupPolicy: "open" | "allowlist" | "disabled";
  providerMissingFallbackApplied: boolean;
  /** The account-level group allowlist, as the command gate counts it. */
  effectiveGroupAllowFrom: string[];
  /** The list a sender is matched against: the chat's own, else the account's. */
  effectiveGroupSenderAllowFrom: string[];
};

export type VkGroupSenderAdmission =
  | { allowed: true }
  | { allowed: false; reason: "chat-disabled" | "policy-disabled" | "not-allowlisted" };

export function resolveVkGroupAccess(params: {
  config: CoreConfig;
  account: ResolvedVkAccount;
  peerId: number;
}): VkGroupAccess {
  const { config, account } = params;
  const groupConfig =
    account.config.groups?.[String(params.peerId)] ?? account.config.groups?.["*"];
  const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: config.channels?.vk !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(config as OpenClawConfig),
  });
  const { effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: normalizeVkAllowlist(account.config.allowFrom),
    groupAllowFrom: normalizeVkAllowlist(account.config.groupAllowFrom),
    groupAllowFromFallbackToAllowFrom: false,
  });
  const groupAllowOverride =
    groupConfig && Object.hasOwn(groupConfig, "allowFrom")
      ? normalizeVkAllowlist(groupConfig.allowFrom)
      : undefined;
  return {
    groupConfig,
    groupPolicy: groupPolicy as VkGroupAccess["groupPolicy"],
    providerMissingFallbackApplied,
    effectiveGroupAllowFrom,
    effectiveGroupSenderAllowFrom: groupAllowOverride ?? effectiveGroupAllowFrom,
  };
}

export function resolveVkGroupSenderAdmission(
  access: VkGroupAccess,
  senderId: number,
): VkGroupSenderAdmission {
  if (access.groupConfig?.enabled === false) {
    return { allowed: false, reason: "chat-disabled" };
  }
  if (access.groupPolicy === "disabled") {
    return { allowed: false, reason: "policy-disabled" };
  }
  if (
    access.groupPolicy === "allowlist" &&
    !resolveVkAllowlistMatch({ allowFrom: access.effectiveGroupSenderAllowFrom, senderId }).allowed
  ) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}
