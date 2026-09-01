import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VK } from "vk-io";
import {
  applyVkAllowlistConfigEdit,
  clearVkInstances,
  isVkGroupPeerId,
  mapEmojiToVkReactionId,
  markMessageReadVk,
  normalizeVkDirectoryEntries,
  normalizeVkSenderAllowEntry,
  normalizeVkTargetId,
  primeVkGroupId,
  readVkAllowlistConfig,
  resolveVkDirectoryGroups,
  resolveVkDirectoryPeers,
  sendDocumentVk,
  sendAudioMessageVk,
  sendFormattedMediaVk,
  sendFormattedTextVk,
  sendMessageVk,
  sendPayloadVk,
  sendPhotoVk,
  sendReactionVk,
  deleteReactionVk,
  sendTypingVk,
} from "./send.js";
import { makeAccount } from "./test-helpers.js";

// ── SDK mocks (for transitive accounts.ts import) ───────────────────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/account-id", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

const mockGetVkRuntime = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    channel: {
      activity: { record: vi.fn() },
    },
    config: { loadConfig: vi.fn().mockReturnValue({}) },
  }),
);

vi.mock("./runtime.js", () => ({
  getVkRuntime: mockGetVkRuntime,
}));

const mockMessagesSend = vi.hoisted(() => vi.fn());
const mockMessagesMarkAsRead = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockSetActivity = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockSendReaction = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockDeleteReaction = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockUploadPhoto = vi.hoisted(() => vi.fn().mockResolvedValue("photo123_456"));
const mockUploadDocument = vi.hoisted(() => vi.fn().mockResolvedValue("doc123_789"));
const mockUploadAudioMessage = vi.hoisted(() => vi.fn().mockResolvedValue("audio_message123_789"));
const mockGroupsGetById = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] }),
);
const mockGetRandomId = vi.hoisted(() => vi.fn().mockReturnValue(99999));
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("vk-io", () => ({
  // Must use a regular function (not an arrow) so `new VK(...)` works.
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        groups: {
          getById: mockGroupsGetById,
        },
        messages: {
          send: mockMessagesSend,
          markAsRead: mockMessagesMarkAsRead,
          setActivity: mockSetActivity,
          sendReaction: mockSendReaction,
          deleteReaction: mockDeleteReaction,
        },
      },
      upload: {
        messagePhoto: mockUploadPhoto,
        messageDocument: mockUploadDocument,
        audioMessage: mockUploadAudioMessage,
      },
    };
  }),
  getRandomId: mockGetRandomId,
}));
vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

// ── audio-chunk mocks (ffmpeg/ffprobe split) ────────────────────────────────
const mockProbeAudioDurationMs = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockSplitAudioAtSilence = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockCleanupAudioSegments = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./audio-chunk.js", () => ({
  getVkAudioMessageMaxMs: () => 270_000,
  probeAudioDurationMs: mockProbeAudioDurationMs,
  splitAudioAtSilence: mockSplitAudioAtSilence,
  cleanupAudioSegments: mockCleanupAudioSegments,
}));

const TOKEN = "test-token";
const cfg = { channels: { vk: { token: TOKEN } } } as never;

type VkSendCall = Record<string, unknown> & {
  message?: string;
  format_data?: string;
  keyboard?: string;
};

type VkFormatDataPayload = {
  version: number;
  items: Array<{ type: string; offset: number; length: number; url?: string }>;
};

type VkKeyboardPayload = {
  one_time: boolean;
  buttons: Array<Array<{ action: { label: string; payload: string }; color: string }>>;
};

function getSendCall(index = 0): VkSendCall {
  const call = mockMessagesSend.mock.calls[index]?.[0] as VkSendCall | undefined;
  expect(call).toBeDefined();
  return call as VkSendCall;
}

function parseVkFormatData(value: unknown): VkFormatDataPayload {
  expect(value).toBeTypeOf("string");
  return JSON.parse(value as string) as VkFormatDataPayload;
}

function parseVkKeyboard(value: unknown): VkKeyboardPayload {
  expect(value).toBeTypeOf("string");
  return JSON.parse(value as string) as VkKeyboardPayload;
}

beforeEach(() => {
  clearVkInstances();
  mockMessagesSend.mockReset();
  mockMessagesMarkAsRead.mockReset().mockResolvedValue(1);
  mockSetActivity.mockReset().mockResolvedValue(1);
  mockSendReaction.mockReset().mockResolvedValue(1);
  mockDeleteReaction.mockReset().mockResolvedValue(1);
  mockUploadPhoto.mockReset().mockResolvedValue("photo123_456");
  mockUploadDocument.mockReset().mockResolvedValue("doc123_789");
  mockUploadAudioMessage.mockReset().mockResolvedValue("audio_message123_789");
  mockGroupsGetById.mockReset().mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] });
  mockFetch.mockReset().mockRejectedValue(new Error("unexpected fetch"));
  // Reset constructor counters between tests.
  vi.mocked(VK).mockClear();
});

