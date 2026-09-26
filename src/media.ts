import { readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { formatZonedTimestamp, type PluginRuntime } from "openclaw/plugin-sdk/core";
import type { VkInboundAttachment, VkInboundForward, VkInboundResolvedMedia } from "./types.js";

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

const DATA_URL_DEFAULT_NAME = "attachment.bin";
const DEFAULT_VK_INBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const OUTBOUND_REMOTE_METADATA_TIMEOUT_MS = 5_000;
const GENERIC_OUTBOUND_EXTENSIONS = new Set([".bin", ".dat"]);
const OUTBOUND_NAME_QUERY_KEYS = ["filename", "file", "name", "download"];
const OUTBOUND_MIME_QUERY_KEYS = [
  "response-content-type",
  "response-content_type",
  "content-type",
  "mime",
  "mimetype",
];
const MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".bmp": "image/bmp",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".log": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};
const PREFERRED_EXTENSION_BY_MIME: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "text/tab-separated-values": ".tsv",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

export type VkResolvedOutboundMedia = {
  kind: "image" | "document" | "audio_message";
  source: string | Buffer;
  title: string;
  mediaUrl: string;
  mimeType?: string;
};

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function pickFirstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function mimeFromExtension(ext?: string): string | undefined {
  const normalized = ext?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return MIME_BY_EXTENSION[normalized.startsWith(".") ? normalized : `.${normalized}`];
}

function extensionFromMimeType(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().split(";")[0];
  if (!normalized) {
    return undefined;
  }
  const entry = Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === normalized);
  return entry?.[0];
}

function preferredExtensionFromMimeType(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().split(";")[0];
  if (!normalized) {
    return undefined;
  }
  return PREFERRED_EXTENSION_BY_MIME[normalized] ?? extensionFromMimeType(normalized);
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFileNameCandidate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = decodeComponent(value.trim());
  if (!trimmed) {
    return undefined;
  }
  const normalized = basename(trimmed.replaceAll("\\", "/")).trim();
  return normalized || undefined;
}

function extractFilenameFromContentDisposition(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const starMatch = normalized.match(/filename\*\s*=\s*([^;]+)/i);
  const regularMatch = normalized.match(/filename\s*=\s*([^;]+)/i);
  const rawValue = starMatch?.[1] ?? regularMatch?.[1];
  if (!rawValue) {
    return undefined;
  }

  const unquoted = rawValue.trim().replace(/^['"]|['"]$/g, "");
  const encodedValue = unquoted.includes("''") ? unquoted.split("''").slice(1).join("''") : unquoted;
  return normalizeFileNameCandidate(encodedValue);
}

function mimeFromQueryParams(params: URLSearchParams): string | undefined {
  for (const key of OUTBOUND_MIME_QUERY_KEYS) {
    const value = params.get(key)?.trim().toLowerCase();
    if (value) {
      return value.split(";")[0];
    }
  }
  return undefined;
}

function mimeFromUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return mimeFromExtension(extname(parsed.pathname)) ?? mimeFromQueryParams(parsed.searchParams);
  } catch {
    return mimeFromExtension(extname(value));
  }
}

function readImageUrlList(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const urls = value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      return pickFirstString([
        readString(record, "url"),
        readString(record, "src"),
        readString(record, "baseUrl"),
      ]);
    })
    .filter((entry): entry is string => Boolean(entry));
  return urls.at(-1);
}

function readPhotoPreviewUrl(record: Record<string, unknown>): string | undefined {
  const preview =
    record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
      ? (record.preview as Record<string, unknown>)
      : undefined;
  if (!preview) {
    return undefined;
  }
  return readImageUrlList(preview.photo);
}

function readGraffitiPreviewUrl(record: Record<string, unknown>): string | undefined {
  const preview =
    record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
      ? (record.preview as Record<string, unknown>)
      : undefined;
  if (!preview?.graffiti || typeof preview.graffiti !== "object" || Array.isArray(preview.graffiti)) {
    return undefined;
  }
  return readString(preview.graffiti as Record<string, unknown>, "src");
}

