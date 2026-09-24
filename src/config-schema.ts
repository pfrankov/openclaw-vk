import { DmPolicySchema, GroupPolicySchema } from "openclaw/plugin-sdk/channel-config-schema";
import { VK_CONTEXT_VISIBILITY_MODES, VK_DIAG_LEVELS } from "./types.js";
import { z } from "zod";

function requireOpenAllowFrom(params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}): void {
  if (params.policy === "open" && !params.allowFrom?.map(String).includes("*")) {
    params.ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: params.path,
      message: params.message,
    });
  }
}

const OPEN_DM_POLICY_ALLOW_FROM_ERROR =
  'channels.vk.dmPolicy="open" requires channels.vk.allowFrom to include "*"';

// Long-poll transport (`channels.vk.transport`).
const VkTransportSchema = z
  .object({
    /**
     * Silence after which the account task ends and the gateway restarts the
     * channel. A long poll returns within ~25s, so minutes of silence is an
     * anomaly; the gateway's own threshold is half an hour.
     */
    silenceMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const VkGroupToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const VkGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    tools: VkGroupToolPolicySchema,
  })
  .strict()
  .optional();

// Channel diagnostics (`channels.vk.diagnostics`). A level rather than a
// toggle: "off" is silent, "redacted" logs progress without file names or URLs,
// "full" logs everything. Details and the table live in src/diagnostics.ts.
const VkDiagnosticsSchema = z
  .object({
    // The set of levels is declared once, in types.ts, and parsed in diagnostics.ts.
    level: z.enum(VK_DIAG_LEVELS).optional(),
  })
  .strict()
  .optional();

// Voice and media limits (`channels.vk.audio`). These were environment-only,
// which put a dozen user-facing settings outside schema validation, `doctor` and
// live reload. The environment still overrides, as an escape hatch on a running
// gateway.
const VkAudioSchema = z
  .object({
    /** Hard cap for one voice message; VK rejects longer ones. */
    maxVoiceMs: z.number().int().positive().optional(),
    /** Deadline for the whole split operation. */
    splitDeadlineMs: z.number().int().positive().optional(),
    /** Timeout for a single ffmpeg/ffprobe run. */
    splitTimeoutMs: z.number().int().positive().optional(),
    /** Input files larger than this are not split at all. */
    maxInputBytes: z.number().int().positive().optional(),
    /** Ceiling on segments: nobody listens to more voice messages than this. */
    maxSegments: z.number().int().positive().optional(),
    /** Download ceiling for remote media; the URL comes from a model reply. */
    remoteMaxBytes: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

// Step-progress draft (`channels.vk.streaming`). Only the mode is typed here:
// the draft is rendered by the core compositor, which owns and validates every
// key below it (`progress.label`, `progress.maxLines`, …). VK implements the
// `progress` mode only, so the other core modes are not accepted — they would
// be a setting that does nothing.
const VkStreamingSchema = z
  .object({
    mode: z.enum(["off", "progress"]).optional(),
  })
  .passthrough()
  .optional();

const VkAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional(),
    transport: VkTransportSchema,
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    contextVisibility: z.enum(VK_CONTEXT_VISIBILITY_MODES).optional(),
    groups: z.record(z.string(), VkGroupConfigSchema).optional(),
  })
  .strict();

export const VkAccountSchema = VkAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: OPEN_DM_POLICY_ALLOW_FROM_ERROR,
  });
});

export const VkConfigSchema = VkAccountSchemaBase.extend({
  // Channel-wide only: every account shares one level (see resolveVkDiagLevel).
  diagnostics: VkDiagnosticsSchema,
  // Channel-wide only: settings.ts reads channels.vk.audio for every account.
  audio: VkAudioSchema,
  // Channel-wide only: inbound.ts reads channels.vk.streaming for every account.
  streaming: VkStreamingSchema,
  accounts: z.record(z.string(), VkAccountSchema).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: OPEN_DM_POLICY_ALLOW_FROM_ERROR,
  });
});