describe("sendMessageVk", () => {
  it("sends a text message and returns messageId + chatId", async () => {
    mockMessagesSend.mockResolvedValueOnce(42);

    const result = await sendMessageVk("123456", "hello", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith({
      peer_id: 123456,
      message: "hello",
      random_id: 99999,
    });
    expect(result).toEqual({ messageId: "42", chatId: "123456" });
  });

  it("adds format_data when markdown formatting is present", async () => {
    mockMessagesSend.mockResolvedValueOnce(99);

    await sendMessageVk(
      "123456",
      "**bold** and *italic* and ***both*** with [link](https://example.com)",
      { cfg },
    );

    const call = getSendCall();
    expect(call.message).toBe("bold and italic and both with link");
    const formatData = parseVkFormatData(call.format_data);
    expect(formatData.version).toBe(1);
    expect(formatData.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 9, length: 6 },
        { type: "bold", offset: 20, length: 4 },
        { type: "italic", offset: 20, length: 4 },
        { type: "url", offset: 30, length: 4, url: "https://example.com" },
      ]),
    );
  });

  it("throws when peer ID is not a number", async () => {
    await expect(
      sendMessageVk("not-a-number", "text", { cfg }),
    ).rejects.toThrow("Invalid VK peer ID: not-a-number");
  });

  it("accepts vk-prefixed direct targets", async () => {
    mockMessagesSend.mockResolvedValueOnce(43);

    const result = await sendMessageVk("vk:123456", "hello", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: 123456 }),
    );
    expect(result).toEqual({ messageId: "43", chatId: "123456" });
  });

  it("throws when no token is configured", async () => {
    await expect(
      sendMessageVk("123", "text", { cfg: {} as never }),
    ).rejects.toThrow("VK token not configured");
  });

  it("sends long text in multiple 4096-character chunks", async () => {
    mockMessagesSend.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const longText = "a".repeat(5000);

    const result = await sendMessageVk("123", longText, { cfg });

    expect(result).toEqual({ messageId: "2", chatId: "123" });
    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
    expect(getSendCall(0).message).toBe("a".repeat(4096));
    expect(getSendCall(1).message).toBe("a".repeat(904));
  });

  it("includes reply_to when provided", async () => {
    mockMessagesSend.mockResolvedValueOnce(5);

    await sendMessageVk("123", "reply", { cfg, replyTo: "77" });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ reply_to: 77 }),
    );
  });

  it("does not include reply_to when not provided", async () => {
    mockMessagesSend.mockResolvedValueOnce(5);

    await sendMessageVk("123", "msg", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.not.objectContaining({ reply_to: expect.anything() }),
    );
  });

  it("forwards keyboard when buttons are provided", async () => {
    mockMessagesSend.mockResolvedValueOnce(7);

    await sendMessageVk("123", "menu", {
      cfg,
      buttons: [[{ text: "Browse providers", callback_data: "/models", style: "primary" }]],
    });

    const call = getSendCall();
    const keyboard = parseVkKeyboard(call.keyboard);
    expect(keyboard.one_time).toBe(true);
    expect(keyboard.buttons[0]?.[0]?.action.label).toBe("Browse providers");
    expect(keyboard.buttons[0]?.[0]?.action.payload).toBe(JSON.stringify({ oc: "/models" }));
  });

  it("reuses the same VK instance for the same token", async () => {
    mockMessagesSend.mockResolvedValue(1);

    await sendMessageVk("1", "a", { cfg });
    await sendMessageVk("2", "b", { cfg });

    expect(vi.mocked(VK)).toHaveBeenCalledTimes(1);
  });

  it("creates a separate VK instance for a different token", async () => {
    mockMessagesSend.mockResolvedValue(1);

    await sendMessageVk("1", "a", { cfg });
    await sendMessageVk("1", "b", {
      cfg: { channels: { vk: { token: "other-token" } } } as never,
    });

    expect(vi.mocked(VK)).toHaveBeenCalledTimes(2);
  });

  it("works with group chat peer IDs (>= 2_000_000_000)", async () => {
    mockMessagesSend.mockResolvedValueOnce(10);
    const groupPeerId = "2000000001";

    const result = await sendMessageVk(groupPeerId, "hi group", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: 2_000_000_001 }),
    );
    expect(result.chatId).toBe(groupPeerId);
  });

  it("treats markdown image syntax in text as outbound media", async () => {
    mockMessagesSend.mockResolvedValueOnce(41);

    const result = await sendMessageVk(
      "123",
      "Держи:\n\n![картинка](https://example.com/reply-back.jpg)",
      { cfg },
    );

    expect(result).toEqual({ messageId: "41", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/reply-back.jpg",
        filename: "reply-back.jpg",
        contentType: "image/jpeg",
      },
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Держи:",
        attachment: "photo123_456",
      }),
    );
  });

  it("treats local markdown file links in text as outbound documents", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openclaw-vk-doc-"));
    const filePath = join(tempDir, "artifact");
    await writeFile(filePath, "hello");
    mockMessagesSend.mockResolvedValueOnce(45);

    const result = await sendMessageVk(
      "123",
      `Да — вот небольшой файл:\n\n[test-small.txt](${pathToFileURL(filePath).toString()})`,
      { cfg, mediaLocalRoots: [tempDir] },
    );

    expect(result).toEqual({ messageId: "45", chatId: "123" });
    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: expect.any(Buffer),
        filename: "test-small.txt",
        contentType: "text/plain",
      },
      title: "test-small.txt",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Да — вот небольшой файл:",
        attachment: "doc123_789",
      }),
    );
  });
});

describe("sendFormattedTextVk", () => {
  it("returns one delivery result per rendered VK chunk", async () => {
    mockMessagesSend.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const result = await sendFormattedTextVk("123", `**${"a".repeat(5000)}**`, { cfg });

    expect(result).toEqual([
      { messageId: "1", chatId: "123" },
      { messageId: "2", chatId: "123" },
    ]);
    expect(getSendCall(0).message).toBe("a".repeat(4096));
    expect(parseVkFormatData(getSendCall(0).format_data).items).toEqual([
      { type: "bold", offset: 0, length: 4096 },
    ]);
    expect(getSendCall(1).message).toBe("a".repeat(904));
    expect(parseVkFormatData(getSendCall(1).format_data).items).toEqual([
      { type: "bold", offset: 0, length: 904 },
    ]);
  });

  it("routes markdown image syntax through media delivery instead of plain text", async () => {
    mockMessagesSend.mockResolvedValueOnce(43);

    const result = await sendFormattedTextVk(
      "123",
      "Держи:\n\n![картинка](https://example.com/reply-back.jpg)",
      { cfg },
    );

    expect(result).toEqual([{ messageId: "43", chatId: "123" }]);
    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/reply-back.jpg",
        filename: "reply-back.jpg",
        contentType: "image/jpeg",
      },
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Держи:",
        attachment: "photo123_456",
      }),
    );
  });

  it("routes local markdown file links through document delivery", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openclaw-vk-doc-"));
    const filePath = join(tempDir, "artifact");
    await writeFile(filePath, "hello");
    mockMessagesSend.mockResolvedValueOnce(46);

    const result = await sendFormattedTextVk(
      "123",
      `Да — вот небольшой файл:\n\n[test-small.txt](${pathToFileURL(filePath).toString()})`,
      { cfg, mediaLocalRoots: [tempDir] },
    );

    expect(result).toEqual([{ messageId: "46", chatId: "123" }]);
    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: expect.any(Buffer),
        filename: "test-small.txt",
        contentType: "text/plain",
      },
      title: "test-small.txt",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Да — вот небольшой файл:",
        attachment: "doc123_789",
      }),
    );
  });
});

// ── sendPhotoVk ──────────────────────────────────────────────────────────────

describe("sendPhotoVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    mockUploadPhoto.mockReset().mockResolvedValue("photo123_456");
    vi.mocked(VK).mockClear();
  });

  it("uploads photo and sends message with attachment", async () => {
    mockMessagesSend.mockResolvedValueOnce(99);

    const result = await sendPhotoVk("123", "https://example.com/img.png", "caption", { cfg });

    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: { value: "https://example.com/img.png" },
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: 123,
        message: "caption",
        attachment: "photo123_456",
      }),
    );
    expect(result).toEqual({ messageId: "99", chatId: "123" });
  });

  it("sends empty message text when no caption", async () => {
    mockMessagesSend.mockResolvedValueOnce(1);

    await sendPhotoVk("123", Buffer.from("png"), undefined, { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ message: "" }),
    );
  });

  it("sends long photo captions as attachment text plus tail chunks", async () => {
    mockMessagesSend.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const result = await sendPhotoVk("123", "src", "a".repeat(5000), { cfg });

    expect(result).toEqual({ messageId: "2", chatId: "123" });
    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
    expect(getSendCall(0).message).toBe("a".repeat(4096));
    expect(getSendCall(0).attachment).toBe("photo123_456");
    expect(getSendCall(1).message).toBe("a".repeat(904));
    expect(getSendCall(1)).not.toHaveProperty("attachment");
  });

  it("throws when token is not configured", async () => {
    await expect(
      sendPhotoVk("123", "src", undefined, { cfg: {} as never }),
    ).rejects.toThrow("VK token not configured");
  });

  it("throws when peer ID is invalid", async () => {
    await expect(
      sendPhotoVk("abc", "src", undefined, { cfg }),
    ).rejects.toThrow("Invalid VK peer ID: abc");
  });
});

// ── sendDocumentVk ───────────────────────────────────────────────────────────

