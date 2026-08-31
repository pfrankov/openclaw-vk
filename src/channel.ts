import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  listVkAccountIds,
  resolveDefaultVkAccountId,
  resolveVkAccount,
  type ResolvedVkAccount,
} from "./accounts.js";
import { VkConfigSchema } from "./config-schema.js";
import { monitorVkProvider } from "./monitor.js";
import { probeVkBot } from "./probe.js";
import { getVkRuntime } from "./runtime.js";
import { sanitizeVkPlainText } from "./sanitize.js";
import {
  applyVkAllowlistConfigEdit,
  isVkGroupPeerId,
  readVkAllowlistConfig,
  resolveVkDirectoryGroups,
  resolveVkDirectoryPeers,
  sendFormattedMediaVk,
  sendFormattedTextVk,
  sendMessageVk,
  sendPayloadVk,
} from "./send.js";
import type { CoreConfig, VkConfig, VkProbe } from "./types.js";

const meta = {
  id: "vk",
  label: "VK",
  selectionLabel: "VK (VKontakte Bot)",
  detailLabel: "VK Bot",
  docsPath: "/channels/vk",
  docsLabel: "vk",
  blurb: "VK (VKontakte) community bot via Long Poll API.",
  systemImage: "message.fill",
};

const vkConfigAdapter = createScopedChannelConfigAdapter<ResolvedVkAccount, ResolvedVkAccount, OpenClawConfig>({
  sectionKey: "vk",
  listAccountIds: (cfg) => listVkAccountIds(cfg),
  resolveAccount: adaptScopedAccountAccessor((params) => resolveVkAccount(params)),
  defaultAccountId: (cfg) => resolveDefaultVkAccountId(cfg),
  clearBaseFields: ["tokenFile"],
  resolveAllowFrom: (account: ResolvedVkAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^vk:(?:user:)?/i, "")),
  resolveDefaultTo: (account: ResolvedVkAccount) => account.config.defaultTo,
});

type VkGroupPolicy = "open" | "allowlist" | "disabled";

const VK_CHANNEL_KEY = "vk";
const VK_DM_APPROVE_HINT = "openclaw pairing approve vk <code>";
const VK_OPEN_GROUP_WARNING =
  '- VK group chats: groupPolicy="open" allows any member in group chats to trigger. ' +
  'Set channels.vk.groupPolicy="allowlist" + channels.vk.groupAllowFrom to restrict senders.';

function normalizeVkDmAllowEntry(raw: string): string {
  return raw.replace(/^vk:(?:user:)?/i, "");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readVkConfiguredGroupPolicy(account: ResolvedVkAccount): VkGroupPolicy | undefined {
  const groupPolicy = account.config.groupPolicy;
  return groupPolicy === "open" || groupPolicy === "allowlist" || groupPolicy === "disabled"
    ? groupPolicy
    : undefined;
}

function readVkDefaultGroupPolicy(cfg: OpenClawConfig): VkGroupPolicy | undefined {
  const channels = isObjectRecord(cfg.channels) ? cfg.channels : undefined;
  const defaults = isObjectRecord(channels?.defaults) ? channels.defaults : undefined;
  const groupPolicy = defaults?.groupPolicy;
  return groupPolicy === "open" || groupPolicy === "allowlist" || groupPolicy === "disabled"
    ? groupPolicy
    : undefined;
}

function hasVkProviderConfig(cfg: OpenClawConfig): boolean {
  const channels = isObjectRecord(cfg.channels) ? cfg.channels : undefined;
  return channels?.[VK_CHANNEL_KEY] !== undefined;
}

function resolveVkSecurityAccountBasePath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedVkAccount;
}): string {
  const channels = isObjectRecord(params.cfg.channels) ? params.cfg.channels : undefined;
  const channelConfig = isObjectRecord(channels?.[VK_CHANNEL_KEY]) ? channels[VK_CHANNEL_KEY] : undefined;
  const accounts = isObjectRecord(channelConfig?.accounts) ? channelConfig.accounts : undefined;
  const resolvedAccountId =
    params.accountId?.trim() || params.account.accountId?.trim() || DEFAULT_ACCOUNT_ID;

  return accounts?.[resolvedAccountId] !== undefined
    ? `channels.${VK_CHANNEL_KEY}.accounts.${resolvedAccountId}.`
    : `channels.${VK_CHANNEL_KEY}.`;
}