function readAudioMessagePreviewUrl(record: Record<string, unknown>): string | undefined {
  const preview =
    record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
      ? (record.preview as Record<string, unknown>)
      : undefined;
  if (
    !preview?.audio_message ||
    typeof preview.audio_message !== "object" ||
    Array.isArray(preview.audio_message)
  ) {
    return undefined;
  }
  const audioPreview = preview.audio_message as Record<string, unknown>;
  return pickFirstString([
    readString(audioPreview, "link_mp3"),
    readString(audioPreview, "link_ogg"),
  ]);
}

function normalizeVkAttachmentKind(type: string, record: Record<string, unknown>): string {
  switch (type) {
    case "photo":
      return "image";
    case "doc":
    case "document":
      if (readBoolean(record, "isImage")) {
        return "image";
      }
      if (readBoolean(record, "isAudio") || readBoolean(record, "isVoice")) {
        return "audio";
      }
      if (readBoolean(record, "isVideo")) {
        return "video";
      }
      return "document";
    case "audio_message":
      return "audio";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "sticker":
      return "sticker";
    case "graffiti":
      return "image";
    case "link":
      return "link";
    default:
      return type || "attachment";
  }
}

function normalizeVkAttachmentTitle(type: string, record: Record<string, unknown>): string | undefined {
  if (type === "audio_message") {
    return "voice-message";
  }
  return pickFirstString([
    readString(record, "title"),
    readString(record, "name"),
    readString(record, "caption"),
    readString(record, "text"),
  ]);
}

function normalizeVkAttachmentUrl(type: string, record: Record<string, unknown>): string | undefined {
  switch (type) {
    case "photo":
      return pickFirstString([
        readString(record, "largeSizeUrl"),
        readString(record, "mediumSizeUrl"),
        readString(record, "smallSizeUrl"),
        readString(record, "url"),
        readImageUrlList(record.sizes),
      ]);
    case "doc":
    case "document":
      return pickFirstString([
        readPhotoPreviewUrl(record),
        readGraffitiPreviewUrl(record),
        readAudioMessagePreviewUrl(record),
        readString(record, "url"),
        readString(record, "previewUrl"),
      ]);
    case "audio_message":
      return pickFirstString([
        readString(record, "mp3Url"),
        readString(record, "oggUrl"),
        readString(record, "url"),
      ]);
    case "audio":
      return readString(record, "url");
    case "video":
      return pickFirstString([readString(record, "player"), readString(record, "url")]);
    case "sticker":
    case "graffiti":
      return pickFirstString([
        readImageUrlList(record.imagesWithBackground),
        readImageUrlList(record.images),
        readString(record, "url"),
      ]);
    case "link":
      return readString(record, "url");
    default:
      return readString(record, "url");
  }
}

