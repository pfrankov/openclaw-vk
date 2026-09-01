import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VK, getRandomId } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import {
  cleanupAudioSegments,
  getVkAudioMessageMaxMs,
  probeAudioDurationMs,
  splitAudioAtSilence,
} from "./audio-chunk.js";
import {
  renderVkMarkdownChunks,
  type VkPreparedFormattedMessage,
} from "./format.js";
import { buildVkKeyboard, buildVkKeyboardRemoval, resolveVkButtonsFromPayload } from "./keyboard.js";
import { loadVkOutboundMedia } from "./media.js";
import { getVkRuntime } from "./runtime.js";
import { normalizeVkTargetId } from "./send-support.js";
import type { CoreConfig, ResolvedVkAccount, VkReplyButtons } from "./types.js";
export {
  applyVkAllowlistConfigEdit,
  isVkGroupPeerId,
  normalizeVkDirectoryEntries,
  normalizeVkSenderAllowEntry,
  normalizeVkTargetId,
  readVkAllowlistConfig,
  resolveVkDirectoryGroups,
  resolveVkDirectoryPeers,
} from "./send-support.js";

const VK_MESSAGE_TEXT_LIMIT = 4096;
const VK_TRANSIENT_RETRY_ATTEMPTS = 3;
const VK_REMOTE_MEDIA_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_ACCOUNT_ID = "default";
const VK_MEDIA_SCOPE_FALLBACK_NOTICE =
  "Attachment could not be delivered; sent as text instead.";

// Opt-in diagnostics: when VK_VOICE_DEBUG_LOG points at a writable file path,
// append voice/media send breadcrumbs there. No-op otherwise. Used to capture
// the real cause of intermittent audio_message upload failures (e.g. a missing
// peer_id surfaces from VK as a misleading "access denied / scopes" error 15).
async function logVkVoiceDebug(line: string): Promise<void> {
  const target = process.env.VK_VOICE_DEBUG_LOG;
  if (!target) {
    return;
  }
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(target, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* diagnostics only — never break a send */
  }
}
const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

export type SendVkOptions = {
  cfg?: CoreConfig;
  accountId?: string;
  replyTo?: string;
  buttons?: VkReplyButtons;
  clearKeyboard?: boolean;
  mediaLocalRoots?: readonly string[];
  forceDocument?: boolean;
};

export type SendVkResult = {
  messageId: string;
  chatId: string;
};

export type VkOutboundPayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  channelData?: Record<string, unknown>;
};

type VkOutboundMediaReference = {
  url: string;
  title?: string;
  mimeType?: string;
};

type VkClientState = {
  vk: VK;
  groupId?: number;
  groupIdPromise?: Promise<number | undefined>;
};

const vkInstances = new Map<string, VkClientState>();

function getOrCreateVkState(token: string): VkClientState {
  let state = vkInstances.get(token);
  if (!state) {
    state = {
      vk: new VK({ token, apiLimit: 20 }),
    };
    vkInstances.set(token, state);
  }
  return state;
}

function getOrCreateVk(token: string): VK {
  return getOrCreateVkState(token).vk;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readVkErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.code === "number") {
    return record.code;
  }
  if (typeof record.error_code === "number") {
    return record.error_code;
  }
  return undefined;
}

function readVkErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as Record<string, unknown>;
  return [
    typeof record.message === "string" ? record.message : "",
    typeof record.name === "string" ? record.name : "",
    typeof record.description === "string" ? record.description : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function isVkScopeDeniedError(error: unknown): boolean {
  if (readVkErrorCode(error) === 15) {
    return true;
  }
  const message = readVkErrorMessage(error).toLowerCase();
  return message.includes("access denied") && message.includes("scope");
}

function isVkPhotoSourceRejectedError(error: unknown): boolean {
  if (readVkErrorCode(error) !== 100) {
    return false;
  }
  const message = readVkErrorMessage(error).toLowerCase();
  return message.includes("photo is undefined") || message.includes("photo undefined");
}

function isVkImageUploadFallbackError(error: unknown): boolean {
  return isVkScopeDeniedError(error) || isVkPhotoSourceRejectedError(error);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function materializeRemoteVkPhotoSource(sourceUrl: string): Promise<Buffer | null> {
  if (typeof fetch !== "function" || !isHttpUrl(sourceUrl)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VK_REMOTE_MEDIA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    return body.length > 0 ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableVkError(error: unknown): boolean {
  const errorCode = readVkErrorCode(error);
  if (errorCode === 6 || errorCode === 9 || errorCode === 10) {
    return true;
  }
  const message = readVkErrorMessage(error).toLowerCase();
  return /time-?out|timed out|temporar|econnreset|socket hang up|too many requests|rate limit|not allowed|abort|429|5\d\d/.test(
    message,
  );
}

async function withVkRetry<T>(
  operation: () => Promise<T>,
  opts?: { extraRetryableCodes?: readonly number[]; maxAttempts?: number },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? VK_TRANSIENT_RETRY_ATTEMPTS;
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const code = readVkErrorCode(error);
      const retryable =
        isRetryableVkError(error) ||
        (code !== undefined && (opts?.extraRetryableCodes?.includes(code) ?? false));
      if (attempt >= maxAttempts || !retryable) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
}

function getLastSendResult(results: readonly SendVkResult[]): SendVkResult | null {
  return results.length > 0 ? (results[results.length - 1] ?? null) : null;
}

function buildVkUploadSource(params: {
  source: string | Buffer;
  filename?: string;
  contentType?: string;
}): { value: string | Buffer; filename?: string; contentType?: string } {
  return {
    value: params.source,
    ...(params.filename ? { filename: params.filename } : {}),
    ...(params.contentType ? { contentType: params.contentType } : {}),
  };
}

function prepareVkMessageChunks(text: string): VkPreparedFormattedMessage[] {
  return renderVkMarkdownChunks(text, { chunkSize: VK_MESSAGE_TEXT_LIMIT }).filter((chunk) => chunk.text.length > 0);
}

function toPreparedVkMessages(
  message: string | VkPreparedFormattedMessage | undefined,
): VkPreparedFormattedMessage[] {
  if (!message) {
    return [{ text: "" }];
  }
  if (typeof message !== "string") {
    return [message];
  }

  const chunks = prepareVkMessageChunks(message);
  return chunks.length > 0 ? chunks : [{ text: "" }];
}

function resolveVkKeyboard(opts: SendVkOptions): string | undefined {
  return opts.clearKeyboard === true ? buildVkKeyboardRemoval() : buildVkKeyboard(opts.buttons);
}

function dedupeVkMediaReferences(
  refs: VkOutboundMediaReference[],
): VkOutboundMediaReference[] {
  const byUrl = new Map<string, VkOutboundMediaReference>();
  for (const ref of refs) {
    const normalizedUrl = ref.url.trim();
    if (!normalizedUrl) {
      continue;
    }
    const existing = byUrl.get(normalizedUrl);
    if (!existing) {
      byUrl.set(normalizedUrl, { ...ref, url: normalizedUrl });
      continue;
    }
    byUrl.set(normalizedUrl, {
      url: normalizedUrl,
      title: existing.title ?? ref.title,
      mimeType: existing.mimeType ?? ref.mimeType,
    });
  }
  return Array.from(byUrl.values());
}

function resolvePayloadMediaReferences(payload: VkOutboundPayloadLike): VkOutboundMediaReference[] {
  const rawUrls = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  return dedupeVkMediaReferences(
    rawUrls
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((url) => ({ url })),
  );
}

function isLikelyVkMediaReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (isHttpUrl(trimmed) || /^data:/i.test(trimmed) || trimmed.startsWith("file://")) {
    return true;
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return true;
  }
  return /\.(?:apng|avif|bmp|gif|heic|heif|jpeg|jpg|png|webp|aac|flac|m4a|mp3|oga|ogg|opus|wav|pdf|mp4|webm)(?:$|[?#])/i.test(
    trimmed,
  );
}

function isLikelyVkAttachmentLinkTarget(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith("file://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    /^data:/i.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return true;
  }

  return /\.(?:txt|md|json|csv|tsv|log|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz|tgz|png|jpg|jpeg|webp|gif|mp3|wav|ogg|opus|mp4|webm)(?:$|[?#])/i.test(
    trimmed,
  );
}

function isLikelyVkAttachmentTitle(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /\.(?:txt|md|json|csv|tsv|log|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz|tgz|png|jpg|jpeg|webp|gif|mp3|wav|ogg|opus|mp4|webm)$/i.test(
    trimmed,
  );
}

function resolveVkMarkdownAttachmentPayload(text: string): {
  text: string;
  mediaRefs: VkOutboundMediaReference[];
} {
  const mediaRefs: VkOutboundMediaReference[] = [];
  const stripped = text.replace(MARKDOWN_LINK_RE, (fullMatch, bang: string, label: string, rawUrl: string) => {
    const candidate = rawUrl.trim();
    const shouldExtract =
      bang === "!"
        ? isLikelyVkMediaReference(candidate)
        : isLikelyVkAttachmentLinkTarget(candidate);

    if (!shouldExtract) {
      return fullMatch;
    }
    const trimmedLabel = label.trim();
    mediaRefs.push({
      url: candidate,
      ...(bang !== "!" && isLikelyVkAttachmentTitle(trimmedLabel)
        ? { title: trimmedLabel }
        : {}),
    });
    return "";
  });

  const normalizedText = stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: normalizedText,
    mediaRefs: dedupeVkMediaReferences(mediaRefs),
  };
}

function resolveVkPayloadParts(
  payload: VkOutboundPayloadLike,
  opts: SendVkOptions,
): {
  text: string;
  mediaRefs: VkOutboundMediaReference[];
  buttons: VkReplyButtons | undefined;
  replyTo: string | undefined;
  clearKeyboard: boolean;
} {
  const parsedText = resolveVkMarkdownAttachmentPayload(payload.text ?? "");
  const text = parsedText.text;
  const mediaRefs = dedupeVkMediaReferences([
    ...resolvePayloadMediaReferences(payload),
    ...parsedText.mediaRefs,
  ]);
  const buttons = opts.buttons ?? resolveVkButtonsFromPayload(payload);
  const replyTo = payload.replyToId ?? opts.replyTo;
  const clearKeyboard = opts.clearKeyboard === true && !buttons;

  return {
    text,
    mediaRefs,
    buttons,
    replyTo,
    clearKeyboard,
  };
}

function recordOutboundActivity(accountId: string): void {
  getVkRuntime().channel.activity.record({
    channel: "vk",
    accountId,
    direction: "outbound",
    at: Date.now(),
  });
}

function resolveSendTarget(params: { cfg?: CoreConfig; accountId?: string; to: string }) {
  const runtime = getVkRuntime();
  const cfg = (params.cfg ?? runtime.config.loadConfig()) as CoreConfig;
  const account = resolveVkAccount({ cfg, accountId: params.accountId });
  if (!account.token) {
    throw new Error("VK token not configured");
  }

  const normalizedTo = normalizeVkTargetId(params.to);
  const peerId = Number(normalizedTo);
  if (Number.isNaN(peerId)) {
    throw new Error(`Invalid VK peer ID: ${params.to}`);
  }

  return {
    account,
    peerId,
    to: normalizedTo,
  };
}

async function sendVkApiMessage(params: {
  to: string;
  peerId: number;
  account: ResolvedVkAccount;
  formatted: VkPreparedFormattedMessage;
  attachment?: string;
  opts?: SendVkOptions;
}): Promise<SendVkResult> {
  const vk = getOrCreateVk(params.account.token);
  const keyboard = resolveVkKeyboard(params.opts ?? {});
  const formatData =
    params.formatted.formatData && params.formatted.formatData.items.length > 0
      ? JSON.stringify(params.formatted.formatData)
      : undefined;
  const randomId = getRandomId();
  const messageId = await withVkRetry(async () => {
    return await vk.api.messages.send({
      peer_id: params.peerId,
      message: params.formatted.text,
      random_id: randomId,
      ...(params.attachment ? { attachment: params.attachment } : {}),
      ...(keyboard ? { keyboard } : {}),
      ...(params.opts?.replyTo ? { reply_to: Number(params.opts.replyTo) } : {}),
      ...(formatData ? { format_data: formatData } : {}),
    });
  });

  recordOutboundActivity(params.account.accountId);
  return { messageId: String(messageId), chatId: params.to };
}

async function resolveVkGroupId(state: VkClientState): Promise<number | undefined> {
  if (typeof state.groupId === "number") {
    return state.groupId;
  }
  if (!state.groupIdPromise) {
    state.groupIdPromise = state.vk.api.groups
      .getById({})
      .then(({ groups }) => {
        const groupId = groups[0]?.id;
        state.groupId = typeof groupId === "number" ? groupId : undefined;
        return state.groupId;
      })
      .catch(() => undefined);
  }
  return await state.groupIdPromise;
}

export function primeVkGroupId(token: string, groupId: number): void {
  const trimmedToken = token.trim();
  if (!trimmedToken || !Number.isInteger(groupId) || groupId <= 0) {
    return;
  }
  const state = getOrCreateVkState(trimmedToken);
  state.groupId = groupId;
  state.groupIdPromise = Promise.resolve(groupId);
}

export async function sendMessageVk(
  to: string,
  text: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  await logVkVoiceDebug(`ENTRY sendMessageVk to=${JSON.stringify(to)} textLen=${(text ?? "").length}`);
  const parsed = resolveVkMarkdownAttachmentPayload(text);
  const results = await sendPayloadResultsVk({
    to,
    text: parsed.text,
    mediaRefs: parsed.mediaRefs,
    opts,
  });

  return getLastSendResult(results) ?? { messageId: "", chatId: normalizeVkTargetId(to) };
}

export async function sendPhotoVk(
  to: string,
  photoSource: string | Buffer,
  text?: string | VkPreparedFormattedMessage,
  opts: SendVkOptions = {},
  uploadMeta?: { filename?: string; contentType?: string },
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const attachment = await withVkRetry(async () => {
    return await vk.upload.messagePhoto({
      peer_id: peerId,
      source: buildVkUploadSource({
        source: photoSource,
        filename: uploadMeta?.filename,
        contentType: uploadMeta?.contentType,
      }),
    });
  });
  const [firstChunk, ...tailChunks] = toPreparedVkMessages(text);
  const firstResult = await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    formatted: firstChunk ?? { text: "" },
    attachment: String(attachment),
    opts: {
      ...opts,
      buttons: tailChunks.length === 0 ? opts.buttons : undefined,
      clearKeyboard: tailChunks.length === 0 ? opts.clearKeyboard : undefined,
    },
  });

  if (tailChunks.length === 0) {
    return firstResult;
  }

  const tailResults = await sendMessageChunksVk({
    to: normalizedTo,
    chunks: tailChunks,
    opts: {
      ...opts,
      replyTo: undefined,
    },
  });

  return getLastSendResult(tailResults) ?? firstResult;
}

export async function sendDocumentVk(
  to: string,
  docSource: string | Buffer,
  title: string,
  text?: string | VkPreparedFormattedMessage,
  opts: SendVkOptions = {},
  uploadMeta?: { contentType?: string },
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const attachment = await withVkRetry(async () => {
    return await vk.upload.messageDocument({
      peer_id: peerId,
      source: buildVkUploadSource({
        source: docSource,
        filename: title,
        contentType: uploadMeta?.contentType,
      }),
      title,
    });
  });
  const [firstChunk, ...tailChunks] = toPreparedVkMessages(text);
  const firstResult = await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    formatted: firstChunk ?? { text: "" },
    attachment: String(attachment),
    opts: {
      ...opts,
      buttons: tailChunks.length === 0 ? opts.buttons : undefined,
      clearKeyboard: tailChunks.length === 0 ? opts.clearKeyboard : undefined,
    },
  });

  if (tailChunks.length === 0) {
    return firstResult;
  }

  const tailResults = await sendMessageChunksVk({
    to: normalizedTo,
    chunks: tailChunks,
    opts: {
      ...opts,
      replyTo: undefined,
    },
  });

  return getLastSendResult(tailResults) ?? firstResult;
}