function resolveVkRuntimeGroupPolicy(params: {
  cfg: OpenClawConfig;
  account: ResolvedVkAccount;
}): VkGroupPolicy {
  const configuredGroupPolicy = readVkConfiguredGroupPolicy(params.account);
  if (configuredGroupPolicy) {
    return configuredGroupPolicy;
  }
  if (!hasVkProviderConfig(params.cfg)) {
    return "allowlist";
  }
  return readVkDefaultGroupPolicy(params.cfg) ?? "allowlist";
}

const vkSecurityAdapter = {
  resolveDmPolicy: ({
    cfg,
    accountId,
    account,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedVkAccount;
  }) => ({
    policy: account.config.dmPolicy ?? "pairing",
    allowFrom: account.config.allowFrom ?? [],
    allowFromPath: resolveVkSecurityAccountBasePath({ cfg, accountId, account }),
    approveHint: VK_DM_APPROVE_HINT,
    normalizeEntry: normalizeVkDmAllowEntry,
  }),
  collectWarnings: ({
    cfg,
    account,
  }: {
    cfg: OpenClawConfig;
    account: ResolvedVkAccount;
  }) => (resolveVkRuntimeGroupPolicy({ cfg, account }) === "open" ? [VK_OPEN_GROUP_WARNING] : []),
};

