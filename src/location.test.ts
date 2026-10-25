import { describe, expect, it, vi } from "vitest";
import { resolveVkInboundLocation } from "./location.js";

const geo = { coordinates: { latitude: 55.75, longitude: 37.62 } };
function context(overrides: Record<string, unknown> = {}) {
  return { id: 42, peerId: 123, conversationMessageId: 7, hasGeo: false, geo: undefined,
    loadMessagePayload: vi.fn().mockResolvedValue(undefined), ...overrides };
}

describe("native VK location", () => {
  it("does not fetch ordinary messages", async () => {
    const ctx = context();
    expect(await resolveVkInboundLocation(ctx)).toBeUndefined();
    expect(ctx.loadMessagePayload).not.toHaveBeenCalled();
  });
  it("uses complete Bots Long Poll geo without fetching", async () => {
    const ctx = context({ hasGeo: true, geo });
    expect(await resolveVkInboundLocation(ctx)).toEqual({ latitude: 55.75, longitude: 37.62 });
    expect(ctx.loadMessagePayload).not.toHaveBeenCalled();
  });
  it.each([{ id: 42 }, { id: 0, peerId: 123, conversationMessageId: 7 }, { id: 0, peerId: -123, conversationMessageId: 7 }])(
    "hydrates a marker once using its existing exact identity: %j", async (identity) => {
      const ctx = context({ ...identity, hasGeo: true });
      ctx.loadMessagePayload.mockImplementation(async () => { ctx.geo = geo; });
      expect(await resolveVkInboundLocation(ctx)).toEqual({ latitude: 55.75, longitude: 37.62 });
      expect(ctx.loadMessagePayload).toHaveBeenCalledExactlyOnceWith();
    },
  );
  it.each([
    { id: 0, conversationMessageId: undefined }, { id: undefined }, { id: NaN },
    { id: 0, peerId: undefined }, { id: 0, peerId: 0 }, { id: 0, conversationMessageId: -1 },
  ])("does not fetch without usable exact identity: %j", async (identity) => {
    const ctx = context({ ...identity, hasGeo: true });
    expect(await resolveVkInboundLocation(ctx)).toBeUndefined();
    expect(ctx.loadMessagePayload).not.toHaveBeenCalled();
  });
  it("does not retry or surface an API error containing location data", async () => {
    const ctx = context({ hasGeo: true });
    ctx.loadMessagePayload.mockRejectedValue(new Error("private latitude=55.75"));
    expect(await resolveVkInboundLocation(ctx)).toBeUndefined();
    expect(ctx.loadMessagePayload).toHaveBeenCalledTimes(1);
  });
  it.each([
    null, {}, { coordinates: "37.62 55.75" },
    { coordinates: { latitude: NaN, longitude: 0 } },
    { coordinates: { latitude: 0, longitude: Infinity } },
    { coordinates: { latitude: 91, longitude: 0 } },
    { coordinates: { latitude: 0, longitude: -181 } },
    { coordinates: { latitude: "55.75", longitude: 37.62 } },
  ])("rejects malformed/unsupported geo: %j", async (value) => {
    expect(await resolveVkInboundLocation(context({ hasGeo: true, geo: value }))).toBeUndefined();
  });
  it.each([[0, 0], [-90, -180], [90, 180]])("accepts valid boundary %s, %s", async (latitude, longitude) => {
    expect(await resolveVkInboundLocation(context({ hasGeo: true, geo: { coordinates: { latitude, longitude } } })))
      .toEqual({ latitude, longitude });
  });
});

describe("vk-io transport contract", () => {
  it.each([42, 0])("hydrates a real User Long Poll marker with exact id %s", async (id) => {
    const { MessageContext, UpdateSource } = await import("vk-io");
    const hydrated = { id, peer_id: 123, conversation_message_id: 7, from_id: 123,
      date: 1_700_000_000, text: "", geo, attachments: [], fwd_messages: [] };
    const api = { messages: {
      getById: vi.fn().mockResolvedValue({ items: [hydrated] }),
      getByConversationMessageId: vi.fn().mockResolvedValue({ items: [hydrated] }),
      getHistory: vi.fn(),
    } };
    const ctx = new MessageContext({ api, upload: {}, source: UpdateSource.POLLING,
      updateType: 10004,
      payload: [10004, 7, 0, 0, 123, 1_700_000_000, "", {}, { geo: "1" }, 0, id],
    } as never);
    expect(ctx.hasGeo).toBe(true);
    expect(ctx.geo).toBeUndefined();
    expect(await resolveVkInboundLocation(ctx)).toEqual({ latitude: 55.75, longitude: 37.62 });
    if (id) {
      expect(api.messages.getById).toHaveBeenCalledExactlyOnceWith({ message_ids: 42 });
      expect(api.messages.getByConversationMessageId).not.toHaveBeenCalled();
    } else {
      expect(api.messages.getByConversationMessageId).toHaveBeenCalledExactlyOnceWith({ peer_id: 123, conversation_message_ids: 7 });
      expect(api.messages.getById).not.toHaveBeenCalled();
    }
    expect(api.messages.getHistory).not.toHaveBeenCalled();
  });
  it("reads a real Bots Long Poll message without hydration", async () => {
    const { MessageContext, UpdateSource } = await import("vk-io");
    const ctx = new MessageContext({ api: {}, upload: {}, source: UpdateSource.WEBHOOK,
      updateType: "message_new", payload: { message: { id: 42, peer_id: 123, from_id: 123, geo }, client_info: {} },
    } as never);
    const load = vi.spyOn(ctx, "loadMessagePayload");
    expect(await resolveVkInboundLocation(ctx)).toEqual({ latitude: 55.75, longitude: 37.62 });
    expect(load).not.toHaveBeenCalled();
  });
});
