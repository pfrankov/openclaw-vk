import type { LookupAddress } from "node:dns";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercise the plugin's remote-media boundary through the host's real SSRF
 * guard. Only DNS and the HTTP transport are replaced: no test opens a socket.
 * Like the other SDK tests, this runs when the optional OpenClaw peer is present.
 */
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve("openclaw");
    return true;
  } catch {
    return false;
  }
})();

const network = vi.hoisted(() => ({
  lookup: vi.fn<(hostname: string, options: { all: true }) => Promise<LookupAddress[]>>(),
  transport: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  unguarded: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...sdk,
    fetchWithSsrFGuard: (params: Parameters<typeof sdk.fetchWithSsrFGuard>[0]) =>
      sdk.fetchWithSsrFGuard({
        ...params,
        // Supplying lookupFn also prevents the SDK's fetch-mock shortcut from
        // skipping DNS checks. Its policy and pinned dispatcher remain real.
        lookupFn: network.lookup,
        fetchImpl: network.transport,
      }),
  };
});

const uploads = vi.hoisted(() => ({
  photo: vi.fn(),
  document: vi.fn(),
  audio: vi.fn(),
  send: vi.fn(),
}));

vi.mock("vk-io", () => ({
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        groups: { getById: vi.fn(async () => ({ groups: [{ id: 1, name: "Test group" }] })) },
        docs: {
          getMessagesUploadServer: vi.fn(async () => ({
            upload_url: "https://upload.vk.example/audio",
          })),
        },
        messages: { send: uploads.send },
      },
      upload: {
        messagePhoto: uploads.photo,
        messageDocument: uploads.document,
        audioMessage: uploads.audio,
        upload: vi.fn(),
      },
    };
  }),
  getRandomId: () => 17,
}));

vi.mock("./audio-chunk.js", () => ({
  getVkAudioMessageMaxMs: () => 270_000,
  probeAudioDurationMs: vi.fn(async () => null),
  splitAudioAtSilence: vi.fn(async () => []),
  cleanupAudioSegments: vi.fn(async () => undefined),
  audioFileExtension: (path: string) => path.slice(path.lastIndexOf(".")) || ".ogg",
}));