export const vkPlugin: ChannelPlugin<ResolvedVkAccount, VkProbe> = {
  id: "vk",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "vkUserId",
    normalizeAllowEntry: (entry) => {
      return entry.replace(/^vk:(?:user:)?/i, "");
    },
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageVk(id, "OpenClaw: your access has been approved.", {
        cfg,
      });
    },
  },
  allowlist: {
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
    readConfig: ({ cfg, accountId }) =>
      readVkAllowlistConfig(resolveVkAccount({ cfg: cfg as CoreConfig, accountId })),
    applyConfigEdit: ({ cfg, parsedConfig, accountId, scope, action, entry }) =>
      applyVkAllowlistConfigEdit({
        cfg: cfg as CoreConfig,
        parsedConfig,
        accountId,
        scope,
        action,
        entry,
      }),
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
    ...vkConfigAdapter,
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource ?? undefined,
    }),
  },
  security: vkSecurityAdapter,
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveVkAccount({
        cfg,
        accountId: accountId ?? undefined,
      });
      const groups = account.config.groups;
      if (!groups || !groupId) {
        return false;
      }
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? false;
    },
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      const account = resolveVkAccount({
        cfg,
        accountId: accountId ?? undefined,
      });
      const groups = account.config.groups;
      if (!groups || !groupId) {
        return undefined;
      }
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.tools ?? undefined;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed.replace(/^vk:(?:user:|chat:)?/i, "");
    },
    parseExplicitTarget: ({ raw }) => {
      const normalized = raw.trim().replace(/^vk:(?:user:|chat:)?/i, "");
      if (!normalized) {
        return null;
      }
      const peerId = Number(normalized);
      if (Number.isNaN(peerId)) {
        return null;
      }
      return {
        to: normalized,
        chatType: isVkGroupPeerId(peerId) ? ("group" as const) : ("direct" as const),
      };
    },
    inferTargetChatType: ({ to }) => {
      const normalized = to.trim().replace(/^vk:(?:user:|chat:)?/i, "");
      const peerId = Number(normalized);
      if (Number.isNaN(peerId)) {
        return undefined;
      }
      return isVkGroupPeerId(peerId) ? ("group" as const) : ("direct" as const);
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        return /^\d+$/.test(trimmed) || /^vk:/i.test(trimmed);
      },
      hint: "<userId|peerId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) =>
      resolveVkDirectoryPeers({
        account: resolveVkAccount({
          cfg: ((params?.cfg as CoreConfig | undefined) ?? {}) as CoreConfig,
          accountId: params?.accountId,
        }),
        query: params?.query,
        limit: params?.limit,
      }),
    listGroups: async (params) =>
      resolveVkDirectoryGroups({
        account: resolveVkAccount({
          cfg: ((params?.cfg as CoreConfig | undefined) ?? {}) as CoreConfig,
          accountId: params?.accountId,
        }),
        query: params?.query,
        limit: params?.limit,
      }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4096,
    sanitizeText: ({ text }) => sanitizeVkPlainText(text),
    shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
    sendPayload: async ({ to, payload, accountId, cfg, mediaLocalRoots, replyToId, forceDocument }) => {
      const result = await sendPayloadVk(to, payload, {
        cfg,
        accountId: accountId ?? undefined,
        mediaLocalRoots,
        replyTo: replyToId ?? undefined,
        forceDocument: forceDocument ?? undefined,
      });
      return result
        ? { channel: "vk", ...result }
        : { channel: "vk", messageId: "", chatId: to };
    },
    sendFormattedText: async ({ cfg, to, text, accountId, replyToId }) => {
      const results = await sendFormattedTextVk(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return results.map((result) => ({ channel: "vk" as const, ...result }));
    },
    sendFormattedMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, forceDocument }) => {
      const result = await sendFormattedMediaVk(to, text, mediaUrl, {
        cfg,
        accountId: accountId ?? undefined,
        mediaLocalRoots,
        replyTo: replyToId ?? undefined,
        forceDocument: forceDocument ?? undefined,
      });
      return { channel: "vk", ...result };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const result = await sendMessageVk(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "vk", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, forceDocument }) => {
      const result = await sendFormattedMediaVk(to, text, mediaUrl, {
        cfg,
        accountId: accountId ?? undefined,
        mediaLocalRoots,
        replyTo: replyToId ?? undefined,
        forceDocument: forceDocument ?? undefined,
      });
      return { channel: "vk", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        const accountId = account.accountId ?? DEFAULT_ACCOUNT_ID;
        if (!account.configured) {
          issues.push({
            channel: "vk",
            accountId,
            kind: "config",
            message: "VK community access token not configured",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    formatCapabilitiesProbe: ({ probe }) => {
      const lines: Array<{ text: string }> = [];
      if (probe?.ok) {
        if (probe.groupName) {
          const groupId = probe.groupId ? ` (${probe.groupId})` : "";
          lines.push({ text: `Group: ${probe.groupName}${groupId}` });
        }
        if (probe.screenName) {
          lines.push({ text: `Screen name: ${probe.screenName}` });
        }
      }
      return lines;
    },
    probeAccount: async ({ account, timeoutMs }) => probeVkBot(account.token, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.token?.trim());
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        runtime,
        probe,
      });
      return {
        ...base,
        tokenSource: account.tokenSource,
        mode: "longpoll",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      if (!token) {
        throw new Error(
          `VK long poll mode requires a non-empty community access token for account "${account.accountId}".`,
        );
      }

      let vkBotLabel = "";
      try {
        const probe = await probeVkBot(token, 2500);
        const displayName = probe.ok ? probe.groupName?.trim() : null;
        if (displayName) {
          vkBotLabel = ` (${displayName})`;
        }
      } catch (err) {
        if (getVkRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] VK bot probe failed: ${String(err)}`);
        }
      }

      ctx.log?.info(`[${account.accountId}] starting VK provider${vkBotLabel}`);

      const monitor = await monitorVkProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });

      return monitor;
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const vkConfig = ((cfg.channels as Record<string, unknown>)?.vk ?? {}) as VkConfig;
      const nextVk = { ...vkConfig };
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (nextVk.token || nextVk.tokenFile) {
          delete nextVk.token;
          delete nextVk.tokenFile;
          cleared = true;
          changed = true;
        }
      }

      if (accountId !== DEFAULT_ACCOUNT_ID && nextVk.accounts?.[accountId]) {
        const nextAccounts = { ...nextVk.accounts };
        delete nextAccounts[accountId];
        if (Object.keys(nextAccounts).length > 0) {
          nextVk.accounts = nextAccounts;
        } else {
          delete nextVk.accounts;
        }
        cleared = true;
        changed = true;
      }

      if (changed) {
        if (Object.keys(nextVk).length > 0) {
          (nextCfg.channels as Record<string, unknown>) = {
            ...nextCfg.channels,
            vk: nextVk,
          };
        } else {
          const nextChannels = {
            ...nextCfg.channels,
          } as Record<string, unknown>;
          delete nextChannels.vk;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await getVkRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveVkAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";

      return {
        cleared,
        envToken: Boolean(process.env.VK_TOKEN?.trim()),
        loggedOut,
      };
    },
  },
};
