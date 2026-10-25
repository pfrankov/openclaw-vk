import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try { require.resolve("openclaw/plugin-sdk/channel-inbound"); return true; }
  catch { return false; }
})();

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  markMessageReadVk: vi.fn().mockResolvedValue(undefined),
  sendTypingVk: vi.fn().mockResolvedValue(undefined),
}));

// Host startup belongs to suite collection, as in the other real-SDK tests,
// not to the timed message-dispatch assertion on a cold Node 22 runner.
const inbound = sdkInstalled ? await import("./inbound.js") : null;
const runtimeModule = sdkInstalled ? await import("./runtime.js") : null;
const helpers = sdkInstalled ? await import("./test-helpers.js") : null;

// Use the installed minimum/latest/beta SDK, not copies of its location helpers.
describe.skipIf(!sdkInstalled)("native location with the real OpenClaw SDK", () => {
  it("dispatches safe location text and structured coordinates while preserving control text", async () => {
    const { handleVkInbound } = inbound!;
    const { setVkRuntime } = runtimeModule!;
    const { makeVkRuntime, makeMessage, makeAccount, createVkRuntimeEnv } = helpers!;
    const runtime = makeVkRuntime();
    setVkRuntime(runtime);
    await handleVkInbound({
      message: makeMessage({ text: "/status", hasLocation: true }),
      loadLocation: async () => ({ latitude: 0, longitude: -180 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: { channels: { vk: { token: "tok", dmPolicy: "open" } } },
      runtime: createVkRuntimeEnv(),
    });
    const dispatch = vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mock.calls[0]?.[0];
    expect(dispatch?.ctx).toMatchObject({
      BodyForAgent: "/status\n📍 0.000000, -180.000000",
      RawBody: "/status", CommandBody: "/status", BodyForCommands: "/status",
      LocationLat: 0, LocationLon: -180, LocationSource: "pin", LocationIsLive: false,
    });
    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({ ctx: dispatch?.ctx }));
  });
});
