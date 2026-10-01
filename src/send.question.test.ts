import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendVkQuestionStatus, clearVkInstances, sendPayloadVk } from "./send.js";
import {
  clearVkQuestionDeliveries,
  findOpenVkQuestionDelivery,
  registerVkDraftQuestionHandoff,
  resetVkQuestionRuntimeForTest,
} from "./question.js";

/**
 * The send side of a question: the prompt goes out with its buttons, and the
 * core's `finalize` turns the message into "question + outcome" without them.
 * Only VK and the core's question runtime are replaced.
 */

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
  enqueueKeyedTask: async <T,>({ task }: { task: () => Promise<T> }) => await task(),
  parseStrictPositiveInteger: () => undefined,
}));
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactIdentifier: (value?: string) => `sha256:${String(value ?? "-").length}`,
  redactSensitiveText: (text: string) => text,
}));
vi.mock("openclaw/plugin-sdk/account-id", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

const TOKEN = "test-token";
const cfg = { channels: { vk: { token: TOKEN } } };

vi.mock("./runtime.js", () => {
  const runtime = {
    channel: { activity: { record: vi.fn() } },
    config: { current: () => cfg },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
  };
  return {
    getVkRuntime: () => runtime,
    tryGetVkRuntime: () => runtime,
    readVkRuntimeConfig: () => cfg,
  };
});

const vkApi = vi.hoisted(() => ({
  send: vi.fn(),
  edit: vi.fn(),
}));
vi.mock("vk-io", () => ({
  VK: vi.fn().mockImplementation(function () {
    return { api: { messages: { send: vkApi.send, edit: vkApi.edit }, groups: { getById: vi.fn() } } };
  }),
  getRandomId: () => 1,
}));

type Finalize = (statusLine: string) => Promise<void>;
const questionRuntime = vi.hoisted(() => ({
  registrations: [] as Array<{ questionId: string; deliveryId: string; finalize: Finalize }>,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: {
    registerChannelDelivery: (params: { questionId: string; deliveryId: string; finalize: Finalize }) => {
      questionRuntime.registrations.push(params);
    },
  },
}));

const QID = `ask_${"f".repeat(32)}`;
const PROMPT_TEXT =
  "Question for you:\n\nАпскейл\nКакой размер?\n1. Сохранить - как есть\n2. Увеличить ×2 - до 2048\n\n" +
  "Reply with the number, the option text, or your own answer.";

function questionPayload(text = PROMPT_TEXT) {
  return {
    text,
    presentationTextMode: "fallback",
    presentation: {
      blocks: [
        { type: "text", text: "Какой размер?" },
        {
          type: "buttons",
          buttons: [
            { label: "Сохранить", action: { type: "question", questionId: QID, optionValue: "Сохранить" } },
            { label: "Увеличить ×2", action: { type: "question", questionId: QID, optionValue: "Увеличить ×2" } },
            { label: "Other…", action: { type: "question", questionId: QID, intent: "custom-input" } },
          ],
        },
      ],
    },
    channelData: { askUser: { questionId: QID, optionValues: ["Сохранить", "Увеличить ×2"] } },
  };
}

let nextMessageId = 500;

beforeEach(() => {
  vkApi.send.mockReset().mockImplementation(async () => nextMessageId++);
  vkApi.edit.mockReset().mockResolvedValue(1);
  questionRuntime.registrations = [];
  resetVkQuestionRuntimeForTest();
  clearVkInstances();
});

afterEach(() => {
  clearVkQuestionDeliveries();
});

function sentKeyboard(callIndex: number) {
  const keyboard = vkApi.send.mock.calls[callIndex]?.[0]?.keyboard;
  return keyboard ? JSON.parse(keyboard) : undefined;
}

describe("sendPayloadVk — a question from the core", () => {
  it("sends the core's text with inline callback buttons and registers the message", async () => {
    const result = await sendPayloadVk("vk:7654321", questionPayload(), { cfg: cfg as never });

    expect(vkApi.send).toHaveBeenCalledTimes(1);
    const call = vkApi.send.mock.calls[0][0];
    expect(call.peer_id).toBe(7654321);
    expect(call.message).toContain("Апскейл");
    expect(call.message).toContain("2. Увеличить ×2 - до 2048");
    const keyboard = sentKeyboard(0);
    expect(keyboard.inline).toBe(true);
    expect(keyboard.buttons.map((row: Array<{ action: { label: string } }>) => row[0].action.label)).toEqual([
      "Сохранить",
      "Увеличить ×2",
      "✍️ Свой вариант",
    ]);
    expect(keyboard.buttons.every((row: Array<{ action: { type: string } }>) => row[0].action.type === "callback")).toBe(true);

    expect(result?.messageId).toBe(String(nextMessageId - 1));
    expect(questionRuntime.registrations).toHaveLength(1);
    expect(questionRuntime.registrations[0]).toMatchObject({
      questionId: QID,
      deliveryId: `vk:default:7654321:${result?.messageId}`,
    });
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 7654321 })).toEqual({
      accountId: "default",
      peerId: 7654321,
      messageId: Number(result?.messageId),
    });
  });

  it("offers no 'Свой вариант' in a group chat, where a typed answer is never taken", async () => {
    await sendPayloadVk("vk:2000000005", questionPayload(), { cfg: cfg as never });

    const keyboard = sentKeyboard(0);
    expect(keyboard.buttons.map((row: Array<{ action: { label: string } }>) => row[0].action.label)).toEqual([
      "Сохранить",
      "Увеличить ×2",
    ]);
    // Nor the core's closing line asking for a typed reply; the options stay.
    const message = vkApi.send.mock.calls[0][0].message;
    expect(message).toContain("2. Увеличить ×2 - до 2048");
    expect(message).not.toContain("Reply with");
    await questionRuntime.registrations[0].finalize("Answered: Сохранить");
    expect(vkApi.edit.mock.calls[0][0].message).not.toContain("Reply with");
  });

  it("keeps the core's closing line in a direct chat, and an unknown last paragraph in a group", async () => {
    await sendPayloadVk("vk:7654321", questionPayload(), { cfg: cfg as never });
    expect(vkApi.send.mock.calls[0][0].message).toContain("Reply with the number, the option text, or your own answer.");

    await sendPayloadVk("vk:2000000005", questionPayload("Какой размер?\n\nОтветьте, когда будете готовы."), {
      cfg: cfg as never,
    });
    expect(vkApi.send.mock.calls[1][0].message).toContain("Ответьте, когда будете готовы.");
  });

  it("moves this chat's step draft out of the way before the question goes out", async () => {
    const order: string[] = [];
    vkApi.send.mockImplementation(async () => {
      order.push("send");
      return nextMessageId++;
    });
    const unregister = registerVkDraftQuestionHandoff({ accountId: "default", peerId: 7654321 }, async () => {
      order.push("handoff");
    });
    try {
      await sendPayloadVk("vk:7654321", questionPayload(), { cfg: cfg as never });
      expect(order).toEqual(["handoff", "send"]);
      // An ordinary message does not touch the draft.
      await sendPayloadVk("vk:7654321", { text: "Готово" }, { cfg: cfg as never });
      expect(order).toEqual(["handoff", "send", "send"]);
    } finally {
      unregister();
    }
  });

  it("finalize edits the message: question text, outcome line, an empty keyboard", async () => {
    const result = await sendPayloadVk("7654321", questionPayload(), { cfg: cfg as never });
    await questionRuntime.registrations[0].finalize("Answered: Увеличить ×2");

    expect(vkApi.edit).toHaveBeenCalledTimes(1);
    const edit = vkApi.edit.mock.calls[0][0];
    expect(edit.peer_id).toBe(7654321);
    expect(edit.message_id).toBe(Number(result?.messageId));
    expect(edit.message.startsWith(vkApi.send.mock.calls[0][0].message)).toBe(true);
    expect(edit.message.endsWith("\n\n✅ Ответ: Увеличить ×2")).toBe(true);
    // The buttons are taken away explicitly: an empty inline keyboard.
    expect(JSON.parse(edit.keyboard)).toEqual({ inline: true, buttons: [] });
    // The question is closed for presses from now on.
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 7654321 })).toBeUndefined();
  });

  it("an expired question says so and loses its buttons", async () => {
    await sendPayloadVk("7654321", questionPayload(), { cfg: cfg as never });
    await questionRuntime.registrations[0].finalize("Expired");
    const edit = vkApi.edit.mock.calls[0][0];
    expect(edit.message.endsWith("\n\n⌛ Время на ответ вышло")).toBe(true);
    expect(JSON.parse(edit.keyboard)).toEqual({ inline: true, buttons: [] });
  });

  it("a cancelled question loses its buttons the same way", async () => {
    await sendPayloadVk("7654321", questionPayload(), { cfg: cfg as never });
    await questionRuntime.registrations[0].finalize("Cancelled");
    const edit = vkApi.edit.mock.calls[0][0];
    expect(JSON.parse(edit.keyboard)).toEqual({ inline: true, buttons: [] });
  });

  it("keeps the rich-text runs of the question when it adds the outcome", async () => {
    await sendPayloadVk("7654321", questionPayload("**Апскейл**\n\n1. Сохранить"), { cfg: cfg as never });
    const sentFormat = vkApi.send.mock.calls[0][0].format_data;
    expect(sentFormat).toBeDefined();
    await questionRuntime.registrations[0].finalize("Cancelled");
    expect(vkApi.edit.mock.calls[0][0].format_data).toBe(sentFormat);
  });

  it("a long prompt carries the keyboard on its last message, and that message is finalized", async () => {
    const long = `${"Очень длинный вопрос. ".repeat(260)}\n\n1. Да\n2. Нет`;
    await sendPayloadVk("7654321", questionPayload(long), { cfg: cfg as never });
    expect(vkApi.send.mock.calls.length).toBeGreaterThan(1);
    const last = vkApi.send.mock.calls.length - 1;
    for (let index = 0; index < last; index += 1) {
      expect(vkApi.send.mock.calls[index][0].keyboard).toBeUndefined();
    }
    expect(sentKeyboard(last).inline).toBe(true);
    await questionRuntime.registrations[0].finalize("Expired");
    expect(vkApi.edit.mock.calls[0][0].message_id).toBe(nextMessageId - 1);
  });

  it("a question without tappable options goes out as text, still finalized", async () => {
    await sendPayloadVk(
      "7654321",
      { text: "1. Имя?\n2. Цвет?", channelData: { askUser: { questionId: QID } } },
      { cfg: cfg as never },
    );
    expect(vkApi.send.mock.calls[0][0].keyboard).toBeUndefined();
    expect(questionRuntime.registrations).toHaveLength(1);
    // No buttons to take away: finalized with a plain edit, as before.
    await questionRuntime.registrations[0].finalize("Answered");
    expect(vkApi.edit.mock.calls[0][0]).not.toHaveProperty("keyboard");
  });

  it("on a core without the question runtime the prompt is plain text, as before", async () => {
    // A core older than 2026.9.6: the loader found no question runtime.
    resetVkQuestionRuntimeForTest({ runtime: undefined });
    const result = await sendPayloadVk("7654321", questionPayload(), { cfg: cfg as never });
    expect(result?.messageId).toBeTruthy();
    expect(vkApi.send.mock.calls[0][0].keyboard).toBeUndefined();
    expect(vkApi.send.mock.calls[0][0].message).toContain("Апскейл");
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 7654321 })).toBeUndefined();
  });

  it("does not register a message VK did not give an id for", async () => {
    vkApi.send.mockResolvedValueOnce(0);
    await sendPayloadVk("7654321", questionPayload(), { cfg: cfg as never });
    expect(questionRuntime.registrations).toHaveLength(0);
  });

  it("an ordinary payload never gets question buttons", async () => {
    await sendPayloadVk("7654321", { text: "Готово" }, { cfg: cfg as never });
    expect(vkApi.send.mock.calls[0][0].keyboard).toBeUndefined();
    expect(questionRuntime.registrations).toHaveLength(0);
  });
});

describe("appendVkQuestionStatus", () => {
  it("appends the outcome after a blank line and keeps the runs", () => {
    const formatData = { version: 1 as const, items: [{ type: "bold", offset: 0, length: 3 }] };
    expect(appendVkQuestionStatus({ text: "Как", formatData }, "✅ Ответ: Да")).toEqual({
      text: "Как\n\n✅ Ответ: Да",
      formatData,
    });
  });

  it("shortens a question that would not fit with the outcome, dropping runs past its end", () => {
    const text = "а".repeat(4096);
    const formatData = {
      version: 1 as const,
      items: [
        { type: "bold", offset: 0, length: 10 },
        { type: "italic", offset: 4090, length: 6 },
      ],
    };
    const status = "⌛ Время на ответ вышло";
    const result = appendVkQuestionStatus({ text, formatData }, status);
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.text.endsWith(`…\n\n${status}`)).toBe(true);
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: 10 }]);
  });

  it("carries no format data when no run survives", () => {
    expect(appendVkQuestionStatus({ text: "x" }, "y")).toEqual({ text: "x\n\ny" });
  });
});
