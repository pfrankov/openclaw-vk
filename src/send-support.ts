import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, ResolvedVkAccount } from "./types.js";

const VK_GROUP_CHAT_OFFSET = 2_000_000_000;

export function isVkGroupPeerId(peerId: string | number): boolean {
  const numericPeerId = typeof peerId === "number" ? peerId : Number(peerId);
  return Number.isFinite(numericPeerId) && numericPeerId >= VK_GROUP_CHAT_OFFSET;
}

/** Allowlist entries as the checks compare them: trimmed, lower-case, no blanks. */
export function normalizeVkAllowlist(allowFrom: Array<string | number> | undefined): string[] {
  if (!allowFrom) {
    return [];
  }
  return allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

/**
 * Whether a sender passes an allowlist: exact id, `vk:`-prefixed id, or `*`.
 * An empty list admits nobody — callers decide what an empty list means.
 */
export function resolveVkAllowlistMatch(params: { allowFrom: string[]; senderId: number }): {
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

export function normalizeVkTargetId(value: string | number): string {
  return String(value).trim().replace(/^vk:(?:user:|chat:)?/i, "");
}

export function normalizeVkSenderAllowEntry(value: string | number): string {
  return String(value).trim().replace(/^vk:(?:user:)?/i, "");
}

export function normalizeVkDirectoryEntries(
  entries: Array<string | number>,
  params: {
    kind: "user" | "group";
    query?: string | null;
    limit?: number | null;
  },
): Array<{ kind: "user" | "group"; id: string }> {
  const normalized = Array.from(
    new Set(
      entries
        .map((entry) =>
          params.kind === "group" ? normalizeVkTargetId(entry) : normalizeVkSenderAllowEntry(entry),
        )
        .filter(Boolean)
        .filter((entry) => entry !== "*")
        .filter((entry) =>
          params.kind === "group" ? isVkGroupPeerId(entry) : !isVkGroupPeerId(entry),
        ),
    ),
  );
  const query = params.query?.trim().toLowerCase() ?? "";
  const filtered = query
    ? normalized.filter((entry) => entry.toLowerCase().includes(query))
    : normalized;
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : undefined;
  return filtered.slice(0, limit ?? filtered.length).map((id) => ({ kind: params.kind, id }));
}

export function readVkAllowlistConfig(account: ResolvedVkAccount) {
  return {
    dmAllowFrom: (account.config.allowFrom ?? []).map(String),
    groupAllowFrom: (account.config.groupAllowFrom ?? []).map(String),
    dmPolicy: account.config.dmPolicy,
    groupPolicy: account.config.groupPolicy,
    groupOverrides: Object.entries(account.config.groups ?? {})
      .filter(([, groupConfig]) => Array.isArray(groupConfig?.allowFrom) && groupConfig.allowFrom.length > 0)
      .map(([label, groupConfig]) => ({
        label,
        entries: (groupConfig?.allowFrom ?? []).map(String),
      })),
  };
}

export function applyVkAllowlistConfigEdit(params: {
  cfg: CoreConfig;
  parsedConfig: Record<string, unknown>;
  accountId?: string | null;
  scope: "dm" | "group";
  action: "add" | "remove";
  entry: string;
}):
  | {
      kind: "ok";
      changed: boolean;
      pathLabel: string;
      writeTarget:
        | { kind: "channel"; scope: { channelId: "vk" } }
        | { kind: "account"; scope: { channelId: "vk"; accountId: string } };
    }
  | { kind: "invalid-entry" } {
  const normalizedEntry = normalizeVkSenderAllowEntry(params.entry);
  if (!normalizedEntry) {
    return { kind: "invalid-entry" };
  }

  const channels = (params.parsedConfig.channels ??= {}) as Record<string, unknown>;
  const vk = ((channels.vk ??= {}) as Record<string, unknown>);
  const normalizedAccountId =
    typeof params.accountId === "string" && params.accountId.trim()
      ? params.accountId.trim()
      : DEFAULT_ACCOUNT_ID;
  const hasAccounts =
    Boolean(vk.accounts && typeof vk.accounts === "object") &&
    Object.keys(vk.accounts as Record<string, unknown>).length > 0;
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;

  let targetRecord: Record<string, unknown>;
  if (useAccount) {
    const accounts = (vk.accounts ??= {}) as Record<string, unknown>;
    const existing = accounts[normalizedAccountId];
    if (!existing || typeof existing !== "object") {
      accounts[normalizedAccountId] = {};
    }
    targetRecord = accounts[normalizedAccountId] as Record<string, unknown>;
  } else {
    targetRecord = vk;
  }

  const writePath = params.scope === "group" ? "groupAllowFrom" : "allowFrom";
  const existing = Array.isArray(targetRecord[writePath])
    ? (targetRecord[writePath] as unknown[])
        .map((entry) => normalizeVkSenderAllowEntry(entry as string))
        .filter(Boolean)
    : [];
  const hasEntry = existing.includes(normalizedEntry);
  let next = existing;
  let changed = false;

  if (params.action === "add") {
    if (!hasEntry) {
      next = [...existing, normalizedEntry];
      changed = true;
    }
  } else if (hasEntry) {
    next = existing.filter((entry) => entry !== normalizedEntry);
    changed = true;
  }

  if (changed) {
    if (next.length > 0) {
      targetRecord[writePath] = next;
    } else {
      delete targetRecord[writePath];
    }
  }

  return {
    kind: "ok",
    changed,
    pathLabel: useAccount
      ? `channels.vk.accounts.${normalizedAccountId}.${writePath}`
      : `channels.vk.${writePath}`,
    writeTarget: useAccount
      ? { kind: "account", scope: { channelId: "vk", accountId: normalizedAccountId } }
      : { kind: "channel", scope: { channelId: "vk" } },
  };
}

export function resolveVkDirectoryPeers(params: {
  account: ResolvedVkAccount;
  query?: string | null;
  limit?: number | null;
}) {
  const entries = [
    ...(params.account.config.allowFrom ?? []),
    ...(params.account.config.defaultTo ? [params.account.config.defaultTo] : []),
  ];
  return normalizeVkDirectoryEntries(entries, {
    kind: "user",
    query: params.query,
    limit: params.limit,
  });
}

export function resolveVkDirectoryGroups(params: {
  account: ResolvedVkAccount;
  query?: string | null;
  limit?: number | null;
}) {
  const entries = [
    ...Object.keys(params.account.config.groups ?? {}).filter((entry) => entry !== "*"),
    ...(params.account.config.defaultTo ? [params.account.config.defaultTo] : []),
  ];
  return normalizeVkDirectoryEntries(entries, {
    kind: "group",
    query: params.query,
    limit: params.limit,
  });
}