describe("sendDocumentVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    mockUploadDocument.mockReset().mockResolvedValue("doc123_789");
    vi.mocked(VK).mockClear();
  });

  it("uploads document and sends message with attachment", async () => {
    mockMessagesSend.mockResolvedValueOnce(77);

    const result = await sendDocumentVk("456", Buffer.from("pdf"), "report.pdf", "Here is the report", { cfg });

    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 456,
      source: { value: Buffer.from("pdf"), filename: "report.pdf" },
      title: "report.pdf",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: 456,
        message: "Here is the report",
        attachment: "doc123_789",
      }),
    );
    expect(result).toEqual({ messageId: "77", chatId: "456" });
  });

  it("sends empty message text when no caption", async () => {
    mockMessagesSend.mockResolvedValueOnce(1);

    await sendDocumentVk("123", "src", "file.txt", undefined, { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ message: "" }),
    );
  });

  it("throws when token is not configured", async () => {
    await expect(
      sendDocumentVk("123", "src", "file.txt", undefined, { cfg: {} as never }),
    ).rejects.toThrow("VK token not configured");
  });

  it("throws when peer ID is invalid", async () => {
    await expect(
      sendDocumentVk("abc", "src", "file.txt", undefined, { cfg }),
    ).rejects.toThrow("Invalid VK peer ID: abc");
  });
});

describe("sendAudioMessageVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    mockUploadAudioMessage.mockReset().mockResolvedValue("audio_message123_789");
    mockProbeAudioDurationMs.mockReset().mockResolvedValue(null);
    mockSplitAudioAtSilence.mockReset().mockResolvedValue([]);
    mockCleanupAudioSegments.mockReset().mockResolvedValue(undefined);
    vi.mocked(VK).mockClear();
  });

  it("uploads audio as VK audio_message and sends it as attachment", async () => {
    mockMessagesSend.mockResolvedValueOnce(88);

    const result = await sendAudioMessageVk("456", "https://example.com/voice.mp3", "voice.mp3", "caption", {
      cfg,
    });

    expect(mockUploadAudioMessage).toHaveBeenCalledWith({
      peer_id: 456,
      source: {
        value: "https://example.com/voice.mp3",
        filename: "voice.mp3",
      },
      title: "voice.mp3",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: 456,
        message: "caption",
        attachment: "audio_message123_789",
      }),
    );
    expect(result).toEqual({ messageId: "88", chatId: "456" });
    // Remote URL → split is skipped entirely (not a local path).
    expect(mockProbeAudioDurationMs).not.toHaveBeenCalled();
    expect(mockSplitAudioAtSilence).not.toHaveBeenCalled();
  });

  it("keeps the single-message path for a short local file", async () => {
    mockMessagesSend.mockResolvedValueOnce(88);
    mockProbeAudioDurationMs.mockResolvedValueOnce(60_000); // 1 min ≤ limit

    const result = await sendAudioMessageVk("456", "/tmp/voice.ogg", "voice.ogg", "caption", {
      cfg,
    });

    expect(mockProbeAudioDurationMs).toHaveBeenCalledWith("/tmp/voice.ogg");
    expect(mockSplitAudioAtSilence).not.toHaveBeenCalled();
    expect(mockUploadAudioMessage).toHaveBeenCalledTimes(1);
    expect(mockMessagesSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageId: "88", chatId: "456" });
  });

  it("splits an over-limit local file into multiple voice messages", async () => {
    mockProbeAudioDurationMs.mockResolvedValueOnce(600_000); // 10 min > limit
    mockSplitAudioAtSilence.mockResolvedValueOnce(["/tmp/part-0.ogg", "/tmp/part-1.ogg"]);
    mockUploadAudioMessage
      .mockResolvedValueOnce("audio_part1")
      .mockResolvedValueOnce("audio_part2");
    mockMessagesSend.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

    const result = await sendAudioMessageVk("456", "/tmp/long.ogg", "long.ogg", "caption", {
      cfg,
      replyTo: "777",
    });

    expect(mockSplitAudioAtSilence).toHaveBeenCalledWith("/tmp/long.ogg", 270_000);
    // Two voice uploads, one per segment.
    expect(mockUploadAudioMessage).toHaveBeenCalledTimes(2);
    expect(mockUploadAudioMessage.mock.calls[0]?.[0]).toMatchObject({
      source: expect.objectContaining({ value: "/tmp/part-0.ogg" }),
    });
    // Two voice messages sent in order; caption + replyTo on first only.
    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
    expect(getSendCall(0)).toMatchObject({
      message: "caption",
      attachment: "audio_part1",
      reply_to: 777,
    });
    expect(getSendCall(1)).toMatchObject({ attachment: "audio_part2" });
    expect(getSendCall(1)).not.toHaveProperty("reply_to");
    // Segment temp files cleaned up.
    expect(mockCleanupAudioSegments).toHaveBeenCalledWith(["/tmp/part-0.ogg", "/tmp/part-1.ogg"]);
    expect(result).toEqual({ messageId: "102", chatId: "456" });
  });

  it("sends tail text chunks after all voice segments", async () => {
    mockProbeAudioDurationMs.mockResolvedValueOnce(600_000);
    mockSplitAudioAtSilence.mockResolvedValueOnce(["/tmp/part-0.ogg", "/tmp/part-1.ogg"]);
    mockUploadAudioMessage
      .mockResolvedValueOnce("audio_part1")
      .mockResolvedValueOnce("audio_part2");
    // 2 voice sends + 1 tail text-chunk send (5000 chars → 4096 + 904; the
    // first 4096 chunk rides voice #1, the 904 remainder is the single tail).
    mockMessagesSend
      .mockResolvedValueOnce(101)
      .mockResolvedValueOnce(102)
      .mockResolvedValueOnce(103);

    const longTail = "a".repeat(5000);
    const result = await sendAudioMessageVk("456", "/tmp/long.ogg", "long.ogg", longTail, { cfg });

    // First voice carries chunk 0; remaining text chunk comes after both voices.
    expect(mockMessagesSend).toHaveBeenCalledTimes(3);
    expect(getSendCall(0).attachment).toBe("audio_part1");
    expect(getSendCall(0).message).toBe("a".repeat(4096));
    expect(getSendCall(1).attachment).toBe("audio_part2");
    expect(getSendCall(2)).not.toHaveProperty("attachment");
    expect(getSendCall(2).message).toBe("a".repeat(904));
    expect(result).toEqual({ messageId: "103", chatId: "456" });
  });

  it("falls back to single upload when split fails (ffmpeg error)", async () => {
    mockProbeAudioDurationMs.mockResolvedValueOnce(600_000);
    mockSplitAudioAtSilence.mockResolvedValueOnce([]); // split could not produce ≥2 parts
    mockMessagesSend.mockResolvedValueOnce(88);

    const result = await sendAudioMessageVk("456", "/tmp/long.ogg", "long.ogg", "caption", { cfg });

    expect(mockSplitAudioAtSilence).toHaveBeenCalledTimes(1);
    // Falls back to the single upload of the original source.
    expect(mockUploadAudioMessage).toHaveBeenCalledTimes(1);
    expect(mockUploadAudioMessage.mock.calls[0]?.[0]).toMatchObject({
      source: expect.objectContaining({ value: "/tmp/long.ogg" }),
    });
    expect(mockMessagesSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageId: "88", chatId: "456" });
  });

  it("does not crash and falls back when probe throws", async () => {
    mockProbeAudioDurationMs.mockRejectedValueOnce(new Error("ffprobe missing"));
    mockMessagesSend.mockResolvedValueOnce(88);

    const result = await sendAudioMessageVk("456", "/tmp/long.ogg", "long.ogg", "caption", { cfg });

    expect(mockSplitAudioAtSilence).not.toHaveBeenCalled();
    expect(mockUploadAudioMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageId: "88", chatId: "456" });
  });
});