/**
 * Returns a local filesystem path usable by ffmpeg for `audioSource`, plus a
 * cleanup callback. Buffers are written to a temp file. Non-local strings
 * (http/data/file:// etc.) yield `null` so the caller skips splitting.
 */
async function materializeLocalAudioFile(
  audioSource: string | Buffer,
  title: string,
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  if (Buffer.isBuffer(audioSource)) {
    try {
      const dir = await mkdtemp(join(tmpdir(), "vk-voice-src-"));
      const safeName = title.replace(/[\\/]/g, "_") || "voice.ogg";
      const path = join(dir, safeName);
      await writeFile(path, audioSource);
      return {
        path,
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch {
      return null;
    }
  }

  // Only plain local paths can be probed/split. http/data/file:// are skipped.
  if (
    isHttpUrl(audioSource) ||
    /^data:/i.test(audioSource) ||
    audioSource.startsWith("file://")
  ) {
    return null;
  }
  return { path: audioSource, cleanup: async () => {} };
}

async function uploadVkAudioMessage(params: {
  vk: VK;
  peerId: number;
  source: string | Buffer;
  filename: string;
  contentType?: string;
}): Promise<string> {
  // Guard against an invalid peer_id (would surface from VK as a misleading
  // error 15 "access denied … with current scopes", even though the token's
  // scopes are fine). Fail loud and accurate instead.
  if (!Number.isFinite(params.peerId) || params.peerId <= 0) {
    await logVkVoiceDebug(
      `uploadVkAudioMessage ABORT invalid peerId=${JSON.stringify(params.peerId)} filename=${params.filename}`,
    );
    throw new Error(
      `VK audio upload aborted: invalid peer_id (${JSON.stringify(params.peerId)}); peer_id is required for audio_message uploads`,
    );
  }
  await logVkVoiceDebug(
    `uploadVkAudioMessage peerId=${params.peerId} filename=${params.filename}`,
  );
  // Even with a valid peer_id, docs.getMessagesUploadServer(type=audio_message)
  // intermittently returns error 15 when the call gets batched with concurrent
  // requests on the shared (apiLimit) VK client. Verified ~20% failure under
  // concurrency vs 0% sequentially. The call is otherwise idempotent, so treat
  // 15 as transient here and retry — a re-issued (unbatched) call succeeds.
  const attachment = await withVkRetry(
    async () => {
      return await params.vk.upload.audioMessage({
        peer_id: params.peerId,
        source: buildVkUploadSource({
          source: params.source,
          filename: params.filename,
          contentType: params.contentType,
        }),
        title: params.filename,
      });
    },
    { extraRetryableCodes: [15], maxAttempts: 5 },
  );
  return String(attachment);
}

export async function sendAudioMessageVk(
  to: string,
  audioSource: string | Buffer,
  title: string,
  text?: string | VkPreparedFormattedMessage,
  opts: SendVkOptions = {},
  uploadMeta?: { contentType?: string },
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const [firstChunk, ...tailChunks] = toPreparedVkMessages(text);

  // ── Attempt silence-based split for over-limit local audio ────────────────
  const local = await materializeLocalAudioFile(audioSource, title);
  if (local) {
    const maxMs = getVkAudioMessageMaxMs();
    let segments: string[] = [];
    try {
      const durationMs = await probeAudioDurationMs(local.path);
      if (durationMs !== null && durationMs > maxMs) {
        segments = await splitAudioAtSilence(local.path, maxMs);
      }
    } catch {
      segments = [];
    }

    if (segments.length >= 2) {
      try {
        return await sendVkAudioSegments({
          to: normalizedTo,
          peerId,
          account,
          vk,
          segments,
          contentType: uploadMeta?.contentType,
          firstChunk,
          tailChunks,
          opts,
        });
      } finally {
        await cleanupAudioSegments(segments);
        await local.cleanup();
      }
    }
    await local.cleanup();
  }

  // ── Single-message path (short audio / split unavailable) ─────────────────
  const attachment = await uploadVkAudioMessage({
    vk,
    peerId,
    source: audioSource,
    filename: title,
    contentType: uploadMeta?.contentType,
  });
  const firstResult = await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    formatted: firstChunk ?? { text: "" },
    attachment,
    opts: {
      ...opts,
      buttons: tailChunks.length === 0 ? opts.buttons : undefined,
      clearKeyboard: tailChunks.length === 0 ? opts.clearKeyboard : undefined,
    },
  });

  if (tailChunks.length === 0) {
    return firstResult;
  }

  const tailResults = await sendMessageChunksVk({
    to: normalizedTo,
    chunks: tailChunks,
    opts: {
      ...opts,
      replyTo: undefined,
    },
  });

  return getLastSendResult(tailResults) ?? firstResult;
}

