import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadVkOutboundMedia } from "./media.js";

/**
 * The local-file boundary before the filesystem: a reply-supplied path that
 * names another machine must be refused without any fs call, because on
 * Windows even `realpath` on a UNC path opens an SMB connection.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath), readFile: vi.fn(actual.readFile) };
});

vi.mock("openclaw/plugin-sdk/core", async () => ({
  formatZonedTimestamp: (await import("./test-helpers.js")).formatZonedTimestampLikeCore,
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactIdentifier: (value?: string) => `sha256:${String(value ?? "-").length}`,
  redactSensitiveText: (text: string) => text,
}));

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: () => ({
    setRuntime: () => {},
    getRuntime: () => {
      throw new Error("no runtime");
    },
    tryGetRuntime: () => null,
  }),
}));

const realpathSpy = vi.mocked(fsPromises.realpath);
const readFileSpy = vi.mocked(fsPromises.readFile);

let base: string;
let root: string;
let outsideFile: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "vk-local-paths-"));
  root = join(base, "workspace");
  await mkdir(root);
  await writeFile(join(root, "test.png"), "fake-png");
  outsideFile = join(base, "outside", "secret.txt");
  await mkdir(join(base, "outside"));
  await writeFile(outsideFile, "private fixture");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  realpathSpy.mockClear();
  readFileSpy.mockClear();
});

describe("loadVkOutboundMedia network paths", () => {
  it.each([
    "\\\\attacker\\share\\x.png",
    "//attacker/share/x.png",
    "\\/attacker/share/x.png",
    "\\\\?\\UNC\\attacker\\share\\x.png",
    "\\\\?\\C:\\Users\\x.png",
    "\\\\.\\pipe\\x",
    "//./pipe/x",
    "file://attacker/share/x.png",
    "file://ATTACKER.example/x.png",
    "FILE://attacker/share/x.png",
    "file:////attacker/share/x.png",
    "file://///attacker/share/x.png",
  ])("refuses %s without touching the filesystem", async (mediaUrl) => {
    await expect(loadVkOutboundMedia({ mediaUrl, mediaLocalRoots: [root] })).rejects.toThrow(
      "must not use a network location",
    );
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it.each(["file:///%2F%2Fattacker/share/x.png", "file:///tmp%5C..%5Cx.png"])(
    "refuses a file URL with encoded separators: %s",
    async (mediaUrl) => {
      await expect(loadVkOutboundMedia({ mediaUrl, mediaLocalRoots: [root] })).rejects.toThrow(
        "must not encode path separators",
      );
      expect(realpathSpy).not.toHaveBeenCalled();
      expect(readFileSpy).not.toHaveBeenCalled();
    },
  );

  it("never resolves a network-style root", async () => {
    await expect(
      loadVkOutboundMedia({
        mediaUrl: join(root, "test.png"),
        mediaLocalRoots: ["\\\\attacker\\share", "//attacker/share"],
      }),
    ).rejects.toThrow("outside allowed roots");
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["file:///", (path: string) => pathToFileURL(path).href],
    ["file://localhost/", (path: string) => pathToFileURL(path).href.replace("file://", "file://localhost")],
  ])("still loads a local file through %s", async (_label, toUrl) => {
    const result = await loadVkOutboundMedia({
      mediaUrl: toUrl(join(root, "test.png")),
      mediaLocalRoots: [root],
    });
    expect(result.source).toEqual(Buffer.from("fake-png"));
  });
});

describe("loadVkOutboundMedia lexical pre-check", () => {
  const inputCalls = () =>
    realpathSpy.mock.calls.map(([path]) => String(path)).filter((path) => path !== root);

  it.each([
    ["an absolute path outside every root", () => outsideFile],
    ["a file URL outside every root", () => pathToFileURL(outsideFile).href],
    ["a relative path climbing out of the root", () => "../outside/secret.txt"],
    ["a sibling sharing the root's prefix", () => `${root}-other/secret.txt`],
  ])("refuses %s before realpath sees it", async (_label, input) => {
    await expect(loadVkOutboundMedia({ mediaUrl: input(), mediaLocalRoots: [root] })).rejects.toThrow(
      "outside allowed roots",
    );
    // Only the configured root is canonicalized; the outside path is never probed.
    expect(inputCalls()).toEqual([]);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("refuses an outside path the same way whether or not it exists", async () => {
    const errors = await Promise.all(
      [outsideFile, join(base, "outside", "missing.txt")].map((mediaUrl) =>
        loadVkOutboundMedia({ mediaUrl, mediaLocalRoots: [root] }).catch((error: Error) => error.message),
      ),
    );
    expect(errors.map((message) => String(message).replace(/: .*$/, ""))).toEqual([
      "Local media path is outside allowed roots",
      "Local media path is outside allowed roots",
    ]);
  });

  it("keeps loading a relative path that stays inside the root", async () => {
    const result = await loadVkOutboundMedia({ mediaUrl: "./sub/../test.png", mediaLocalRoots: [root] });
    expect(result.source).toEqual(Buffer.from("fake-png"));
  });
});