describe("sendFormattedMediaVk", () => {
  it("sends media with the first formatted chunk and returns the final tail result", async () => {
    mockMessagesSend.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const result = await sendFormattedMediaVk("123", "a".repeat(5000), "https://example.com/img.png", { cfg });

    expect(result).toEqual({ messageId: "2", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/img.png",
        filename: "img.png",
        contentType: "image/png",
      },
    });
    expect(getSendCall(0).message).toBe("a".repeat(4096));
    expect(getSendCall(0).attachment).toBe("photo123_456");
    expect(getSendCall(1).message).toBe("a".repeat(904));
    expect(getSendCall(1)).not.toHaveProperty("attachment");
  });
});

// ── sendTypingVk ─────────────────────────────────────────────────────────────

describe("sendTypingVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesMarkAsRead.mockReset().mockResolvedValue(1);
    mockSetActivity.mockReset().mockResolvedValue(1);
    mockGroupsGetById.mockReset().mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] });
    vi.mocked(VK).mockClear();
  });

  it("sends typing indicator", async () => {
    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith({
      group_id: 12345678,
      peer_id: 123,
      type: "typing",
    });
  });

  it("silently returns when token is empty", async () => {
    await sendTypingVk("123", makeAccount({ token: "" }));

    expect(mockSetActivity).not.toHaveBeenCalled();
  });

  it("silently returns when peer ID is not a number", async () => {
    await sendTypingVk("abc", makeAccount());

    expect(mockSetActivity).not.toHaveBeenCalled();
  });

  it("normalizes vk-prefixed peer IDs", async () => {
    await sendTypingVk("vk:user:123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: 123 }),
    );
  });

  it("throws typing errors so the caller can log them", async () => {
    mockSetActivity.mockRejectedValueOnce(new Error("VK API error"));

    await expect(sendTypingVk("123", makeAccount())).rejects.toThrow("VK API error");
  });

  it("omits group_id when the token group cannot be resolved", async () => {
    mockGroupsGetById.mockRejectedValueOnce(new Error("groups.getById failed"));

    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith({
      peer_id: 123,
      type: "typing",
    });
  });
});

describe("markMessageReadVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesMarkAsRead.mockReset().mockResolvedValue(1);
    vi.mocked(VK).mockClear();
  });

  it("marks the incoming VK message as read", async () => {
    await markMessageReadVk("123", "77", makeAccount());

    expect(mockMessagesMarkAsRead).toHaveBeenCalledWith({
      peer_id: 123,
      start_message_id: 77,
      mark_conversation_as_read: true,
    });
  });

  it("returns early when peer or message id is invalid", async () => {
    await markMessageReadVk("abc", "77", makeAccount());
    await markMessageReadVk("123", "nope", makeAccount());

    expect(mockMessagesMarkAsRead).not.toHaveBeenCalled();
  });

  it("normalizes vk-prefixed peer IDs before marking messages read", async () => {
    await markMessageReadVk("vk:chat:123", "77", makeAccount());

    expect(mockMessagesMarkAsRead).toHaveBeenCalledWith({
      peer_id: 123,
      start_message_id: 77,
      mark_conversation_as_read: true,
    });
  });
});

describe("mapEmojiToVkReactionId", () => {
  it("maps known emojis to their VK reaction ids", () => {
    expect(mapEmojiToVkReactionId("❤️")).toBe(1);
    expect(mapEmojiToVkReactionId("🔥")).toBe(2);
    expect(mapEmojiToVkReactionId("😂")).toBe(3);
    expect(mapEmojiToVkReactionId("👍")).toBe(4);
    expect(mapEmojiToVkReactionId("💩")).toBe(5);
    expect(mapEmojiToVkReactionId("😡")).toBe(8);
    expect(mapEmojiToVkReactionId("🤔")).toBe(12);
    expect(mapEmojiToVkReactionId("🎉")).toBe(16);
  });

  it("falls back to thumbs up for unsupported emoji", () => {
    expect(mapEmojiToVkReactionId("👀")).toBe(4);
    expect(mapEmojiToVkReactionId("🧠")).toBe(4);
    expect(mapEmojiToVkReactionId("not-an-emoji")).toBe(4);
  });
});

describe("sendReactionVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockSendReaction.mockReset().mockResolvedValue(1);
    vi.mocked(VK).mockClear();
  });

  it("posts the mapped reaction id to VK", async () => {
    const ok = await sendReactionVk("123", 42, "👍", makeAccount());

    expect(ok).toBe(true);
    expect(mockSendReaction).toHaveBeenCalledWith({
      peer_id: 123,
      cmid: 42,
      reaction_id: 4,
    });
  });

  it("normalizes vk-prefixed peer IDs", async () => {
    await sendReactionVk("vk:chat:9", 7, "❤️", makeAccount());

    expect(mockSendReaction).toHaveBeenCalledWith({
      peer_id: 9,
      cmid: 7,
      reaction_id: 1,
    });
  });

  it("silently returns false when token is empty", async () => {
    const ok = await sendReactionVk("123", 42, "👍", makeAccount({ token: "" }));

    expect(ok).toBe(false);
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it("silently returns false when peer or cmid is invalid", async () => {
    await sendReactionVk("abc", 42, "👍", makeAccount());
    await sendReactionVk("123", Number.NaN, "👍", makeAccount());

    expect(mockSendReaction).not.toHaveBeenCalled();
  });
});

describe("deleteReactionVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockDeleteReaction.mockReset().mockResolvedValue(1);
    vi.mocked(VK).mockClear();
  });

  it("posts deleteReaction with peer_id and cmid", async () => {
    await deleteReactionVk("123", 42, makeAccount());

    expect(mockDeleteReaction).toHaveBeenCalledWith({
      peer_id: 123,
      cmid: 42,
    });
  });
});