/**
 * Sends N audio segments as separate VK voice messages in order, then the
 * remaining text chunks. The first text chunk + replyTo ride the first voice;
 * buttons/clearKeyboard apply only to the very last sent message.
 */
async function sendVkAudioSegments(params: {
  to: string;
  peerId: number;
  account: ResolvedVkAccount;
  vk: VK;
  segments: readonly string[];
  contentType?: string;
  firstChunk?: VkPreparedFormattedMessage;
  tailChunks: VkPreparedFormattedMessage[];
  opts: SendVkOptions;
}): Promise<SendVkResult> {
  const { segments, tailChunks, opts } = params;
  const hasTail = tailChunks.length > 0;
  const results: SendVkResult[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const isFirst = index === 0;
    const isLastSegment = index === segments.length - 1;
    const applyKeyboard = isLastSegment && !hasTail;

    const attachment = await uploadVkAudioMessage({
      vk: params.vk,
      peerId: params.peerId,
      source: segment,
      filename: `voice-${String(index + 1).padStart(2, "0")}.ogg`,
      contentType: params.contentType,
    });

    const result = await sendVkApiMessage({
      to: params.to,
      peerId: params.peerId,
      account: params.account,
      formatted: isFirst ? params.firstChunk ?? { text: "" } : { text: "" },
      attachment,
      opts: {
        ...opts,
        replyTo: isFirst ? opts.replyTo : undefined,
        buttons: applyKeyboard ? opts.buttons : undefined,
        clearKeyboard: applyKeyboard ? opts.clearKeyboard : undefined,
      },
    });
    results.push(result);
  }

  if (hasTail) {
    const tailResults = await sendMessageChunksVk({
      to: params.to,
      chunks: tailChunks,
      opts: {
        ...opts,
        replyTo: undefined,
      },
    });
    results.push(...tailResults);
  }

  return getLastSendResult(results) ?? { messageId: "", chatId: params.to };
}