function inferVkAttachmentMimeType(
  type: string,
  record: Record<string, unknown>,
  url?: string,
): string | undefined {
  const fromUrl = mimeFromUrl(url);
  switch (type) {
    case "photo":
      return fromUrl ?? "image/jpeg";
    case "sticker":
    case "graffiti":
      return fromUrl ?? "image/png";
    case "audio_message":
      if (typeof record.mp3Url === "string" && record.mp3Url.trim()) {
        return "audio/mpeg";
      }
      if (typeof record.oggUrl === "string" && record.oggUrl.trim()) {
        return "audio/ogg";
      }
      return fromUrl ?? "audio/ogg";
    case "audio":
      return fromUrl;
    case "video":
      return fromUrl;
    case "doc":
    case "document": {
      const typeId = typeof record.typeId === "number" ? record.typeId : undefined;
      const ext = readString(record, "ext") ?? readString(record, "extension");
      const fromExt = mimeFromExtension(ext);
      if (readBoolean(record, "isImage") || typeId === 4) {
        return fromExt ?? fromUrl ?? "image/jpeg";
      }
      if (readBoolean(record, "isAudio") || readBoolean(record, "isVoice") || typeId === 5) {
        return fromExt ?? fromUrl ?? "audio/ogg";
      }
      if (readBoolean(record, "isVideo") || typeId === 6) {
        return fromExt ?? fromUrl ?? "video/mp4";
      }
      return fromExt ?? fromUrl;
    }
    default:
      return fromUrl;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A wall post shared into the chat (vk-io's `WallAttachment`). It has no media
 * of its own, so the model used to get a bare `<media:wall>`: the link and the
 * text are what it needs, and the post's photos go on as images. A repost keeps
 * the original's text and photos in `copyHistory`.
 */
function readVkWallPost(record: Record<string, unknown>): {
  post: NonNullable<VkInboundAttachment["post"]>;
  attachments: unknown[];
} {
  const { ownerId, id } = record;
  const url =
    typeof ownerId === "number" && typeof id === "number"
      ? `https://vk.com/wall${ownerId}_${id}`
      : undefined;
  const history = Array.isArray(record.copyHistory) ? record.copyHistory : [];
  const posts = [
    record,
    ...history.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry)),
  ];
  const text =
    posts
      .map((entry) => readString(entry, "text"))
      .filter(Boolean)
      .join("\n\n") || undefined;
  const attachments = posts.flatMap((entry) =>
    Array.isArray(entry.attachments) ? entry.attachments : [],
  );
  return { post: { url, text }, attachments };
}

export function extractVkInboundAttachments(rawAttachments: unknown): VkInboundAttachment[] {
  if (!Array.isArray(rawAttachments)) {
    return [];
  }

  return rawAttachments.flatMap((attachment): VkInboundAttachment[] => {
    const record = asRecord(attachment);
    if (!record) {
      return [];
    }
    const type = readString(record, "type") ?? "attachment";
    const url = normalizeVkAttachmentUrl(type, record);
    const entry: VkInboundAttachment = {
      type,
      kind: normalizeVkAttachmentKind(type, record),
      url,
      title: normalizeVkAttachmentTitle(type, record),
      mimeType: inferVkAttachmentMimeType(type, record, url),
    };
    if (type !== "wall") {
      return [entry];
    }
    const { post, attachments } = readVkWallPost(record);
    // The post's own media keeps its provenance: it is the post speaking, not
    // the sender, and only its images may be downloaded (`collectVkOwnMedia`).
    return [
      { ...entry, post },
      ...extractVkInboundAttachments(attachments).map((nested) => ({ ...nested, fromPost: true })),
    ];
  });
}

/** Forwards kept per inbound message, nested ones included. */
export const MAX_VK_FORWARDS = 10;

/**
 * Messages forwarded into this one — vk-io's `forwards`, where each forward is
 * a MessageContext of its own — two levels deep, within `capVkForwards`.
 */
export function extractVkInboundForwards(raw: unknown): VkInboundForward[] {
  return capVkForwards(readVkForwards(raw, 2));
}

function readVkForwards(raw: unknown, depth: number): VkInboundForward[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item): VkInboundForward[] => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    const { senderId, createdAt } = record;
    const forward: VkInboundForward = {
      senderId: typeof senderId === "number" ? senderId : 0,
      text: readString(record, "text") ?? "",
    };
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
      forward.timestamp = createdAt * 1000;
    }
    const messageId = readVkId(record.id);
    if (messageId !== undefined) {
      forward.messageId = messageId;
    }
    const conversationMessageId = readVkId(record.conversationMessageId);
    if (conversationMessageId !== undefined) {
      forward.conversationMessageId = conversationMessageId;
    }
    const attachments = extractVkInboundAttachments(record.attachments);
    if (attachments.length > 0) {
      forward.attachments = attachments;
    }
    const nested = depth > 1 ? readVkForwards(record.forwards, depth - 1) : [];
    if (nested.length > 0) {
      forward.forwards = nested;
    }
    return [forward];
  });
}