describe("sendPayloadVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset().mockResolvedValue(22);
    vi.mocked(VK).mockClear();
  });

  it("sends explicit vk buttons through sendMessageVk", async () => {
    const result = await sendPayloadVk(
      "123",
      {
        text: "Select a provider:",
        channelData: {
          vk: {
            buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
          },
        },
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "22", chatId: "123" });
    const call = getSendCall();
    expect(call.message).toBe("Select a provider:");
    const keyboard = parseVkKeyboard(call.keyboard);
    expect(keyboard.buttons[0]?.[0]?.action.label).toBe("OpenAI");
    expect(keyboard.buttons[0]?.[0]?.action.payload).toBe(JSON.stringify({ oc: "/models openai" }));
  });

  it("enriches parsed model text with keyboard buttons containing correct labels", async () => {
    await sendPayloadVk(
      "123",
      {
        text: [
          "Providers:",
          "- anthropic (2)",
          "- openai (3)",
          "",
          "Use: /models <provider>",
        ].join("\n"),
      },
      { cfg },
    );

    const call = getSendCall();
    const parsed = parseVkKeyboard(call.keyboard);
    const labels = parsed.buttons.flat().map((b) => b.action.label);
    expect(labels).toContain("anthropic");
    expect(labels).toContain("openai");

    const payloads = parsed.buttons.flat().map((b) => JSON.parse(b.action.payload));
    expect(payloads).toContainEqual({ oc: "/models anthropic" });
    expect(payloads).toContainEqual({ oc: "/models openai" });
  });

  it("returns null when payload has no text or media", async () => {
    const result = await sendPayloadVk("123", { text: "   " }, { cfg });
    expect(result).toBeNull();
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it("sends an explicit empty keyboard when clearKeyboard=true and no new buttons exist", async () => {
    await sendPayloadVk(
      "123",
      {
        text: "Done.",
      },
      { cfg, clearKeyboard: true },
    );

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        keyboard: JSON.stringify({ one_time: false, buttons: [] }),
      }),
    );
  });

  it("sends chunked text and only attaches the keyboard to the final chunk", async () => {
    mockMessagesSend.mockResolvedValue(22);
    const text = "a".repeat(4100);

    await sendPayloadVk(
      "123",
      {
        text,
        channelData: {
          vk: {
            buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
          },
        },
      },
      { cfg },
    );

    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
    const firstCall = getSendCall(0);
    expect(firstCall.message).toBe("a".repeat(4096));
    expect(firstCall).not.toHaveProperty("keyboard");

    const secondCall = getSendCall(1);
    expect(secondCall.message).toBe("a".repeat(4));
    const keyboard = parseVkKeyboard(secondCall.keyboard);
    expect(keyboard.buttons[0]?.[0]?.action.label).toBe("OpenAI");
    expect(keyboard.buttons[0]?.[0]?.action.payload).toBe(JSON.stringify({ oc: "/models openai" }));
  });

  it("sends image media through VK upload flow instead of appending a link to text", async () => {
    mockMessagesSend.mockResolvedValueOnce(24);

    await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/photo.png",
        filename: "photo.png",
        contentType: "image/png",
      },
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "caption",
        attachment: "photo123_456",
      }),
    );
  });

  it("retries image upload with downloaded buffer when VK rejects URL source", async () => {
    const invalidPhotoError = Object.assign(
      new Error("Code №100 - One of the parameters specified was missing or invalid: photo is undefined"),
      { code: 100 },
    );
    mockUploadPhoto.mockRejectedValueOnce(invalidPhotoError).mockResolvedValueOnce("photo321_654");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: () => "image/png",
      },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    } as Response);
    mockMessagesSend.mockResolvedValueOnce(34);

    const result = await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "34", chatId: "123" });
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/photo.png", expect.any(Object));
    expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
    expect(mockUploadPhoto.mock.calls[0]?.[0]).toEqual({
      peer_id: 123,
      source: {
        value: "https://example.com/photo.png",
        filename: "photo.png",
        contentType: "image/png",
      },
    });
    expect(mockUploadPhoto.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        peer_id: 123,
        source: expect.objectContaining({ value: expect.any(Buffer) }),
      }),
    );
    expect(mockMessagesSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "caption",
        attachment: "photo321_654",
      }),
    );
  });

  it("falls through to document upload when both URL photo attempts are rejected", async () => {
    const invalidPhotoError = Object.assign(
      new Error("Code №100 - One of the parameters specified was missing or invalid: photo is undefined"),
      { code: 100 },
    );
    mockUploadPhoto.mockRejectedValueOnce(invalidPhotoError).mockRejectedValueOnce(invalidPhotoError);
    mockUploadDocument.mockResolvedValueOnce("doc321_654");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: () => "image/png",
      },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    } as Response);
    mockMessagesSend.mockResolvedValueOnce(38);

    const result = await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "38", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: expect.any(Buffer),
        filename: "photo.png",
        contentType: "image/png",
      },
      title: "photo.png",
    });
  });

  it("falls back to URL text when VK rejects URL photo and remote download fails", async () => {
    const invalidPhotoError = Object.assign(
      new Error("Code №100 - One of the parameters specified was missing or invalid: photo is undefined"),
      { code: 100 },
    );
    mockUploadPhoto.mockRejectedValueOnce(invalidPhotoError);
    mockFetch.mockRejectedValueOnce(new Error("download failed"));
    mockMessagesSend.mockResolvedValueOnce(35);

    const result = await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "35", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    expect(mockUploadDocument).not.toHaveBeenCalled();
    expect(mockMessagesSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "caption\nhttps://example.com/photo.png",
      }),
    );
    expect(getSendCall(mockMessagesSend.mock.calls.length - 1)).not.toHaveProperty("attachment");
  });

  it("rethrows non-fallback photo upload errors", async () => {
    const photoError = new Error("photo upload exploded");
    mockUploadPhoto.mockRejectedValueOnce(photoError);

    await expect(
      sendPayloadVk(
        "123",
        {
          text: "caption",
          mediaUrl: "https://example.com/photo.png",
        },
        { cfg },
      ),
    ).rejects.toThrow("photo upload exploded");
  });

  it("falls back to URL text when fetched URL is not an image content-type", async () => {
    const invalidPhotoError = Object.assign(
      new Error("Code №100 - One of the parameters specified was missing or invalid: photo is undefined"),
      { code: 100 },
    );
    mockUploadPhoto.mockRejectedValueOnce(invalidPhotoError);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: () => "text/html; charset=utf-8",
      },
      arrayBuffer: async () => Buffer.from("<html>not image</html>").buffer,
    } as Response);
    mockMessagesSend.mockResolvedValueOnce(36);

    const result = await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "36", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    expect(mockMessagesSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "caption\nhttps://example.com/photo.png",
      }),
    );
    expect(getSendCall(mockMessagesSend.mock.calls.length - 1)).not.toHaveProperty("attachment");
  });

  it("falls back to document upload when photo upload is denied by token scopes", async () => {
    const scopeError = Object.assign(
      new Error("Code №15 - Access denied: no access to call this method. It cannot be called with current scopes."),
      { code: 15 },
    );
    mockUploadPhoto.mockRejectedValueOnce(scopeError);
    mockUploadDocument.mockResolvedValueOnce("doc123_789");
    mockMessagesSend.mockResolvedValueOnce(29);

    const result = await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "29", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/photo.png",
        filename: "photo.png",
        contentType: "image/png",
      },
    });
    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/photo.png",
        filename: "photo.png",
        contentType: "image/png",
      },
      title: "photo.png",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "caption",
        attachment: "doc123_789",
      }),
    );
  });

  it("falls back to URL text when both photo and document uploads are denied by token scopes", async () => {
    const scopeError = Object.assign(
      new Error("Code №15 - Access denied: no access to call this method. It cannot be called with current scopes."),
      { code: 15 },
    );
    mockUploadPhoto.mockRejectedValueOnce(scopeError);
    mockUploadDocument.mockRejectedValueOnce(scopeError);
    mockMessagesSend.mockResolvedValueOnce(30);

    const result = await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "30", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          value: "https://example.com/photo.png",
          filename: "photo.png",
          contentType: "image/png",
        },
      }),
    );
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          value: "https://example.com/photo.png",
          filename: "photo.png",
          contentType: "image/png",
        },
        title: "photo.png",
      }),
    );
    expect(mockMessagesSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "caption\nhttps://example.com/photo.png",
      }),
    );
    expect(getSendCall(mockMessagesSend.mock.calls.length - 1)).not.toHaveProperty(
      "attachment",
    );
  });

  it("rethrows non-fallback errors from document upload after photo rejection", async () => {
    const scopeError = Object.assign(
      new Error("Code №15 - Access denied: no access to call this method. It cannot be called with current scopes."),
      { code: 15 },
    );
    const documentError = new Error("document upload exploded");
    mockUploadPhoto.mockRejectedValueOnce(scopeError);
    mockUploadDocument.mockRejectedValueOnce(documentError);

    await expect(
      sendPayloadVk(
        "123",
        {
          text: "caption",
          mediaUrl: "https://example.com/photo.png",
        },
        { cfg },
      ),
    ).rejects.toThrow("document upload exploded");
  });

  it("sends explanatory text fallback when media has no public URL and upload is denied", async () => {
    const scopeError = Object.assign(
      new Error("Code №15 - Access denied: no access to call this method. It cannot be called with current scopes."),
      { code: 15 },
    );
    mockUploadPhoto.mockRejectedValueOnce(scopeError);
    mockUploadDocument.mockRejectedValueOnce(scopeError);
    mockMessagesSend.mockResolvedValueOnce(33);

    const result = await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "33", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ value: expect.any(Buffer) }),
      }),
    );
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ value: expect.any(Buffer) }),
      }),
    );
    const fallbackCall = getSendCall(mockMessagesSend.mock.calls.length - 1);
    expect(fallbackCall.message).toContain("caption");
    expect(fallbackCall.message).toContain(
      "Attachment could not be delivered; sent as text instead.",
    );
    expect(fallbackCall).not.toHaveProperty("attachment");
  });

  it("sends audio media through VK audio_message upload flow", async () => {
    mockMessagesSend.mockResolvedValueOnce(28);

    await sendPayloadVk(
      "123",
      {
        text: "voice caption",
        mediaUrl: "https://example.com/voice.mp3",
      },
      { cfg },
    );

    expect(mockUploadAudioMessage).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/voice.mp3",
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      },
      title: "voice.mp3",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "voice caption",
        attachment: "audio_message123_789",
      }),
    );
  });

  it("falls back to URL text when audio_message upload is denied by token scopes", async () => {
    const scopeError = Object.assign(
      new Error("Code №15 - Access denied: no access to call this method. It cannot be called with current scopes."),
      { code: 15 },
    );
    // Error 15 is retried (transient under batching); reject every attempt so
    // the retries are exhausted and the URL-text fallback is exercised.
    mockUploadAudioMessage.mockRejectedValue(scopeError);
    mockMessagesSend.mockResolvedValueOnce(37);

    const result = await sendPayloadVk(
      "123",
      {
        text: "voice caption",
        mediaUrl: "https://example.com/voice.mp3",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "37", chatId: "123" });
    expect(mockMessagesSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "voice caption\nhttps://example.com/voice.mp3",
      }),
    );
  });

  it("falls back to text when audio_message upload fails (voice is best-effort)", async () => {
    const audioError = new Error("audio upload exploded");
    mockUploadAudioMessage.mockRejectedValue(audioError);
    mockMessagesSend.mockResolvedValueOnce(41);

    const result = await sendPayloadVk(
      "123",
      {
        text: "voice caption",
        mediaUrl: "https://example.com/voice.mp3",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "41", chatId: "123" });
    expect(mockMessagesSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "voice caption\nhttps://example.com/voice.mp3",
      }),
    );
  });

  it("sends remaining text chunks after media as plain messages", async () => {
    mockMessagesSend.mockResolvedValue(31);
    const text = "a".repeat(9000);

    const result = await sendPayloadVk(
      "123",
      {
        text,
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "31", chatId: "123" });
    expect(mockMessagesSend).toHaveBeenCalledTimes(3);
    expect(getSendCall(0).message).toBe("a".repeat(4096));
    expect(getSendCall(0).attachment).toBe("photo123_456");
    expect(getSendCall(1).message).toBe("a".repeat(4096));
    expect(getSendCall(1)).not.toHaveProperty("attachment");
    expect(getSendCall(2).message).toBe("a".repeat(808));
    expect(getSendCall(2)).not.toHaveProperty("attachment");
  });

  it("falls back to URL text when document upload is denied by token scopes", async () => {
    const scopeError = Object.assign(
      new Error("Code №15 - Access denied: no access to call this method. It cannot be called with current scopes."),
      { code: 15 },
    );
    mockUploadDocument.mockRejectedValueOnce(scopeError);
    mockMessagesSend.mockResolvedValueOnce(32);

    const result = await sendPayloadVk(
      "123",
      {
        text: "doc caption",
        mediaUrl: "https://example.com/report.pdf",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "32", chatId: "123" });
    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/report.pdf",
        filename: "report.pdf",
        contentType: "application/pdf",
      },
      title: "report.pdf",
    });
    expect(mockMessagesSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "doc caption\nhttps://example.com/report.pdf",
      }),
    );
  });

  it("uses remote metadata to keep document filenames on extensionless URLs", async () => {
    const cancel = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? "application/pdf"
            : name.toLowerCase() === "content-disposition"
              ? 'attachment; filename="report.pdf"'
              : null,
      },
      body: { cancel },
    } as Response);
    mockMessagesSend.mockResolvedValueOnce(47);

    const result = await sendPayloadVk(
      "123",
      {
        text: "doc caption",
        mediaUrl: "https://example.com/download?id=42",
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "47", chatId: "123" });
    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: "https://example.com/download?id=42",
        filename: "report.pdf",
        contentType: "application/pdf",
      },
      title: "report.pdf",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("rethrows non-scope document upload errors", async () => {
    const documentError = new Error("document upload exploded");
    mockUploadDocument.mockRejectedValueOnce(documentError);

    await expect(
      sendPayloadVk(
        "123",
        {
          text: "doc caption",
          mediaUrl: "https://example.com/report.pdf",
        },
        { cfg },
      ),
    ).rejects.toThrow("document upload exploded");
  });

  it("resolves relative local document paths against mediaLocalRoots", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openclaw-vk-relative-doc-"));
    const cwd = process.cwd();
    const otherDir = await mkdtemp(join(tmpdir(), "openclaw-vk-relative-cwd-"));
    try {
      await writeFile(join(tempDir, "test-file.pdf"), Buffer.from("pdf"));
      mockMessagesSend.mockResolvedValueOnce(48);
      process.chdir(otherDir);

      const result = await sendPayloadVk(
        "123",
        {
          text: "doc caption",
          mediaUrl: "./test-file.pdf",
        },
        { cfg, mediaLocalRoots: [tempDir] },
      );

      expect(result).toEqual({ messageId: "48", chatId: "123" });
      expect(mockUploadDocument).toHaveBeenCalledWith({
        peer_id: 123,
        source: {
          value: expect.any(Buffer),
          filename: "test-file.pdf",
          contentType: "application/pdf",
        },
        title: "test-file.pdf",
      });
    } finally {
      process.chdir(cwd);
      await rm(tempDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("deduplicates mediaUrls", async () => {
    mockUploadPhoto.mockReset().mockResolvedValue("photo123_456");
    mockMessagesSend.mockResolvedValue(25);

    await sendPayloadVk(
      "123",
      {
        text: "two same images",
        mediaUrls: ["https://example.com/a.png", "https://example.com/a.png"],
      },
      { cfg },
    );

    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
  });

  it("prefers mediaUrls over mediaUrl when both present", async () => {
    mockMessagesSend.mockResolvedValue(26);

    await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/ignored.png",
        mediaUrls: ["https://example.com/used.png"],
      },
      { cfg },
    );

    expect(mockUploadPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          value: "https://example.com/used.png",
          filename: "used.png",
          contentType: "image/png",
        },
      }),
    );
  });

  it("forwards replyToId from payload", async () => {
    mockMessagesSend.mockResolvedValueOnce(27);

    await sendPayloadVk(
      "123",
      { text: "reply", replyToId: "77" },
      { cfg },
    );

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ reply_to: 77 }),
    );
  });

  it("extracts markdown image syntax from payload text and sends it as media", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openclaw-vk-image-"));
    const filePath = join(tempDir, "reply-back.jpg");
    await writeFile(filePath, Buffer.from([1, 2, 3, 4]));
    mockMessagesSend.mockResolvedValueOnce(44);

    const result = await sendPayloadVk(
      "123",
      {
        text: `Держи:\n\n![картинка](${pathToFileURL(filePath).toString()})`,
      },
      {
        cfg,
        mediaLocalRoots: [tempDir],
      },
    );

    expect(result).toEqual({ messageId: "44", chatId: "123" });
    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: {
        value: expect.any(Buffer),
        filename: "reply-back.jpg",
        contentType: "image/jpeg",
      },
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Держи:",
        attachment: "photo123_456",
      }),
    );
  });
});