export async function sendFormattedTextVk(
  to: string,
  text: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult[]> {
  const parsed = resolveVkMarkdownAttachmentPayload(text);
  return await sendPayloadResultsVk({
    to,
    text: parsed.text,
    mediaRefs: parsed.mediaRefs,
    opts,
  });
}

export async function sendFormattedMediaVk(
  to: string,
  text: string,
  mediaUrl: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  await logVkVoiceDebug(`ENTRY sendFormattedMediaVk to=${JSON.stringify(to)} mediaUrl=${JSON.stringify(mediaUrl)} textLen=${(text ?? "").length}`);
  const result = await sendPayloadVk(
    to,
    {
      text,
      mediaUrl,
    },
    opts,
  );
  if (!result) {
    throw new Error("VK formatted media delivery produced no result");
  }
  return result;
}

export async function sendTypingVk(to: string, account: ResolvedVkAccount): Promise<void> {
  if (!account.token) {
    return;
  }

  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId)) {
    return;
  }

  const state = getOrCreateVkState(account.token);
  const groupId = await resolveVkGroupId(state);

  await withVkRetry(async () => {
    await state.vk.api.messages.setActivity({
      peer_id: peerId,
      type: "typing",
      ...(typeof groupId === "number" ? { group_id: groupId } : {}),
    });
  });
}