/** A VK message id: forwards carry 0 or nothing when VK withholds it. */
function readVkId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Ten forwards in total, nested ones included: a chain of forwards is no reason
 * to flood the prompt. Every top-level forward is kept first, then nested ones
 * in order, so one forward full of others cannot crowd out the ones next to it.
 */
export function capVkForwards(forwards: readonly VkInboundForward[]): VkInboundForward[] {
  let left = MAX_VK_FORWARDS;
  const kept = forwards.slice(0, left).map((forward) => ({ ...forward }));
  left -= kept.length;
  for (const forward of kept) {
    const nested = (forward.forwards ?? []).slice(0, left);
    left -= nested.length;
    if (nested.length > 0) {
      forward.forwards = nested;
    } else {
      delete forward.forwards;
    }
  }
  return kept;
}

export function resolveVkInboundReplyContext(replyMessage: unknown): {
  replyToMessageId?: string;
  replyToText?: string;
  /** When the quoted message was sent, in milliseconds. */
  replyToTimestamp?: number;
  replyToForwards?: VkInboundForward[];
  /** Author of the quoted message; negative for a community. */
  replyToSenderId?: number;
} {
  if (!replyMessage || typeof replyMessage !== "object" || Array.isArray(replyMessage)) {
    return {};
  }
  const record = replyMessage as Record<string, unknown>;
  const replyToMessageId = pickFirstString([
    typeof record.id === "number" ? String(record.id) : undefined,
    readString(record, "id"),
  ]);
  // The quoted message is described the way an incoming one is: taking only its
  // text left a quoted post, photo or voice message as a bare id.
  const replyToText =
    resolveVkInboundAgentText({
      text: pickFirstString([readString(record, "text"), readString(record, "message")]),
      attachments: extractVkInboundAttachments(record.attachments),
    }) || undefined;
  const replyToForwards = extractVkInboundForwards(record.forwards);
  const replyToSenderId =
    typeof record.senderId === "number" && record.senderId !== 0 ? record.senderId : undefined;
  const replyToTimestamp =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt) && record.createdAt > 0
      ? record.createdAt * 1000
      : undefined;
  return {
    replyToMessageId,
    replyToText,
    ...(replyToTimestamp !== undefined ? { replyToTimestamp } : {}),
    ...(replyToForwards.length > 0 ? { replyToForwards } : {}),
    ...(replyToSenderId !== undefined ? { replyToSenderId } : {}),
  };
}