// ── isVkGroupPeerId ─────────────────────────────────────────────────────────

describe("isVkGroupPeerId", () => {
  it("returns true for group peer IDs (>= 2_000_000_000)", () => {
    expect(isVkGroupPeerId(2_000_000_000)).toBe(true);
    expect(isVkGroupPeerId(2_000_000_001)).toBe(true);
    expect(isVkGroupPeerId("2000000005")).toBe(true);
  });

  it("returns false for DM peer IDs (< 2_000_000_000)", () => {
    expect(isVkGroupPeerId(123456)).toBe(false);
    expect(isVkGroupPeerId(1_999_999_999)).toBe(false);
    expect(isVkGroupPeerId("555000")).toBe(false);
  });

  it("returns false for NaN / non-numeric strings", () => {
    expect(isVkGroupPeerId("abc")).toBe(false);
    expect(isVkGroupPeerId("")).toBe(false);
  });
});

// ── normalizeVkTargetId ─────────────────────────────────────────────────────

describe("normalizeVkTargetId", () => {
  it("strips vk: prefix variants", () => {
    expect(normalizeVkTargetId("vk:123")).toBe("123");
    expect(normalizeVkTargetId("vk:user:456")).toBe("456");
    expect(normalizeVkTargetId("vk:chat:789")).toBe("789");
    expect(normalizeVkTargetId("VK:USER:100")).toBe("100");
  });

  it("trims whitespace", () => {
    expect(normalizeVkTargetId("  555  ")).toBe("555");
  });

  it("passes through plain numeric ids", () => {
    expect(normalizeVkTargetId(123456)).toBe("123456");
  });
});