export async function markMessageReadVk(
  to: string,
  messageId: string,
  account: ResolvedVkAccount,
): Promise<void> {
  if (!account.token) {
    return;
  }

  const peerId = Number(normalizeVkTargetId(to));
  const startMessageId = Number(messageId);
  if (Number.isNaN(peerId) || Number.isNaN(startMessageId)) {
    return;
  }

  const vk = getOrCreateVk(account.token);
  await withVkRetry(async () => {
    await vk.api.messages.markAsRead({
      peer_id: peerId,
      start_message_id: startMessageId,
      mark_conversation_as_read: true,
    });
  });
}

// VK reaction id catalog as returned by messages.getReactionsAssets (16 items):
//   1=❤️ 2=🔥 3=😂 4=👍 5=💩 6=⁉️ 7=😭 8=😡
//   9=👎 10=👌 11=😄 12=🤔 13=🙏 14=😘 15=😍 16=🎉
const VK_REACTION_ID_DEFAULT = 4; // 👍

const VK_REACTION_ID_BY_EMOJI: Readonly<Record<string, number>> = {
  "❤️": 1,
  "❤": 1,
  "🔥": 2,
  "😂": 3,
  "🤣": 3,
  "👍": 4,
  "💩": 5,
  "⁉️": 6,
  "⁉": 6,
  "😭": 7,
  "😡": 8,
  "👎": 9,
  "👌": 10,
  "😄": 11,
  "🤔": 12,
  "🙏": 13,
  "😘": 14,
  "😍": 15,
  "🎉": 16,
};

