import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";
import {
  extractVkInboundAttachments,
  formatVkInboundGeoText,
  loadVkOutboundMedia,
  resolveVkInboundBodyText,
  resolveVkInboundGeo,
  resolveVkInboundResolvedMedia,
  resolveVkInboundResolvedMediaPaths,
  resolveVkInboundResolvedMediaTypes,
  resolveVkInboundResolvedMediaUrls,
  resolveVkInboundMediaTypes,
  resolveVkInboundMediaUrls,
  resolveVkInboundReplyContext,
} from "./media.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

beforeEach(() => {
  mockFetch.mockReset().mockRejectedValue(new Error("unexpected fetch"));
});

// ── extractVkInboundAttachments ─────────────────────────────────────────────

describe("extractVkInboundAttachments", () => {
  it("returns empty array for non-array input", () => {
    expect(extractVkInboundAttachments(undefined)).toEqual([]);
    expect(extractVkInboundAttachments(null)).toEqual([]);
    expect(extractVkInboundAttachments("string")).toEqual([]);
  });

  it("extracts photo attachment with largeSizeUrl", () => {
    const result = extractVkInboundAttachments([
      { type: "photo", largeSizeUrl: "https://example.com/large.jpg" },
    ]);
    expect(result).toEqual([
      {
        type: "photo",
        kind: "image",
        url: "https://example.com/large.jpg",
        title: undefined,
        mimeType: "image/jpeg",
      },
    ]);
  });

  it("falls back to mediumSizeUrl then smallSizeUrl for photos", () => {
    const result = extractVkInboundAttachments([
      { type: "photo", mediumSizeUrl: "https://example.com/medium.jpg" },
    ]);
    expect(result[0].url).toBe("https://example.com/medium.jpg");

    const result2 = extractVkInboundAttachments([
      { type: "photo", smallSizeUrl: "https://example.com/small.jpg" },
    ]);
    expect(result2[0].url).toBe("https://example.com/small.jpg");
  });

  it("reads URL from sizes array for photos", () => {
    const result = extractVkInboundAttachments([
      {
        type: "photo",
        sizes: [
          { url: "https://example.com/s.jpg" },
          { url: "https://example.com/m.jpg" },
        ],
      },
    ]);
    // picks the last one from sizes
    expect(result[0].url).toBe("https://example.com/m.jpg");
  });

  it("extracts document attachment", () => {
    const result = extractVkInboundAttachments([
      { type: "doc", url: "https://example.com/file.pdf", title: "report.pdf" },
    ]);
    expect(result).toEqual([
      {
        type: "doc",
        kind: "document",
        url: "https://example.com/file.pdf",
        title: "report.pdf",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("marks document as image when isImage=true", () => {
    const result = extractVkInboundAttachments([
      { type: "doc", url: "https://example.com/img.png", isImage: true },
    ]);
    expect(result[0].kind).toBe("image");
  });

  it("extracts vk-io style image documents from preview.photo and infers mime type", () => {
    const attachment = {
      get type() {
        return "doc";
      },
      get isImage() {
        return true;
      },
      get ext() {
        return "heic";
      },
      get title() {
        return "IMG_0001.HEIC";
      },
      get preview() {
        return {
          photo: [
            { url: "https://example.com/preview-small" },
            { url: "https://example.com/preview-large" },
          ],
        };
      },
    };

    const result = extractVkInboundAttachments([attachment]);
    expect(result).toEqual([
      {
        type: "doc",
        kind: "image",
        url: "https://example.com/preview-large",
        title: "IMG_0001.HEIC",
        mimeType: "image/heic",
      },
    ]);
  });

  it("extracts audio_message attachment", () => {
    const result = extractVkInboundAttachments([
      { type: "audio_message", mp3Url: "https://example.com/voice.mp3" },
    ]);
    expect(result[0]).toEqual({
      type: "audio_message",
      kind: "audio",
      url: "https://example.com/voice.mp3",
      title: "voice-message",
      mimeType: "audio/mpeg",
    });
  });

  it("extracts audio attachment", () => {
    const result = extractVkInboundAttachments([
      { type: "audio", url: "https://example.com/track.mp3" },
    ]);
    expect(result[0].kind).toBe("audio");
  });

  it("extracts video attachment with player URL", () => {
    const result = extractVkInboundAttachments([
      { type: "video", player: "https://vk.com/video_ext.php?id=123" },
    ]);
    expect(result[0].kind).toBe("video");
    expect(result[0].url).toBe("https://vk.com/video_ext.php?id=123");
  });

  it("extracts sticker attachment from imagesWithBackground", () => {
    const result = extractVkInboundAttachments([
      {
        type: "sticker",
        imagesWithBackground: [{ url: "https://example.com/sticker.png" }],
      },
    ]);
    expect(result[0].kind).toBe("sticker");
    expect(result[0].url).toBe("https://example.com/sticker.png");
  });

  it("extracts graffiti attachment as image", () => {
    const result = extractVkInboundAttachments([
      { type: "graffiti", url: "https://example.com/graffiti.png" },
    ]);
    expect(result[0].kind).toBe("image");
  });

  it("extracts link attachment", () => {
    const result = extractVkInboundAttachments([
      { type: "link", url: "https://example.com", title: "Example" },
    ]);
    expect(result[0]).toEqual({
      type: "link",
      kind: "link",
      url: "https://example.com",
      title: "Example",
    });
  });

  it("handles unknown attachment type", () => {
    const result = extractVkInboundAttachments([
      { type: "wall", url: "https://example.com/wall" },
    ]);
    expect(result[0].kind).toBe("wall");
  });

  it("uses 'attachment' as fallback kind when type is empty", () => {
    const result = extractVkInboundAttachments([{ url: "https://example.com/x" }]);
    expect(result[0].type).toBe("attachment");
    expect(result[0].kind).toBe("attachment");
  });

  it("skips null/non-object entries in array", () => {
    const result = extractVkInboundAttachments([null, undefined, 42, "string", []]);
    expect(result).toEqual([]);
  });

  it("reads URL from sizes array using src field", () => {
    const result = extractVkInboundAttachments([
      {
        type: "photo",
        sizes: [{ src: "https://example.com/via-src.jpg" }],
      },
    ]);
    expect(result[0].url).toBe("https://example.com/via-src.jpg");
  });

  it("reads URL from sizes array using baseUrl field", () => {
    const result = extractVkInboundAttachments([
      {
        type: "photo",
        sizes: [{ baseUrl: "https://example.com/via-base.jpg" }],
      },
    ]);
    expect(result[0].url).toBe("https://example.com/via-base.jpg");
  });

  it("falls back to previewUrl for document attachment", () => {
    const result = extractVkInboundAttachments([
      { type: "doc", previewUrl: "https://example.com/preview.jpg" },
    ]);
    expect(result[0].url).toBe("https://example.com/preview.jpg");
  });

  it("falls back to oggUrl for audio_message attachment", () => {
    const result = extractVkInboundAttachments([
      { type: "audio_message", oggUrl: "https://example.com/voice.ogg" },
    ]);
    expect(result[0].url).toBe("https://example.com/voice.ogg");
  });

  it("falls back to images array for sticker when imagesWithBackground is absent", () => {
    const result = extractVkInboundAttachments([
      {
        type: "sticker",
        images: [{ url: "https://example.com/sticker-no-bg.png" }],
      },
    ]);
    expect(result[0].url).toBe("https://example.com/sticker-no-bg.png");
  });

  it("treats 'document' type the same as 'doc'", () => {
    const result = extractVkInboundAttachments([
      { type: "document", url: "https://example.com/file.zip", title: "archive.zip" },
    ]);
    expect(result[0].kind).toBe("document");
    expect(result[0].url).toBe("https://example.com/file.zip");
    expect(result[0].title).toBe("archive.zip");
  });

  it("resolves title from name, caption, and text fields", () => {
    const fromName = extractVkInboundAttachments([
      { type: "doc", url: "https://example.com/a", name: "report.pdf" },
    ]);
    expect(fromName[0].title).toBe("report.pdf");

    const fromCaption = extractVkInboundAttachments([
      { type: "photo", url: "https://example.com/b", caption: "sunset photo" },
    ]);
    expect(fromCaption[0].title).toBe("sunset photo");

    const fromText = extractVkInboundAttachments([
      { type: "link", url: "https://example.com/c", text: "link description" },
    ]);
    expect(fromText[0].title).toBe("link description");
  });

  it("extracts multiple attachments at once", () => {
    const result = extractVkInboundAttachments([
      { type: "photo", largeSizeUrl: "https://example.com/1.jpg" },
      { type: "doc", url: "https://example.com/file.pdf", title: "file.pdf" },
      { type: "audio_message", mp3Url: "https://example.com/voice.mp3" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].kind).toBe("image");
    expect(result[1].kind).toBe("document");
    expect(result[2].kind).toBe("audio");
  });
});

describe("resolveVkInboundGeo", () => {
  it("parses coordinates objects from VK geo payloads", () => {
    expect(
      resolveVkInboundGeo({
        coordinates: {
          latitude: 55.916704,
          longitude: 37.815848,
        },
        place: {
          title: "Королёв",
          city: "Россия",
        },
      }),
    ).toEqual({
      latitude: 55.916704,
      longitude: 37.815848,
      placeTitle: "Королёв",
      city: "Россия",
    });
  });

  it('parses string coordinates in VK "lon lat" format', () => {
    expect(
      resolveVkInboundGeo({
        coordinates: "37.815848 55.916704",
      }),
    ).toEqual({
      latitude: 55.916704,
      longitude: 37.815848,
      placeTitle: undefined,
      city: undefined,
    });
  });
});

describe("formatVkInboundGeoText", () => {
  it("renders geo text with place details", () => {
    expect(
      formatVkInboundGeoText({
        latitude: 55.916704,
        longitude: 37.815848,
        placeTitle: "Королёв",
        city: "Россия",
      }),
    ).toBe("[VK location] 55.916704, 37.815848 (Королёв, Россия)");
  });
});

describe("resolveVkInboundBodyText", () => {
  it("returns geo text when message contains only location", () => {
    expect(
      resolveVkInboundBodyText({
        geo: {
          latitude: 55.916704,
          longitude: 37.815848,
          placeTitle: "Королёв",
          city: "Россия",
        },
      }),
    ).toBe("[VK location] 55.916704, 37.815848 (Королёв, Россия)");
  });

  it("appends geo text below regular text", () => {
    expect(
      resolveVkInboundBodyText({
        text: "Проба",
        geo: {
          latitude: 55.916704,
          longitude: 37.815848,
        },
      }),
    ).toBe("Проба\n\n[VK location] 55.916704, 37.815848");
  });
});

// ── resolveVkInboundReplyContext ────────────────────────────────────────────

describe("resolveVkInboundReplyContext", () => {
  it("returns empty object for null/non-object input", () => {
    expect(resolveVkInboundReplyContext(null)).toEqual({});
    expect(resolveVkInboundReplyContext(undefined)).toEqual({});
    expect(resolveVkInboundReplyContext("string")).toEqual({});
    expect(resolveVkInboundReplyContext([])).toEqual({});
  });

  it("extracts id and text from reply message", () => {
    const result = resolveVkInboundReplyContext({ id: 77, text: "quoted" });
    expect(result).toEqual({
      replyToMessageId: "77",
      replyToText: "quoted",
    });
  });

  it("reads string id", () => {
    const result = resolveVkInboundReplyContext({ id: "99" });
    expect(result.replyToMessageId).toBe("99");
  });

  it("reads 'message' field as fallback for text", () => {
    const result = resolveVkInboundReplyContext({ id: 1, message: "alt text" });
    expect(result.replyToText).toBe("alt text");
  });
});

// ── resolveVkInboundMediaUrls ───────────────────────────────────────────────

describe("resolveVkInboundMediaUrls", () => {
  it("returns unique URLs from attachments", () => {
    const result = resolveVkInboundMediaUrls([
      { type: "photo", kind: "image", url: "https://a.com/1.jpg" },
      { type: "photo", kind: "image", url: "https://a.com/2.jpg" },
      { type: "photo", kind: "image", url: "https://a.com/1.jpg" },
    ]);
    expect(result).toEqual(["https://a.com/1.jpg", "https://a.com/2.jpg"]);
  });

  it("returns empty array for undefined input", () => {
    expect(resolveVkInboundMediaUrls(undefined)).toEqual([]);
  });

  it("filters out empty/undefined URLs", () => {
    const result = resolveVkInboundMediaUrls([
      { type: "doc", kind: "document" },
      { type: "photo", kind: "image", url: "" },
      { type: "photo", kind: "image", url: "https://a.com/ok.jpg" },
    ]);
    expect(result).toEqual(["https://a.com/ok.jpg"]);
  });
});

// ── resolveVkInboundMediaTypes ──────────────────────────────────────────────

describe("resolveVkInboundMediaTypes", () => {
  it("returns unique kinds from attachments", () => {
    const result = resolveVkInboundMediaTypes([
      { type: "photo", kind: "image" },
      { type: "doc", kind: "document" },
      { type: "photo", kind: "image" },
    ]);
    expect(result).toEqual(["image", "document"]);
  });

  it("falls back to type when kind is empty", () => {
    const result = resolveVkInboundMediaTypes([
      { type: "wall", kind: "" },
    ]);
    expect(result).toEqual(["wall"]);
  });

  it("prefers mime types over generic kinds when available", () => {
    const result = resolveVkInboundMediaTypes([
      { type: "doc", kind: "image", mimeType: "image/heic" },
      { type: "photo", kind: "image", mimeType: "image/jpeg" },
    ]);
    expect(result).toEqual(["image/heic", "image/jpeg"]);
  });

  it("returns empty array for undefined", () => {
    expect(resolveVkInboundMediaTypes(undefined)).toEqual([]);
  });
});

describe("resolveVkInboundResolvedMedia", () => {
  it("downloads inbound attachments into local media paths", async () => {
    const fetchRemoteMedia = vi.fn().mockResolvedValue({
      buffer: Buffer.from("heic-image"),
      contentType: "image/heic",
    });
    const saveMediaBuffer = vi.fn().mockResolvedValue({
      path: "/tmp/openclaw/media/inbound/photo.heic",
      contentType: "image/heic",
    });

    const result = await resolveVkInboundResolvedMedia({
      attachments: [
        {
          type: "doc",
          kind: "image",
          url: "https://example.com/phone-photo",
          title: "IMG_0001.HEIC",
          mimeType: "image/heic",
        },
      ],
      mediaRuntime: { fetchRemoteMedia, saveMediaBuffer },
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://example.com/phone-photo",
      filePathHint: "IMG_0001.HEIC",
      maxBytes: 20 * 1024 * 1024,
    });
    const saveCall = saveMediaBuffer.mock.calls[0] as
      | [Buffer, string, string, number, string]
      | undefined;
    expect(saveCall).toBeDefined();
    expect(saveCall![0]).toEqual(Buffer.from("heic-image"));
    expect(saveCall![1]).toBe("image/heic");
    expect(saveCall![2]).toBe("inbound");
    expect(saveCall![3]).toBe(20 * 1024 * 1024);
    expect(saveCall![4]).toBe("IMG_0001.HEIC");
    expect(resolveVkInboundResolvedMediaPaths(result)).toEqual([
      "/tmp/openclaw/media/inbound/photo.heic",
    ]);
    expect(resolveVkInboundResolvedMediaUrls(result)).toEqual([
      "https://example.com/phone-photo",
    ]);
    expect(resolveVkInboundResolvedMediaTypes(result)).toEqual(["image/heic"]);
  });

  it("falls back to url-only media when download fails", async () => {
    const fetchRemoteMedia = vi.fn().mockRejectedValue(new Error("blocked by ssrf guard"));
    const saveMediaBuffer = vi.fn();
    const logError = vi.fn();

    const result = await resolveVkInboundResolvedMedia({
      attachments: [
        {
          type: "photo",
          kind: "image",
          url: "https://example.com/photo.jpg",
          mimeType: "image/jpeg",
        },
      ],
      mediaRuntime: { fetchRemoteMedia, saveMediaBuffer },
      logError,
    });

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(resolveVkInboundResolvedMediaPaths(result)).toEqual([]);
    expect(resolveVkInboundResolvedMediaUrls(result)).toEqual([]);
    expect(resolveVkInboundResolvedMediaTypes(result)).toEqual([]);
    expect(result).toEqual([
      {
        url: "https://example.com/photo.jpg",
        contentType: "image/jpeg",
        attachment: {
          type: "photo",
          kind: "image",
          url: "https://example.com/photo.jpg",
          mimeType: "image/jpeg",
        },
      },
    ]);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("vk: inbound media download failed for https://example.com/photo.jpg"),
    );
  });
});

// ── resolveVkInboundBodyText ────────────────────────────────────────────────

describe("resolveVkInboundBodyText", () => {
  it("returns trimmed text when present", () => {
    expect(resolveVkInboundBodyText({ text: "  hello  " })).toBe("hello");
  });

  it("returns media placeholder for attachment-only messages", () => {
    expect(
      resolveVkInboundBodyText({
        text: "",
        attachments: [{ type: "photo", kind: "image", url: "https://a.com/1.jpg" }],
      }),
    ).toBe("<media:image>");
  });

  it("returns empty string when no text and no attachments", () => {
    expect(resolveVkInboundBodyText({ text: "" })).toBe("");
    expect(resolveVkInboundBodyText({ text: null })).toBe("");
  });

  it("prefers text over attachment placeholder", () => {
    expect(
      resolveVkInboundBodyText({
        text: "caption",
        attachments: [{ type: "photo", kind: "image" }],
      }),
    ).toBe("caption");
  });
});

// ── loadVkOutboundMedia ─────────────────────────────────────────────────────

describe("loadVkOutboundMedia", () => {
  it("throws for empty media URL", async () => {
    await expect(loadVkOutboundMedia({ mediaUrl: "" })).rejects.toThrow("Missing media URL");
    await expect(loadVkOutboundMedia({ mediaUrl: "   " })).rejects.toThrow("Missing media URL");
  });

  it("resolves HTTP URL as image based on extension", async () => {
    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/photo.png",
    });
    expect(result.kind).toBe("image");
    expect(result.source).toBe("https://example.com/photo.png");
    expect(result.title).toBe("photo.png");
  });

  it("resolves HTTP URL as document for non-image extensions", async () => {
    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/report.pdf",
    });
    expect(result.kind).toBe("document");
    expect(result.title).toBe("report.pdf");
  });

  it("uses filename query hints for HTTP URLs without a pathname extension", async () => {
    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/download?id=42&filename=report.pdf",
    });
    expect(result.kind).toBe("document");
    expect(result.title).toBe("report.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("recovers the real file name from remote headers for extensionless HTTP URLs", async () => {
    const cancel = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? "application/pdf"
            : name.toLowerCase() === "content-disposition"
              ? 'attachment; filename="monthly-report.pdf"'
              : null,
      },
      body: { cancel },
    } as unknown as Response);

    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/download/42",
    });

    expect(result.kind).toBe("document");
    expect(result.title).toBe("monthly-report.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/download/42",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(cancel).toHaveBeenCalled();
  });

  it("uses remote content-type to classify extensionless HTTP images", async () => {
    const cancel = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "image/png" : null),
      },
      body: { cancel },
    } as unknown as Response);

    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/render/42",
    });

    expect(result.kind).toBe("image");
    expect(result.title).toBe("42.png");
    expect(result.mimeType).toBe("image/png");
  });

  it("resolves HTTP audio URL as audio_message", async () => {
    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/voice.mp3",
    });
    expect(result.kind).toBe("audio_message");
    expect(result.title).toBe("voice.mp3");
  });

  it("forces document kind when forceDocument=true", async () => {
    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/photo.png",
      forceDocument: true,
    });
    expect(result.kind).toBe("document");
  });

  it("decodes base64 data URL as image", async () => {
    const pngPixel = "data:image/png;base64,iVBORw0KGgo=";
    const result = await loadVkOutboundMedia({ mediaUrl: pngPixel });
    expect(result.kind).toBe("image");
    expect(result.source).toBeInstanceOf(Buffer);
    expect(result.title).toBe("attachment.png");
  });

  it("decodes plain text data URL", async () => {
    const textData = "data:text/plain,hello%20world";
    const result = await loadVkOutboundMedia({ mediaUrl: textData });
    expect(result.kind).toBe("document");
    expect(result.source).toBeInstanceOf(Buffer);
    expect(result.title).toBe("attachment.txt");
    expect((result.source as Buffer).toString()).toBe("hello world");
  });

  it("decodes PDF data URL with document extension", async () => {
    const result = await loadVkOutboundMedia({ mediaUrl: "data:application/pdf;base64,JVBERi0x" });
    expect(result.kind).toBe("document");
    expect(result.title).toBe("attachment.pdf");
    expect(result.mimeType).toBe("application/pdf");
  });

  it("decodes audio data URL as audio_message", async () => {
    const result = await loadVkOutboundMedia({ mediaUrl: "data:audio/mpeg;base64,SGVsbG8=" });
    expect(result.kind).toBe("audio_message");
    expect(result.title).toBe("attachment.mp3");
    expect(result.source).toBeInstanceOf(Buffer);
  });

  it("decodes AAC/FLAC/MP4 audio data URLs with stable file extensions", async () => {
    const aac = await loadVkOutboundMedia({ mediaUrl: "data:audio/aac;base64,SGVsbG8=" });
    const flac = await loadVkOutboundMedia({ mediaUrl: "data:audio/flac;base64,SGVsbG8=" });
    const m4a = await loadVkOutboundMedia({ mediaUrl: "data:audio/mp4;base64,SGVsbG8=" });

    expect(aac.title).toBe("attachment.aac");
    expect(flac.title).toBe("attachment.flac");
    expect(m4a.title).toBe("attachment.m4a");
  });

  it("classifies GIF as document, not image", async () => {
    const gifData = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    const result = await loadVkOutboundMedia({ mediaUrl: gifData });
    expect(result.kind).toBe("document");
  });

  it("classifies .gif HTTP URL as document", async () => {
    const result = await loadVkOutboundMedia({
      mediaUrl: "https://example.com/animation.gif",
    });
    expect(result.kind).toBe("document");
  });

  it("classifies JPEG data URL as image", async () => {
    const jpegData = "data:image/jpeg;base64,/9j/4AAQ";
    const result = await loadVkOutboundMedia({ mediaUrl: jpegData });
    expect(result.kind).toBe("image");
    expect(result.title).toBe("attachment.jpg");
  });

  it("classifies WebP data URL as image", async () => {
    const webpData = "data:image/webp;base64,UklGR";
    const result = await loadVkOutboundMedia({ mediaUrl: webpData });
    expect(result.kind).toBe("image");
    expect(result.title).toBe("attachment.webp");
  });

  it("throws for invalid data URL format", async () => {
    await expect(
      loadVkOutboundMedia({ mediaUrl: "data:" }),
    ).rejects.toThrow("Invalid data URL");
  });

  describe("local files", () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "vk-media-test-"));
      await writeFile(join(tempDir, "test.png"), Buffer.from("fake-png"));
      await writeFile(join(tempDir, "doc.pdf"), Buffer.from("fake-pdf"));
      await writeFile(join(tempDir, "voice.mp3"), Buffer.from("fake-mp3"));
      await writeFile(join(tempDir, "artifact"), Buffer.from("fake-text"));
    });

    afterAll(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("reads local image file", async () => {
      const result = await loadVkOutboundMedia({
        mediaUrl: join(tempDir, "test.png"),
      });
      expect(result.kind).toBe("image");
      expect(result.source).toBeInstanceOf(Buffer);
      expect(result.title).toBe("test.png");
    });

    it("reads local document file", async () => {
      const result = await loadVkOutboundMedia({
        mediaUrl: join(tempDir, "doc.pdf"),
      });
      expect(result.kind).toBe("document");
      expect(result.title).toBe("doc.pdf");
    });

    it("uses preferred file name to classify and title extensionless local files", async () => {
      const result = await loadVkOutboundMedia({
        mediaUrl: join(tempDir, "artifact"),
        preferredName: "test-small.txt",
      });
      expect(result.kind).toBe("document");
      expect(result.title).toBe("test-small.txt");
    });

    it("reads local audio file as audio_message", async () => {
      const result = await loadVkOutboundMedia({
        mediaUrl: join(tempDir, "voice.mp3"),
      });
      expect(result.kind).toBe("audio_message");
      expect(result.title).toBe("voice.mp3");
    });

    it("rejects local path outside allowed roots", async () => {
      await expect(
        loadVkOutboundMedia({
          mediaUrl: join(tempDir, "test.png"),
          mediaLocalRoots: ["/nonexistent/root"],
        }),
      ).rejects.toThrow("outside allowed roots");
    });

    it("allows local path within allowed roots", async () => {
      const result = await loadVkOutboundMedia({
        mediaUrl: join(tempDir, "test.png"),
        mediaLocalRoots: [tempDir],
      });
      expect(result.kind).toBe("image");
    });

    it("resolves relative local paths against allowed roots before cwd", async () => {
      const cwd = process.cwd();
      const otherDir = await mkdtemp(join(tmpdir(), "vk-media-cwd-"));
      try {
        process.chdir(otherDir);
        const result = await loadVkOutboundMedia({
          mediaUrl: "./test.png",
          mediaLocalRoots: [tempDir],
        });
        expect(result.kind).toBe("image");
        expect(result.title).toBe("test.png");
      } finally {
        process.chdir(cwd);
        await rm(otherDir, { recursive: true, force: true });
      }
    });

    it("resolves relative local paths against cwd when roots are omitted", async () => {
      const cwd = process.cwd();
      try {
        process.chdir(tempDir);
        const result = await loadVkOutboundMedia({ mediaUrl: "test.png" });
        expect(result.kind).toBe("image");
        expect(result.title).toBe("test.png");
      } finally {
        process.chdir(cwd);
      }
    });

    it("ignores blank and non-resolvable roots when an allowed root exists", async () => {
      const result = await loadVkOutboundMedia({
        mediaUrl: join(tempDir, "test.png"),
        mediaLocalRoots: ["", "/definitely/missing/root", tempDir],
      });
      expect(result.kind).toBe("image");
    });

    it("throws for non-existent file", async () => {
      await expect(
        loadVkOutboundMedia({ mediaUrl: join(tempDir, "missing.png") }),
      ).rejects.toThrow();
    });
  });
});
