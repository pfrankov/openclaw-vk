import { describe, expect, it, vi } from "vitest";

// ── SDK mock ─────────────────────────────────────────────────────────────────
// Provide real-shaped Zod schemas so VkConfigSchema can be parsed end-to-end.

vi.mock("openclaw/plugin-sdk/channel-config-schema", async () => {
  const { z } = await import("zod");
  return {
    DmPolicySchema: z.enum(["pairing", "allowlist", "open", "disabled"]),
    GroupPolicySchema: z.enum(["allowlist", "open", "disabled"]),
  };
});

import { VkAccountSchema, VkConfigSchema } from "./config-schema.js";

// ── VkAccountSchema ──────────────────────────────────────────────────────────

describe("VkAccountSchema", () => {
  it("accepts the core context visibility modes and rejects anything else", () => {
    for (const mode of ["all", "allowlist", "allowlist_quote"]) {
      expect(VkAccountSchema.safeParse({ contextVisibility: mode }).success).toBe(true);
    }
    expect(VkAccountSchema.safeParse({ contextVisibility: "everyone" }).success).toBe(false);
  });

  it("accepts minimal valid config", () => {
    const result = VkAccountSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full valid config", () => {
    const result = VkAccountSchema.safeParse({
      name: "My Bot",
      enabled: true,
      token: "vk1.a.xxx",
      tokenFile: "/path/to/token",
      dmPolicy: "pairing",
      allowFrom: [123, "456"],
      defaultTo: "some-target",
      groupPolicy: "open",
      groupAllowFrom: ["*"],
      groups: {
        "2000000001": {
          enabled: true,
          allowFrom: [111],
          requireMention: true,
          systemPrompt: "Be helpful.",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = VkAccountSchema.safeParse({ unknownField: true });
    expect(result.success).toBe(false);
  });

  it("accepts all valid dmPolicy values", () => {
    for (const policy of ["pairing", "allowlist", "open", "disabled"]) {
      const result = VkAccountSchema.safeParse({
        dmPolicy: policy,
        ...(policy === "open" ? { allowFrom: ["*"] } : {}),
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid dmPolicy value", () => {
    const result = VkAccountSchema.safeParse({ dmPolicy: "yolo" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid groupPolicy values", () => {
    for (const policy of ["allowlist", "open", "disabled"]) {
      const result = VkAccountSchema.safeParse({ groupPolicy: policy });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid groupPolicy value", () => {
    const result = VkAccountSchema.safeParse({ groupPolicy: "pairing" });
    expect(result.success).toBe(false);
  });

  it("rejects dmPolicy=open without allowFrom containing '*'", () => {
    const result = VkAccountSchema.safeParse({
      dmPolicy: "open",
      allowFrom: [123],
    });
    expect(result.success).toBe(false);
  });

  it("accepts dmPolicy=open when allowFrom includes '*'", () => {
    const result = VkAccountSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts allowFrom with mixed string and number entries", () => {
    const result = VkAccountSchema.safeParse({
      allowFrom: [123, "456", 789],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid group config fields (strict)", () => {
    const result = VkAccountSchema.safeParse({
      groups: { "2000000001": { bogus: true } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts groups with wildcard key", () => {
    const result = VkAccountSchema.safeParse({
      groups: { "*": { requireMention: false } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with tools policy", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": {
          tools: {
            allow: ["web_search"],
            alsoAllow: ["calculator"],
            deny: ["code_exec"],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with partial tools policy (only allow)", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: { allow: ["web_search"] } },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with empty tools object", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: {} },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields in tools policy (strict)", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: { customField: true } },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string arrays in tools policy", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: { allow: [123] } },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── VkConfigSchema ───────────────────────────────────────────────────────────

describe("VkConfigSchema", () => {
  it("accepts config with accounts section", () => {
    const result = VkConfigSchema.safeParse({
      accounts: {
        sales: { token: "tok", dmPolicy: "allowlist", allowFrom: [1] },
        support: { token: "tok2" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("validates nested account schemas inside accounts", () => {
    const result = VkConfigSchema.safeParse({
      accounts: {
        bad: { dmPolicy: "nope" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects dmPolicy=open at root level without allowFrom '*'", () => {
    const result = VkConfigSchema.safeParse({
      dmPolicy: "open",
    });
    expect(result.success).toBe(false);
  });

  it("accepts dmPolicy=open at root level with allowFrom '*'", () => {
    const result = VkConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty config", () => {
    const result = VkConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // The diagnostics level is read from channels.vk.diagnostics only, for every
  // account. Accepting it under an account would be a setting that silently does
  // nothing — worst when an account asks for "off" and still logs at "full".
  it("accepts the diagnostics level at channel level", () => {
    const result = VkConfigSchema.safeParse({ diagnostics: { level: "full" } });
    expect(result.success).toBe(true);
  });

  it("rejects a diagnostics level under an account", () => {
    const result = VkConfigSchema.safeParse({
      diagnostics: { level: "full" },
      accounts: { work: { token: "tok", diagnostics: { level: "off" } } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("accounts.work");
  });
  // Voice limits are read from channels.vk.audio only (settings.ts), for every
  // account; accepting them under an account would be a setting that does nothing.
  it("accepts audio limits at channel level", () => {
    expect(VkConfigSchema.safeParse({ audio: {} }).success).toBe(true);
  });

  it("rejects audio limits under an account", () => {
    const result = VkConfigSchema.safeParse({ accounts: { work: { token: "tok", audio: {} } } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("accounts.work");
  });

  // The step-progress draft is read from channels.vk.streaming only (inbound.ts).
  it("accepts the progress streaming mode at channel level, with core-owned draft keys", () => {
    const result = VkConfigSchema.safeParse({
      streaming: { mode: "progress", progress: { label: "Working", maxLines: 8 } },
    });
    expect(result.success).toBe(true);
    expect(VkConfigSchema.safeParse({ streaming: { mode: "off" } }).success).toBe(true);
  });

  it("rejects streaming modes VK does not implement", () => {
    for (const mode of ["partial", "block", "preview"]) {
      expect(VkConfigSchema.safeParse({ streaming: { mode } }).success).toBe(false);
    }
  });

  it("rejects streaming under an account", () => {
    const result = VkConfigSchema.safeParse({
      accounts: { work: { token: "tok", streaming: { mode: "progress" } } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("accounts.work");
  });
});

// ── Transport ────────────────────────────────────────────────────────────────

describe("VkAccountSchema transport", () => {
  it("accepts a positive silence threshold", () => {
    const result = VkAccountSchema.safeParse({ transport: { silenceMs: 30_000 } });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive or fractional threshold", () => {
    expect(VkAccountSchema.safeParse({ transport: { silenceMs: 0 } }).success).toBe(false);
    expect(VkAccountSchema.safeParse({ transport: { silenceMs: 1.5 } }).success).toBe(false);
  });

  it("rejects unknown transport fields (strict)", () => {
    const result = VkAccountSchema.safeParse({ transport: { silence: 30_000 } });
    expect(result.success).toBe(false);
  });
});