// ── normalizeVkSenderAllowEntry ─────────────────────────────────────────────

describe("normalizeVkSenderAllowEntry", () => {
  it("strips vk: and vk:user: prefixes", () => {
    expect(normalizeVkSenderAllowEntry("vk:123")).toBe("123");
    expect(normalizeVkSenderAllowEntry("vk:user:456")).toBe("456");
  });

  it("does not strip vk:chat: (only user prefix)", () => {
    expect(normalizeVkSenderAllowEntry("vk:chat:789")).toBe("chat:789");
  });

  it("converts numbers to string", () => {
    expect(normalizeVkSenderAllowEntry(42)).toBe("42");
  });
});

// ── normalizeVkDirectoryEntries ─────────────────────────────────────────────

describe("normalizeVkDirectoryEntries", () => {
  it("returns user entries that are not group peer IDs", () => {
    const result = normalizeVkDirectoryEntries([123, 456], { kind: "user" });
    expect(result).toEqual([
      { kind: "user", id: "123" },
      { kind: "user", id: "456" },
    ]);
  });

  it("returns group entries that are group peer IDs", () => {
    const result = normalizeVkDirectoryEntries([2_000_000_001], { kind: "group" });
    expect(result).toEqual([{ kind: "group", id: "2000000001" }]);
  });

  it("excludes wildcard '*' entries", () => {
    const result = normalizeVkDirectoryEntries(["*", 123], { kind: "user" });
    expect(result).toEqual([{ kind: "user", id: "123" }]);
  });

  it("deduplicates entries", () => {
    const result = normalizeVkDirectoryEntries([123, 123, 123], { kind: "user" });
    expect(result).toEqual([{ kind: "user", id: "123" }]);
  });

  it("filters by query", () => {
    const result = normalizeVkDirectoryEntries([100, 200, 300], {
      kind: "user",
      query: "20",
    });
    expect(result).toEqual([{ kind: "user", id: "200" }]);
  });

  it("limits results", () => {
    const result = normalizeVkDirectoryEntries([100, 200, 300], {
      kind: "user",
      limit: 2,
    });
    expect(result).toHaveLength(2);
  });

  it("ignores invalid limit values", () => {
    const result = normalizeVkDirectoryEntries([100], { kind: "user", limit: -1 });
    expect(result).toHaveLength(1);

    const result2 = normalizeVkDirectoryEntries([100], { kind: "user", limit: 0 });
    expect(result2).toHaveLength(1);
  });

  it("filters out user-range IDs when kind=group", () => {
    const result = normalizeVkDirectoryEntries([123, 2_000_000_001], { kind: "group" });
    expect(result).toEqual([{ kind: "group", id: "2000000001" }]);
  });

  it("filters out group-range IDs when kind=user", () => {
    const result = normalizeVkDirectoryEntries([123, 2_000_000_001], { kind: "user" });
    expect(result).toEqual([{ kind: "user", id: "123" }]);
  });
});

// ── primeVkGroupId ──────────────────────────────────────────────────────────

describe("primeVkGroupId", () => {
  beforeEach(() => {
    clearVkInstances();
    vi.mocked(VK).mockClear();
  });

  it("primes the group ID for subsequent typing calls", async () => {
    mockMessagesSend.mockResolvedValue(1);

    primeVkGroupId("test-token", 12345678);
    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: 12345678 }),
    );
  });

  it("does not prime group ID for empty token", async () => {
    mockSetActivity.mockReset().mockResolvedValue(1);
    primeVkGroupId("", 123);

    // sendTypingVk with empty token returns early — no setActivity call
    await sendTypingVk("123", makeAccount({ token: "" }));
    expect(mockSetActivity).not.toHaveBeenCalled();
  });

  it("does not prime group ID for non-positive values", async () => {
    primeVkGroupId("test-token", 0);
    primeVkGroupId("test-token", -1);

    // Without a valid prime, group_id is resolved via groups.getById
    mockGroupsGetById.mockRejectedValueOnce(new Error("no group"));
    await sendTypingVk("123", makeAccount());

    // group_id should be absent since getById failed and prime was rejected
    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.not.objectContaining({ group_id: expect.anything() }),
    );
  });

  it("does not prime group ID for non-integer values", async () => {
    primeVkGroupId("test-token", 1.5);

    mockGroupsGetById.mockRejectedValueOnce(new Error("no group"));
    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.not.objectContaining({ group_id: expect.anything() }),
    );
  });
});