export function mapEmojiToVkReactionId(emoji: string): number {
  return VK_REACTION_ID_BY_EMOJI[emoji] ?? VK_REACTION_ID_DEFAULT;
}

export async function sendReactionVk(
  to: string,
  cmid: number,
  emoji: string,
  account: ResolvedVkAccount,
): Promise<boolean> {
  if (!account.token) {
    return false;
  }
  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId) || !Number.isFinite(cmid)) {
    return false;
  }
  const reactionId = mapEmojiToVkReactionId(emoji);
  const vk = getOrCreateVk(account.token);
  await withVkRetry(async () => {
    await vk.api.messages.sendReaction({
      peer_id: peerId,
      cmid,
      reaction_id: reactionId,
    });
  });
  return true;
}

export async function deleteReactionVk(
  to: string,
  cmid: number,
  account: ResolvedVkAccount,
): Promise<void> {
  if (!account.token) {
    return;
  }
  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId) || !Number.isFinite(cmid)) {
    return;
  }
  const vk = getOrCreateVk(account.token);
  await withVkRetry(async () => {
    await vk.api.messages.deleteReaction({
      peer_id: peerId,
      cmid,
    });
  });
}

async function sendMessageChunksVk(params: {
  to: string;
  chunks: VkPreparedFormattedMessage[];
  opts: SendVkOptions;
}): Promise<SendVkResult[]> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: params.opts.cfg,
    accountId: params.opts.accountId,
    to: params.to,
  });

  const results: SendVkResult[] = [];
  for (let index = 0; index < params.chunks.length; index += 1) {
    const chunk = params.chunks[index];
    if (!chunk || !chunk.text) {
      continue;
    }
    const isLast = index === params.chunks.length - 1;
    const result = await sendVkApiMessage({
      to: normalizedTo,
      peerId,
      account,
      formatted: chunk,
      opts: {
        ...params.opts,
        replyTo: index === 0 ? params.opts.replyTo : undefined,
        buttons: isLast ? params.opts.buttons : undefined,
        clearKeyboard: isLast ? params.opts.clearKeyboard : undefined,
      },
    });
    results.push(result);
  }
  return results;
}

async function sendResolvedMediaVk(params: {
  to: string;
  media: VkOutboundMediaReference;
  caption?: VkPreparedFormattedMessage;
  opts: SendVkOptions;
}): Promise<SendVkResult> {
  const media = await loadVkOutboundMedia({
    mediaUrl: params.media.url,
    mediaLocalRoots: params.opts.mediaLocalRoots,
    forceDocument: params.opts.forceDocument,
    preferredName: params.media.title,
    preferredMimeType: params.media.mimeType,
  });
  const sourceUrl = isHttpUrl(media.mediaUrl) ? media.mediaUrl : undefined;

  const sendSourceUrlFallback = async (): Promise<SendVkResult> => {
    if (!sourceUrl) {
      const captionText = params.caption?.text.trim();
      const fallbackText = captionText
        ? `${captionText}\n${VK_MEDIA_SCOPE_FALLBACK_NOTICE}`
        : VK_MEDIA_SCOPE_FALLBACK_NOTICE;
      return await sendMessageVk(params.to, fallbackText, params.opts);
    }
    const captionText = params.caption?.text.trim();
    const fallbackText = captionText ? `${captionText}\n${sourceUrl}` : sourceUrl;
    return await sendMessageVk(params.to, fallbackText, params.opts);
  };

  if (media.kind === "image") {
    let photoSource: string | Buffer = media.source;
    let photoError: unknown;
    try {
      return await sendPhotoVk(params.to, photoSource, params.caption, params.opts, {
        filename: media.title,
        contentType: media.mimeType,
      });
    } catch (error) {
      photoError = error;
    }

    if (sourceUrl && typeof photoSource === "string" && isVkPhotoSourceRejectedError(photoError)) {
      const materialized = await materializeRemoteVkPhotoSource(sourceUrl);
      if (!materialized) {
        return await sendSourceUrlFallback();
      }
      photoSource = materialized;
      try {
        return await sendPhotoVk(params.to, photoSource, params.caption, params.opts, {
          filename: media.title,
          contentType: media.mimeType,
        });
      } catch (retryPhotoError) {
        photoError = retryPhotoError;
      }
    }

    const shouldFallbackToDocument = isVkImageUploadFallbackError(photoError);
    if (!shouldFallbackToDocument) {
      throw photoError;
    }

    try {
      return await sendDocumentVk(params.to, photoSource, media.title, params.caption, params.opts, {
        contentType: media.mimeType,
      });
    } catch (documentError) {
      if (!isVkImageUploadFallbackError(documentError)) {
        throw documentError;
      }
      return await sendSourceUrlFallback();
    }
  }
  if (media.kind === "audio_message") {
    try {
      return await sendAudioMessageVk(params.to, media.source, media.title, params.caption, params.opts, {
        contentType: media.mimeType,
      });
    } catch (audioError) {
      // Voice is best-effort: log the *real* VK error (code/message) for
      // diagnosis, then fall back to text rather than dropping the reply or
      // mislabelling it as a scopes problem.
      await logVkVoiceDebug(
        `audio send FAILED to=${JSON.stringify(params.to)} code=${
          (audioError as { code?: unknown })?.code
        } scopeDenied=${isVkScopeDeniedError(audioError)} msg=${String(
          (audioError as { message?: unknown })?.message ?? "",
        ).slice(0, 200)}`,
      );
      return await sendSourceUrlFallback();
    }
  }
  try {
    return await sendDocumentVk(params.to, media.source, media.title, params.caption, params.opts, {
      contentType: media.mimeType,
    });
  } catch (documentError) {
    if (!isVkScopeDeniedError(documentError)) {
      throw documentError;
    }
    return await sendSourceUrlFallback();
  }
}

