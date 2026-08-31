import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  listVkAccountIds,
  resolveDefaultVkAccountId,
  resolveVkAccount,
  type ResolvedVkAccount,
} from "./accounts.js";
import { VkConfigSchema } from "./config-schema.js";
import { vkSetupAdapter } from "./setup-core.js";
import { vkSetupWizard } from "./setup-surface.js";

const meta = {
  id: "vk",
  label: "VK",
  selectionLabel: "VK (VKontakte Bot)",
  detailLabel: "VK Bot",
  docsPath: "/channels/vk",
  docsLabel: "vk",
  blurb: "VK (VKontakte) community bot via Long Poll API.",
  systemImage: "message.fill",
} as const;

const normalizeVkAllowFrom = (entry: string) => entry.replace(/^vk:(?:user:)?/i, "");

export const vkSetupPlugin: ChannelPlugin<ResolvedVkAccount> = {
  id: "vk",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.vk"] },
  configSchema: buildChannelConfigSchema(VkConfigSchema),
  config: {
    listAccountIds: (cfg: OpenClawConfig) => listVkAccountIds(cfg),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveVkAccount({ cfg, accountId: accountId ?? undefined }),
    defaultAccountId: (cfg: OpenClawConfig) => resolveDefaultVkAccountId(cfg),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource ?? undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveVkAccount({ cfg, accountId: accountId ?? undefined }).config.allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => normalizeVkAllowFrom(entry)),
  },
  setupWizard: vkSetupWizard,
  setup: vkSetupAdapter,
};