const runtime = vi.hoisted(() => ({
  channel: { activity: { record: vi.fn() } },
  config: { current: () => ({}) },
  logging: {
    shouldLogVerbose: () => false,
    getChildLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("./runtime.js", () => ({
  getVkRuntime: () => runtime,
  tryGetVkRuntime: () => runtime,
  readVkRuntimeConfig: () => ({}),
}));

// Import the plugin only after Node confirms the peer exists. Catching the
// import itself would hide a broken SDK contract in the compatibility CI job.
const send: typeof import("./send.js") | null = sdkInstalled ? await import("./send.js") : null;

const PUBLIC_IP = "93.184.216.34";
const OTHER_PUBLIC_IP = "1.1.1.1";
const cfg = { channels: { vk: { token: "test-token" } } } as never;
const downloadedBytes = Buffer.from("bounded test media");

type UploadParams = {
  source: {
    value?: string | Buffer;
    values?: Array<{ value: string | Buffer }>;
  };
};

type UploadKind = "photo" | "document" | "audio";
type UploadSnapshot = { path: string; bytes: Buffer };
const uploadSnapshots: Record<UploadKind, UploadSnapshot[]> = {
  photo: [],
  document: [],
  audio: [],
};

async function snapshotUpload(kind: UploadKind, params: UploadParams): Promise<void> {
  const value = params.source.value ?? params.source.values?.[0]?.value;
  // Every remote source is streamed to disk. Snapshot it while the fake
  // upload owns its lifetime; a completed send must already have removed it.
  expect(value).toBeTypeOf("string");
  expect(value).not.toMatch(/^https?:\/\//i);
  const path = value as string;
  uploadSnapshots[kind].push({ path, bytes: await readFile(path) });
}

async function expectUploadCleaned(snapshot: UploadSnapshot | undefined): Promise<void> {
  expect(snapshot).toBeDefined();
  await expect(stat(snapshot!.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(dirname(snapshot!.path))).rejects.toMatchObject({ code: "ENOENT" });
}

type DispatchedRequest = RequestInit & { dispatcher?: object };
type SocketLookup = (
  hostname: string,
  options: { all: true },
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

function connectionLookup(dispatcher: object | undefined): SocketLookup {
  expect(dispatcher).toBeDefined();
  // Undici has no public connection-options getter. Inspect the options on
  // the actual dispatcher handed to the transport, without depending on a
  // private symbol's name, then exercise its installed lookup below.
  for (const key of Reflect.ownKeys(dispatcher!)) {
    const value = Reflect.get(dispatcher!, key) as { connect?: { lookup?: SocketLookup } } | null;
    if (typeof value?.connect?.lookup === "function") {
      return value.connect.lookup;
    }
  }
  throw new Error("The guarded transport has no pinned connection lookup");
}

function resolveConnection(lookup: SocketLookup, hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
      } else {
        resolve(addresses);
      }
    });
  });
}

function replyWithMedia(contentType: string): void {
  network.transport.mockResolvedValueOnce(
    new Response(downloadedBytes, {
      headers: { "content-type": contentType, "content-length": String(downloadedBytes.length) },
    }),
  );
}

function expectNoUpload(): void {
  expect(uploads.photo).not.toHaveBeenCalled();
  expect(uploads.document).not.toHaveBeenCalled();
  expect(uploads.audio).not.toHaveBeenCalled();
  expect(uploads.send).not.toHaveBeenCalled();
}

const senders = [
  {
    kind: "photo",
    mime: "image/jpeg",
    send: (url: string) => send!.sendPhotoVk("123", url, undefined, { cfg }),
  },
  {
    kind: "document",
    mime: "application/pdf",
    send: (url: string) => send!.sendDocumentVk("123", url, "report.pdf", undefined, { cfg }),
  },
  {
    kind: "audio",
    mime: "audio/ogg",
    send: (url: string) => send!.sendAudioMessageVk("123", url, "voice.ogg", undefined, { cfg }),
  },
] as const;

describe.skipIf(!send)("outbound media through the real SDK SSRF guard", () => {
  beforeEach(() => {
    send!.clearVkInstances();
    // The host's managed proxy intentionally owns DNS for proxied traffic.
    // These tests exercise the normal pinned-DNS path, with no proxy or sockets.
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    vi.stubEnv("VK_TOKEN", "");
    network.lookup.mockReset().mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
    network.transport.mockReset().mockRejectedValue(new Error("Unexpected guarded HTTP request"));
    network.unguarded.mockReset().mockRejectedValue(new Error("Unguarded HTTP request"));
    vi.stubGlobal("fetch", network.unguarded);
    for (const [kind, attachment] of [
      ["photo", "photo1_2"],
      ["document", "doc1_3"],
      ["audio", "audio_message1_4"],
    ] as const) {
      uploadSnapshots[kind] = [];
      uploads[kind].mockReset().mockImplementation(async (params: UploadParams) => {
        await snapshotUpload(kind, params);
        return attachment;
      });
    }
    uploads.send.mockReset().mockResolvedValue(42);
  });

  afterEach(() => {
    expect(network.unguarded).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const sender of senders) {
    describe(sender.kind, () => {
      it.each([
        "localhost",
        "127.0.0.1",
        "127.1",
        "2130706433",
        "0x7f000001",
        "0.0.0.0",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "100.64.0.1",
        "169.254.169.254",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "[fc00::1]",
        "[fe80::1]",
      ])("rejects %s before HTTP or upload", async (hostname) => {
        await expect(sender.send(`http://${hostname}/media`)).rejects.toThrow();
        expect(network.transport).not.toHaveBeenCalled();
        expectNoUpload();
      });

      it.each([
        [[{ address: "10.0.0.1", family: 4 }]],
        [[{ address: "::1", family: 6 }]],
        [[{ address: PUBLIC_IP, family: 4 }, { address: "192.168.1.1", family: 4 }]],
        [[{ address: PUBLIC_IP, family: 4 }, { address: "fe80::1", family: 6 }]],
      ])("rejects a DNS answer containing an internal address: %j", async (addresses) => {
        network.lookup.mockResolvedValue(addresses);
        await expect(sender.send("https://files.example.com/media")).rejects.toThrow();
        expect(network.lookup).toHaveBeenCalled();
        expect(network.transport).not.toHaveBeenCalled();
        expectNoUpload();
      });

      it.each(["http://169.254.169.254/latest/meta-data/", "file:///etc/passwd"])(
        "rejects a public redirect to %s before the second request",
        async (location) => {
          network.transport.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
          await expect(sender.send("https://files.example.com/media")).rejects.toThrow();
          expect(network.transport).toHaveBeenCalledOnce();
          expectNoUpload();
        },
      );

      it("rejects a redirect to a hostname whose DNS turns private", async () => {
        network.lookup
          .mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }])
          .mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
        network.transport.mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "https://redirect.example.com/media" } }),
        );
        await expect(sender.send("https://files.example.com/media")).rejects.toThrow();
        expect(network.lookup.mock.calls.map(([hostname]) => hostname)).toEqual([
          "files.example.com",
          "redirect.example.com",
        ]);
        expect(network.transport).toHaveBeenCalledOnce();
        expectNoUpload();
      });

      it("removes the downloaded file and its directory when upload fails", async () => {
        replyWithMedia(sender.mime);
        uploads[sender.kind].mockImplementationOnce(async (params: UploadParams) => {
          await snapshotUpload(sender.kind, params);
          throw Object.assign(new Error("Invalid media"), { code: 100 });
        });
        await expect(sender.send("https://files.example.com/media")).rejects.toThrow("Invalid media");
        expect(uploads[sender.kind]).toHaveBeenCalledOnce();
        expect(uploadSnapshots[sender.kind][0]?.bytes).toEqual(downloadedBytes);
        await expectUploadCleaned(uploadSnapshots[sender.kind][0]);
        expect(uploads.send).not.toHaveBeenCalled();
      });
    });
  }

  it("keeps the validated IP in the transport lookup after DNS changes", async () => {
    replyWithMedia("application/pdf");
    await send!.sendDocumentVk("123", "https://files.example.com/report.pdf", "report.pdf", undefined, { cfg });
    expect(network.lookup).toHaveBeenCalledOnce();
    const request = network.transport.mock.calls[0]?.[1] as DispatchedRequest;
    const pinnedLookup = connectionLookup(request.dispatcher);
    network.lookup.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);

    expect(await resolveConnection(pinnedLookup, "files.example.com")).toEqual([
      { address: PUBLIC_IP, family: 4 },
    ]);
    expect(network.lookup).toHaveBeenCalledOnce();
    expect(request.signal?.aborted).toBe(true);
    expect(uploadSnapshots.document[0]?.bytes).toEqual(downloadedBytes);
    await expectUploadCleaned(uploadSnapshots.document[0]);
  });

  it("follows a public redirect with a separate pinned transport and uploads its bytes", async () => {
    network.lookup
      .mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }])
      .mockResolvedValueOnce([{ address: OTHER_PUBLIC_IP, family: 4 }]);
    network.transport.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://cdn.example.com/photo.jpg" } }),
    );
    replyWithMedia("image/jpeg");
    await send!.sendPhotoVk("123", "https://files.example.com/photo.jpg", undefined, { cfg });

    expect(network.transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://files.example.com/photo.jpg",
      "https://cdn.example.com/photo.jpg",
    ]);
    for (const [index, [, init]] of network.transport.mock.calls.entries()) {
      const request = init as DispatchedRequest;
      expect(request.redirect).toBe("manual");
      const hostname = index === 0 ? "files.example.com" : "cdn.example.com";
      expect(await resolveConnection(connectionLookup(request.dispatcher), hostname)).toEqual([
        { address: index === 0 ? PUBLIC_IP : OTHER_PUBLIC_IP, family: 4 },
      ]);
      expect(request.signal?.aborted).toBe(true);
    }
    expect(uploadSnapshots.photo[0]?.bytes).toEqual(downloadedBytes);
    await expectUploadCleaned(uploadSnapshots.photo[0]);
    expect(uploads.send).toHaveBeenCalledOnce();
  });

  it("streams remote audio into the file uploaded by vk-io", async () => {
    replyWithMedia("audio/ogg");
    await send!.sendAudioMessageVk("123", "https://files.example.com/voice.ogg", "voice.ogg", undefined, { cfg });
    expect(uploadSnapshots.audio[0]?.bytes).toEqual(downloadedBytes);
    await expectUploadCleaned(uploadSnapshots.audio[0]);
    expect(network.transport).toHaveBeenCalledOnce();
    expect(uploads.audio).toHaveBeenCalledOnce();
  });

  it("guards the formatted-media metadata probe before upload", async () => {
    await expect(send!.sendFormattedMediaVk("123", "caption", "http://127.0.0.1/asset", { cfg })).rejects.toThrow();
    expect(network.transport).not.toHaveBeenCalled();
    expectNoUpload();
  });

  it("guards a metadata redirect whose destination resolves to a private IP", async () => {
    network.lookup.mockImplementation(async (hostname) => [
      { address: hostname === "files.example.com" ? PUBLIC_IP : "10.0.0.7", family: 4 },
    ]);
    network.transport.mockImplementation(async () =>
      new Response(null, { status: 302, headers: { location: "https://redirect.example.com/asset" } }),
    );
    await expect(send!.sendFormattedMediaVk("123", "caption", "https://files.example.com/asset", { cfg })).rejects.toThrow();
    expect(network.transport.mock.calls.every(([url]) => String(url) === "https://files.example.com/asset")).toBe(true);
    expect(network.transport).toHaveBeenCalled();
    expectNoUpload();
  });

  it("keeps one downloaded file through the document fallback and then removes it", async () => {
    replyWithMedia("image/jpeg");
    uploads.photo.mockImplementationOnce(async (params: UploadParams) => {
      await snapshotUpload("photo", params);
      throw Object.assign(new Error("Access denied"), { code: 15 });
    });
    await send!.sendFormattedMediaVk("123", "caption", "https://files.example.com/photo.jpg", { cfg });
    expect(network.transport).toHaveBeenCalledOnce();
    expect(uploadSnapshots.photo[0]?.bytes).toEqual(downloadedBytes);
    expect(uploadSnapshots.document[0]?.bytes).toEqual(downloadedBytes);
    expect(uploadSnapshots.document[0]?.path).toBe(uploadSnapshots.photo[0]?.path);
    await expectUploadCleaned(uploadSnapshots.photo[0]);
    expect(uploads.send).toHaveBeenCalledOnce();
  });
});