// ── readVkAllowlistConfig ───────────────────────────────────────────────────

describe("readVkAllowlistConfig", () => {
  it("returns allowlist config from account", () => {
    const result = readVkAllowlistConfig(
      makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [123, "456"],
          groupPolicy: "open",
          groupAllowFrom: [789],
        },
      }),
    );

    expect(result.dmAllowFrom).toEqual(["123", "456"]);
    expect(result.groupAllowFrom).toEqual(["789"]);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.groupPolicy).toBe("open");
  });

  it("returns empty arrays when not configured", () => {
    const result = readVkAllowlistConfig(makeAccount({ config: {} }));
    expect(result.dmAllowFrom).toEqual([]);
    expect(result.groupAllowFrom).toEqual([]);
    expect(result.groupOverrides).toEqual([]);
  });

  it("includes group overrides with allowFrom", () => {
    const result = readVkAllowlistConfig(
      makeAccount({
        config: {
          groups: {
            "2000000001": { allowFrom: [100] },
            "2000000002": { requireMention: true },
          },
        },
      }),
    );

    expect(result.groupOverrides).toEqual([
      { label: "2000000001", entries: ["100"] },
    ]);
  });
});

// ── applyVkAllowlistConfigEdit ──────────────────────────────────────────────

describe("applyVkAllowlistConfigEdit", () => {
  it("adds a DM allowFrom entry", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(true);
      expect(result.pathLabel).toBe("channels.vk.allowFrom");
    }
  });

  it("removes a DM allowFrom entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["123", "456"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "remove",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(true);
    }
  });

  it("returns unchanged when adding an existing entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["123"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(false);
    }
  });

  it("returns unchanged when removing a non-existent entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["456"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "remove",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(false);
    }
  });

  it("returns invalid-entry for empty entry", () => {
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig: {},
      scope: "dm",
      action: "add",
      entry: "   ",
    });
    expect(result.kind).toBe("invalid-entry");
  });

  it("uses group scope with groupAllowFrom path", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "group",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pathLabel).toBe("channels.vk.groupAllowFrom");
    }
  });

  it("targets account record when accountId is non-default", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      accountId: "sales",
      scope: "dm",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pathLabel).toBe("channels.vk.accounts.sales.allowFrom");
      expect(result.writeTarget).toEqual({
        kind: "account",
        scope: { channelId: "vk", accountId: "sales" },
      });
    }
  });

  it("targets default account when accounts map already exists", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: {
        vk: {
          accounts: {
            default: {
              allowFrom: ["111"],
            },
          },
        },
      },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "add",
      entry: "222",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pathLabel).toBe("channels.vk.accounts.default.allowFrom");
      expect(result.writeTarget).toEqual({
        kind: "account",
        scope: { channelId: "vk", accountId: "default" },
      });
      const vk = (parsedConfig as any).channels.vk;
      expect(vk.accounts.default.allowFrom).toEqual(["111", "222"]);
    }
  });

  it("deletes the key when removing the last entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["123"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "remove",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(true);
      const vk = (parsedConfig as any).channels.vk;
      expect(vk.allowFrom).toBeUndefined();
    }
  });
});

// ── resolveVkDirectoryPeers ─────────────────────────────────────────────────

describe("resolveVkDirectoryPeers", () => {
  it("returns user-range entries from allowFrom and defaultTo", () => {
    const result = resolveVkDirectoryPeers({
      account: makeAccount({
        config: { allowFrom: [100, 200], defaultTo: "300" },
      }),
    });
    expect(result).toEqual([
      { kind: "user", id: "100" },
      { kind: "user", id: "200" },
      { kind: "user", id: "300" },
    ]);
  });

  it("excludes group-range IDs", () => {
    const result = resolveVkDirectoryPeers({
      account: makeAccount({
        config: { allowFrom: [100, 2_000_000_001] },
      }),
    });
    expect(result).toEqual([{ kind: "user", id: "100" }]);
  });

  it("supports query filtering", () => {
    const result = resolveVkDirectoryPeers({
      account: makeAccount({ config: { allowFrom: [100, 200] } }),
      query: "20",
    });
    expect(result).toEqual([{ kind: "user", id: "200" }]);
  });
});

// ── resolveVkDirectoryGroups ────────────────────────────────────────────────

describe("resolveVkDirectoryGroups", () => {
  it("returns group-range entries from group keys and defaultTo", () => {
    const result = resolveVkDirectoryGroups({
      account: makeAccount({
        config: {
          groups: { "2000000001": { enabled: true }, "*": { requireMention: true } },
          defaultTo: "2000000002",
        },
      }),
    });
    expect(result).toEqual([
      { kind: "group", id: "2000000001" },
      { kind: "group", id: "2000000002" },
    ]);
  });

  it("excludes wildcard key and user-range IDs", () => {
    const result = resolveVkDirectoryGroups({
      account: makeAccount({
        config: {
          groups: { "*": {}, "123": {} },
        },
      }),
    });
    expect(result).toEqual([]);
  });
});

// ── Retry logic ─────────────────────────────────────────────────────────────

describe("retry logic", () => {
  it("retries on VK error code 6 (too many requests)", async () => {
    const error = Object.assign(new Error("Too many requests"), { code: 6 });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
  });

  it("uses the same random_id across retries for idempotent sends", async () => {
    const error = Object.assign(new Error("Too many requests"), { code: 6 });
    mockGetRandomId.mockReset().mockReturnValueOnce(1001).mockReturnValueOnce(1002);
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });

    expect(result.messageId).toBe("42");
    expect(mockGetRandomId).toHaveBeenCalledTimes(1);
    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
    expect(mockMessagesSend.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ random_id: 1001 }),
    );
    expect(mockMessagesSend.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ random_id: 1001 }),
    );
  });

  it("retries on timeout-like error messages", async () => {
    const error = new Error("Connection timed out");
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("does not retry on non-retryable errors", async () => {
    const error = new Error("Access denied");
    mockMessagesSend.mockRejectedValueOnce(error);

    await expect(sendMessageVk("123", "hello", { cfg })).rejects.toThrow("Access denied");
    expect(mockMessagesSend).toHaveBeenCalledTimes(1);
  });

  it("retries on VK error code 9 (flood control)", async () => {
    const error = Object.assign(new Error("Flood control"), { code: 9 });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on VK error code 10 (internal server error)", async () => {
    const error = Object.assign(new Error("Internal server error"), { code: 10 });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on ECONNRESET errors", async () => {
    const error = Object.assign(new Error("ECONNRESET"), { name: "Error" });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on error_code field (VK API style)", async () => {
    const error = { error_code: 6, message: "Too many requests per second" };
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on AbortError (connection dropped by VK upload server)", async () => {
    const error = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on Not Allowed (VK upload server rate-limit)", async () => {
    const error = new Error("Not Allowed");
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on Gateway Time-out (hyphenated timeout from VK proxy)", async () => {
    const error = new Error("Gateway Time-out");
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("gives up after max retry attempts", async () => {
    const error = Object.assign(new Error("rate limit"), { code: 6 });
    mockMessagesSend.mockRejectedValue(error);

    await expect(sendMessageVk("123", "hello", { cfg })).rejects.toThrow("rate limit");
    expect(mockMessagesSend).toHaveBeenCalledTimes(3);
  });
});