export function resolveVkInboundMediaUrls(
  attachments: readonly VkInboundAttachment[] | undefined,
): string[] {
  return Array.from(
    new Set(
      (attachments ?? [])
        .map((attachment) => attachment.url?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
}

export function resolveVkInboundMediaTypes(
  attachments: readonly VkInboundAttachment[] | undefined,
): string[] {
  return Array.from(
    new Set(
      (attachments ?? [])
        .map(
          (attachment) =>
            attachment.mimeType?.trim() || attachment.kind?.trim() || attachment.type?.trim(),
        )
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
}

function shouldMaterializeVkInboundAttachment(attachment: VkInboundAttachment): boolean {
  const kind = attachment.kind?.trim().toLowerCase();
  const type = attachment.type?.trim().toLowerCase();
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (!attachment.url?.trim()) {
    return false;
  }
  if (kind === "link" || type === "link") {
    return false;
  }
  if (mimeType?.startsWith("image/") || mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) {
    return true;
  }
  return kind === "image" || kind === "audio" || kind === "video" || kind === "document" || kind === "sticker";
}

function buildVkInboundMediaFileHint(attachment: VkInboundAttachment): string {
  const title = attachment.title?.trim();
  if (title) {
    return basename(title);
  }
  const sourceUrl = attachment.url?.trim();
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      const name = basename(parsed.pathname);
      if (name) {
        return name;
      }
    } catch {
      const name = basename(sourceUrl);
      if (name) {
        return name;
      }
    }
  }
  const ext = extensionFromMimeType(attachment.mimeType) ?? "";
  return `${attachment.kind || attachment.type || "attachment"}${ext}`;
}

export async function resolveVkInboundResolvedMedia(params: {
  attachments?: readonly VkInboundAttachment[];
  mediaRuntime?: Pick<PluginRuntime["channel"]["media"], "fetchRemoteMedia" | "saveMediaBuffer">;
  maxBytes?: number;
  logError?: (line: string) => void;
}): Promise<VkInboundResolvedMedia[]> {
  const attachments = params.attachments ?? [];
  if (attachments.length === 0) {
    return [];
  }

  const maxBytes = params.maxBytes ?? DEFAULT_VK_INBOUND_MEDIA_MAX_BYTES;
  const out: VkInboundResolvedMedia[] = [];
  for (const attachment of attachments) {
    const url = attachment.url?.trim();
    if (!url) {
      continue;
    }
    if (!params.mediaRuntime || !shouldMaterializeVkInboundAttachment(attachment)) {
      out.push({
        url,
        contentType: attachment.mimeType,
        attachment,
      });
      continue;
    }

    try {
      const fileHint = buildVkInboundMediaFileHint(attachment);
      const fetched = await params.mediaRuntime.fetchRemoteMedia({
        url,
        filePathHint: fileHint,
        maxBytes,
      });
      const saved = await params.mediaRuntime.saveMediaBuffer(
        Buffer.from(fetched.buffer),
        fetched.contentType ?? attachment.mimeType,
        "inbound",
        maxBytes,
        fileHint,
      );
      out.push({
        path: saved.path,
        url,
        contentType: saved.contentType ?? attachment.mimeType,
        attachment,
      });
    } catch (err) {
      params.logError?.(`vk: inbound media download failed for ${url}: ${String(err)}`);
      out.push({
        url,
        contentType: attachment.mimeType,
        attachment,
      });
    }
  }
  return out;
}

export function resolveVkInboundResolvedMediaPaths(
  media: readonly VkInboundResolvedMedia[] | undefined,
): string[] {
  return (media ?? [])
    .map((entry) => entry.path?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

export function resolveVkInboundResolvedMediaUrls(
  media: readonly VkInboundResolvedMedia[] | undefined,
): string[] {
  return (media ?? [])
    .filter((entry) => Boolean(entry.path?.trim()))
    .map((entry) => entry.url.trim())
    .filter(Boolean);
}

export function resolveVkInboundResolvedMediaTypes(
  media: readonly VkInboundResolvedMedia[] | undefined,
): string[] {
  return (media ?? [])
    .filter((entry) => Boolean(entry.path?.trim()))
    .map((entry) => entry.contentType?.trim() || entry.attachment.mimeType?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

function describeVkWallPost(post: NonNullable<VkInboundAttachment["post"]>): string {
  const header = post.url ? `[VK wall post ${post.url}]` : "[VK wall post]";
  return post.text ? `${header}\n${post.text}` : header;
}

/**
 * What the sender wrote, as control input: commands, directives and the mention
 * gate must see only this. A shared post or a forward is a third party’s text,
 * so it stays out. A message without text keeps a placeholder: left empty, the
 * core would fall back to the body and read that text as the sender’s command.
 */
export function resolveVkInboundBodyText(params: {
  text?: string | null;
  attachments?: readonly VkInboundAttachment[];
  forwards?: readonly VkInboundForward[];
}): string {
  const trimmedText = params.text?.trim() ?? "";
  if (trimmedText) {
    return trimmedText;
  }

  const mediaKinds = Array.from(
    new Set(
      (params.attachments ?? [])
        .map((attachment) => attachment.kind?.trim() || attachment.type?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  if (mediaKinds.length === 0) {
    return (params.forwards?.length ?? 0) > 0 ? "<forwarded>" : "";
  }

  return `<media:${mediaKinds[0] ?? "attachment"}>`;
}

/**
 * A time in the zone the core writes the message's own in: the configured
 * `agents.defaults.userTimezone`, else the host's. Minutes are enough for a
 * forward. Without envelope options, or if the zone cannot be formatted, plain
 * ISO in UTC as before.
 */
export function formatVkTimestamp(ms: number, envelope?: EnvelopeFormatOptions): string {
  const date = new Date(ms);
  if (!envelope) {
    return date.toISOString();
  }
  return formatZonedTimestamp(date, { timeZone: resolveVkTimeZone(envelope) }) ?? date.toISOString();
}

/** `resolveEnvelopeFormatOptions` gives a checked IANA zone, "local" or nothing. */
function resolveVkTimeZone(envelope: EnvelopeFormatOptions): string | undefined {
  const configured = envelope.timezone?.trim();
  const lowered = configured?.toLowerCase();
  if (!configured || lowered === "local" || lowered === "host") {
    return undefined;
  }
  if (lowered === "utc" || lowered === "gmt") {
    return "UTC";
  }
  return configured;
}

/** A forward as the agent sees it: author, date and ids, then its own body. */
function describeVkForward(forward: VkInboundForward, envelope?: EnvelopeFormatOptions): string {
  const at = forward.timestamp !== undefined ? ` at ${formatVkTimestamp(forward.timestamp, envelope)}` : "";
  const ids = [
    forward.messageId !== undefined ? `message_id:${forward.messageId}` : undefined,
    forward.conversationMessageId !== undefined ? `cmid:${forward.conversationMessageId}` : undefined,
  ].filter(Boolean);
  const idLabel = ids.length > 0 ? `, ${ids.join(", ")}` : "";
  const body = resolveVkInboundAgentText({ text: forward.text, attachments: forward.attachments });
  const own = [`[Forwarded from vk:${forward.senderId}${at}${idLabel}]`, body].filter(Boolean).join("\n");
  return [own, ...(forward.forwards ?? []).map((nested) => describeVkForward(nested, envelope))].join(
    "\n\n",
  );
}

/**
 * The body the agent sees: the sender’s text plus any post shared with it and
 * any messages forwarded into it. The caller decides which forwards are visible;
 * `envelope` puts forward times in the user's timezone.
 */
export function resolveVkInboundAgentText(params: {
  text?: string | null;
  attachments?: readonly VkInboundAttachment[];
  forwards?: readonly VkInboundForward[];
  envelope?: EnvelopeFormatOptions;
}): string {
  const posts = (params.attachments ?? []).flatMap((attachment) =>
    attachment.post ? [describeVkWallPost(attachment.post)] : [],
  );
  const forwarded = (params.forwards ?? []).map((forward) => describeVkForward(forward, params.envelope));
  const own =
    posts.length > 0
      ? [params.text?.trim() ?? "", ...posts]
      : [resolveVkInboundBodyText({ text: params.text, attachments: params.attachments })];
  return [...own, ...forwarded].filter(Boolean).join("\n\n");
}

function isHttpMediaUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value);
}

function inferDocumentNameFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const nameFromDisposition = extractFilenameFromContentDisposition(
      parsed.searchParams.get("response-content-disposition") ?? undefined,
    );
    if (nameFromDisposition) {
      return nameFromDisposition;
    }

    for (const key of OUTBOUND_NAME_QUERY_KEYS) {
      const candidate = normalizeFileNameCandidate(parsed.searchParams.get(key) ?? undefined);
      if (candidate) {
        return candidate;
      }
    }

    return normalizeFileNameCandidate(parsed.pathname) ?? "attachment";
  } catch {
    return normalizeFileNameCandidate(value) ?? "attachment";
  }
}

function hasUsefulOutboundExtension(value: string): boolean {
  const extension = extname(value).trim().toLowerCase();
  return Boolean(extension) && !GENERIC_OUTBOUND_EXTENSIONS.has(extension);
}

function normalizeOutboundTitle(value: string | undefined, mimeType?: string): string {
  const normalized = normalizeFileNameCandidate(value) ?? "attachment";
  const extension = extname(normalized).trim().toLowerCase();
  const preferredExtension = preferredExtensionFromMimeType(mimeType);
  if (!preferredExtension) {
    return normalized;
  }
  if (!extension) {
    return `${normalized}${preferredExtension}`;
  }
  if (!GENERIC_OUTBOUND_EXTENSIONS.has(extension)) {
    return normalized;
  }

  const base = normalized.slice(0, -extension.length).trim() || "attachment";
  return `${base}${preferredExtension}`;
}

function inferOutboundKind(params: {
  name: string;
  mimeType?: string;
  forceDocument?: boolean;
}): "image" | "document" | "audio_message" {
  if (params.forceDocument) {
    return "document";
  }
  const mimeType = params.mimeType?.trim().toLowerCase();
  if (mimeType && mimeType.startsWith("image/") && mimeType !== "image/gif") {
    return "image";
  }
  if (mimeType && mimeType.startsWith("audio/")) {
    return "audio_message";
  }
  const extension = extname(params.name).trim().toLowerCase();
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio_message";
  }
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "document";
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType?: string; name: string } {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  const mimeType = match[1]?.trim().toLowerCase() || undefined;
  const isBase64 = Boolean(match[2]);
  const body = match[3] ?? "";
  const buffer = isBase64
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body), "utf8");
  const extension = preferredExtensionFromMimeType(mimeType) ?? "";
  const name = extension ? `attachment${extension}` : DATA_URL_DEFAULT_NAME;
  return { buffer, mimeType, name };
}

async function readRemoteMediaMetadata(
  mediaUrl: string,
): Promise<{ title?: string; mimeType?: string }> {
  if (typeof fetch !== "function") {
    return {};
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTBOUND_REMOTE_METADATA_TIMEOUT_MS);
  let headResponse: Response | undefined;
  let getResponse: Response | undefined;

  try {
    try {
      headResponse = await fetch(mediaUrl, {
        method: "HEAD",
        signal: controller.signal,
      });
    } catch {
      headResponse = undefined;
    }

    let mimeType =
      headResponse?.ok === true
        ? headResponse.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || undefined
        : undefined;
    let title =
      headResponse?.ok === true
        ? extractFilenameFromContentDisposition(headResponse.headers.get("content-disposition") ?? undefined)
        : undefined;

    if (!mimeType || !title) {
      try {
        getResponse = await fetch(mediaUrl, {
          method: "GET",
          signal: controller.signal,
        });
      } catch {
        getResponse = undefined;
      }

      if (getResponse?.ok) {
        mimeType ||= getResponse.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || undefined;
        title ||= extractFilenameFromContentDisposition(getResponse.headers.get("content-disposition") ?? undefined);
      }
    }

    return { title, mimeType };
  } finally {
    clearTimeout(timeout);
    void headResponse?.body?.cancel?.();
    void getResponse?.body?.cancel?.();
  }
}

async function resolveAllowedLocalPath(
  input: string,
  mediaLocalRoots?: readonly string[],
): Promise<string> {
  const normalizedInput = input.startsWith("file://") ? fileURLToPath(input) : input;
  const resolvedRoots = (
    await Promise.all(
      (mediaLocalRoots ?? []).map(async (root) => {
        const trimmed = root?.trim();
        if (!trimmed) {
          return null;
        }
        try {
          return await realpath(trimmed);
        } catch {
          return null;
        }
      }),
    )
  ).filter((entry): entry is string => Boolean(entry));

  const hasRootRestrictions = Boolean(mediaLocalRoots?.length);
  const isWithinAllowedRoot = (resolvedPath: string) =>
    resolvedRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`));

  // Relative MEDIA paths should resolve from an allowed root/workspace, not the gateway cwd.
  if (!isAbsolute(normalizedInput) && hasRootRestrictions) {
    for (const root of resolvedRoots) {
      const candidatePath = resolvePath(root, normalizedInput);
      try {
        const resolvedCandidate = await realpath(candidatePath);
        if (isWithinAllowedRoot(resolvedCandidate)) {
          return resolvedCandidate;
        }
      } catch {
        // Try the next allowed root.
      }
    }

    if (resolvedRoots.length === 0) {
      throw new Error(`Local media path is outside allowed roots: ${input}`);
    }

    const attemptedPath = resolvePath(resolvedRoots[0], normalizedInput);
    const resolvedAttemptedPath = await realpath(attemptedPath);
    if (!isWithinAllowedRoot(resolvedAttemptedPath)) {
      throw new Error(`Local media path is outside allowed roots: ${input}`);
    }
    return resolvedAttemptedPath;
  }

  const absolutePath = isAbsolute(normalizedInput)
    ? normalizedInput
    : resolvePath(normalizedInput);
  const resolvedPath = await realpath(absolutePath);

  if (!hasRootRestrictions) {
    return resolvedPath;
  }

  if (!isWithinAllowedRoot(resolvedPath)) {
    throw new Error(`Local media path is outside allowed roots: ${input}`);
  }

  return resolvedPath;
}

export async function loadVkOutboundMedia(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  forceDocument?: boolean;
  preferredName?: string;
  preferredMimeType?: string;
}): Promise<VkResolvedOutboundMedia> {
  const mediaUrl = params.mediaUrl.trim();
  if (!mediaUrl) {
    throw new Error("Missing media URL");
  }

  const preferredName = params.preferredName?.trim() || undefined;
  const preferredMimeType =
    params.preferredMimeType?.trim().toLowerCase() ||
    mimeFromExtension(extname(preferredName ?? ""));

  if (isDataUrl(mediaUrl)) {
    const decoded = decodeDataUrl(mediaUrl);
    const mimeType = preferredMimeType ?? decoded.mimeType;
    const title = normalizeOutboundTitle(preferredName ?? decoded.name, mimeType);
    return {
      kind: inferOutboundKind({
        name: title,
        mimeType,
        forceDocument: params.forceDocument,
      }),
      source: decoded.buffer,
      title,
      mediaUrl,
      mimeType,
    };
  }

  if (isHttpMediaUrl(mediaUrl)) {
    const inferredTitle = preferredName ?? inferDocumentNameFromUrl(mediaUrl);
    let mimeType = preferredMimeType ?? mimeFromUrl(mediaUrl);
    let title = normalizeOutboundTitle(inferredTitle, mimeType);
    mimeType ??= mimeFromExtension(extname(title));

    if (!preferredName && (!mimeType || !hasUsefulOutboundExtension(title))) {
      const remoteMetadata = await readRemoteMediaMetadata(mediaUrl);
      mimeType ||= remoteMetadata.mimeType;
      title = normalizeOutboundTitle(remoteMetadata.title ?? inferredTitle, mimeType);
      mimeType ??= mimeFromExtension(extname(title));
    }

    return {
      kind: inferOutboundKind({
        name: title,
        mimeType,
        forceDocument: params.forceDocument,
      }),
      source: mediaUrl,
      title,
      mediaUrl,
      mimeType,
    };
  }

  const localPath = await resolveAllowedLocalPath(mediaUrl, params.mediaLocalRoots);
  const mimeType = preferredMimeType ?? mimeFromExtension(extname(localPath));
  const title = normalizeOutboundTitle(preferredName ?? (basename(localPath) || "attachment"), mimeType);
  return {
    kind: inferOutboundKind({
      name: title,
      mimeType,
      forceDocument: params.forceDocument,
    }),
    source: await readFile(localPath),
    title,
    mediaUrl: localPath,
    mimeType,
  };
}
