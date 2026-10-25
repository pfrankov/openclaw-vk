import type { NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";

/** VK's documented geo coordinates are an object, not a longitude/latitude string. */
export function normalizeVkLocation(geo: unknown): NormalizedLocation | undefined {
  if (!geo || typeof geo !== "object" || !("coordinates" in geo)) return undefined;
  const coordinates = geo.coordinates;
  if (!coordinates || typeof coordinates !== "object") return undefined;
  const { latitude, longitude } = coordinates as Record<string, unknown>;
  if (
    typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
    typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180
  ) return undefined;
  return { latitude, longitude };
}

type LocationContext = {
  id: number;
  peerId: number;
  conversationMessageId?: number;
  hasGeo: boolean;
  geo?: unknown;
  loadMessagePayload(): Promise<void>;
};

export function canLoadVkLocation(context: LocationContext): boolean {
  // vk-io selects getById unless id is exactly zero. Never let an absent or
  // invalid global id accidentally select that branch instead of peer + CMID.
  return context.hasGeo && (
    (Number.isSafeInteger(context.id) && context.id > 0) ||
    (context.id === 0 && Number.isSafeInteger(context.peerId) && context.peerId !== 0 &&
      Number.isSafeInteger(context.conversationMessageId) && context.conversationMessageId! > 0)
  );
}

export async function resolveVkInboundLocation(context: LocationContext): Promise<NormalizedLocation | undefined> {
  const location = normalizeVkLocation(context.geo);
  if (location || !canLoadVkLocation(context)) return location;
  try {
    // Public vk-io API: exactly one identity-bound lookup, never chat history.
    await context.loadMessagePayload();
    return normalizeVkLocation(context.geo);
  } catch {
    // Errors may include the message or coordinates. Keep the original event
    // usable without logging the payload, guessing another message, or retrying.
    return undefined;
  }
}