async function sendPayloadMediaVk(params: {
  to: string;
  mediaRefs: VkOutboundMediaReference[];
  text: string;
  opts: SendVkOptions;
}): Promise<SendVkResult[]> {
  const textChunks = prepareVkMessageChunks(params.text);
  let firstCaption = textChunks.shift();
  const results: SendVkResult[] = [];

  for (let index = 0; index < params.mediaRefs.length; index += 1) {
    const mediaRef = params.mediaRefs[index];
    const isLastMedia = index === params.mediaRefs.length - 1;
    const shouldApplyKeyboard = isLastMedia && textChunks.length === 0;
    const result = await sendResolvedMediaVk({
      to: params.to,
      media: mediaRef as VkOutboundMediaReference,
      caption: firstCaption,
      opts: {
        ...params.opts,
        replyTo: index === 0 ? params.opts.replyTo : undefined,
        buttons: shouldApplyKeyboard ? params.opts.buttons : undefined,
        clearKeyboard: shouldApplyKeyboard ? params.opts.clearKeyboard : undefined,
      },
    });
    results.push(result);
    firstCaption = undefined;
  }

  if (textChunks.length > 0) {
    const textResults = await sendMessageChunksVk({
      to: params.to,
      chunks: textChunks,
      opts: {
        ...params.opts,
        replyTo: undefined,
      },
    });
    results.push(...textResults);
  }

  return results;
}

async function sendPayloadResultsVk(params: {
  to: string;
  text: string;
  mediaRefs: VkOutboundMediaReference[];
  opts: SendVkOptions;
}): Promise<SendVkResult[]> {
  if (!params.text && params.mediaRefs.length === 0) {
    return [];
  }

  if (params.mediaRefs.length > 0) {
    return await sendPayloadMediaVk(params);
  }

  return await sendMessageChunksVk({
    to: params.to,
    chunks: prepareVkMessageChunks(params.text),
    opts: params.opts,
  });
}

export async function sendPayloadVk(
  to: string,
  payload: VkOutboundPayloadLike,
  opts: SendVkOptions = {},
): Promise<SendVkResult | null> {
  const { text, mediaRefs, buttons, replyTo, clearKeyboard } = resolveVkPayloadParts(payload, opts);
  await logVkVoiceDebug(
    `ENTRY sendPayloadVk to=${JSON.stringify(to)} mediaRefs=${JSON.stringify((mediaRefs ?? []).map((r) => r?.url))} textLen=${(text ?? "").length}`,
  );

  return getLastSendResult(
    await sendPayloadResultsVk({
      to,
      text,
      mediaRefs,
      opts: {
        ...opts,
        replyTo,
        buttons,
        clearKeyboard,
      },
    }),
  );
}

export function clearVkInstances(): void {
  vkInstances.clear();
}
