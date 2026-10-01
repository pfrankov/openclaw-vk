import { describe, expect, it } from "vitest";

/**
 * The group gate shared by inbound messages and question buttons, run against
 * the host's real resolvers (`resolveDefaultGroupPolicy`,
 * `resolveAllowlistProviderRuntimeGroupPolicy`, `resolveEffectiveAllowFromLists`).
 * `question-events.test.ts` copies their logic into mocks; this catches the day
 * the host changes it. Like the other `*.sdk.test.ts`, it skips itself where
 * the optional `openclaw` peer is not installed.
 */
const groupAccess = await import("./group-access.js").catch(() => null);
const accounts = await import("./accounts.js").catch(() => null);

const CHAT = 2_000_000_005;

describe.skipIf(!groupAccess || !accounts)("group access on the host's resolvers", () => {
  const admits = (config: Record<string, unknown>, senderId: number) => {
    const account = accounts!.resolveVkAccount({ cfg: config as never, accountId: "default" });
    const access = groupAccess!.resolveVkGroupAccess({ config: config as never, account, peerId: CHAT });
    return groupAccess!.resolveVkGroupSenderAdmission(access, senderId).allowed;
  };
  const withDefault = (groupPolicy: string, vk: Record<string, unknown> = {}) => ({
    channels: { defaults: { groupPolicy }, vk: { token: "t", ...vk } },
  });

  it("an inherited open admits anyone", () => {
    expect(admits(withDefault("open"), 7)).toBe(true);
  });

  it("an inherited allowlist admits only the listed", () => {
    expect(admits(withDefault("allowlist", { groupAllowFrom: ["42"] }), 42)).toBe(true);
    expect(admits(withDefault("allowlist", { groupAllowFrom: ["42"] }), 7)).toBe(false);
  });

  it("an inherited disabled admits nobody, listed or not", () => {
    expect(admits(withDefault("disabled", { groupAllowFrom: ["42"] }), 42)).toBe(false);
  });

  it("nothing set: the provider fallback is allowlist", () => {
    expect(admits({ channels: { vk: { token: "t" } } }, 7)).toBe(false);
    expect(admits({ channels: { vk: { token: "t", groupAllowFrom: ["7"] } } }, 7)).toBe(true);
  });

  it("an explicit open ignores the channel and per-chat allowlists", () => {
    expect(admits({ channels: { vk: { token: "t", groupPolicy: "open", groupAllowFrom: ["42"] } } }, 7)).toBe(true);
    expect(
      admits(
        { channels: { vk: { token: "t", groupPolicy: "open", groups: { [String(CHAT)]: { allowFrom: ["42"] } } } } },
        7,
      ),
    ).toBe(true);
  });

  it("the channel's own policy wins over the inherited default", () => {
    expect(admits(withDefault("disabled", { groupPolicy: "open" }), 7)).toBe(true);
    expect(admits(withDefault("open", { groupPolicy: "disabled" }), 7)).toBe(false);
  });
});
