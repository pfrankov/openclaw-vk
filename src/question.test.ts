import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVkQuestionKeyboard,
  clearVkQuestionDeliveries,
  findOpenVkQuestionDelivery,
  findOpenVkQuestionForChat,
  formatVkQuestionStatusLine,
  handOffVkDraftsBeforeQuestion,
  loadVkQuestionRuntime,
  markVkQuestionNotTextAnswerable,
  markVkQuestionTerminal,
  normalizeVkQuestionPayload,
  parseVkQuestionCallback,
  parseVkQuestionTextAnswer,
  readVkAskUserQuestionId,
  readVkQuestionPrompt,
  registerVkDraftQuestionHandoff,
  rememberVkQuestionDelivery,
  resetVkQuestionRuntimeForTest,
  VK_QUESTION_CHANNEL_DATA_KEY,
  withoutVkQuestionReplyGuidance,
} from "./question.js";

vi.mock("./diagnostics.js", () => ({ vkDiag: vi.fn() }));

const QID = `ask_${"a".repeat(32)}`;

/** The payload the core builds for one tappable question (user-input-bridge.ts). */
function corePrompt(overrides: { isOther?: boolean; optionValues?: string[] | null } = {}) {
  const labels = ["Сохранить", "Увеличить ×2", "Увеличить ×4"];
  const optionValues = overrides.optionValues === null ? undefined : (overrides.optionValues ?? labels);
  return {
    text:
      "Question for you:\n\nАпскейл\nКакой размер?\n1. Сохранить - как есть\n2. Увеличить ×2 - 2048\n3. Увеличить ×4 - 4096" +
      "\n\nReply with the number or option text.",
    presentationTextMode: "fallback" as const,
    presentation: {
      blocks: [
        { type: "text", text: "Какой размер?" },
        { type: "text", text: "- Сохранить: как есть" },
        {
          type: "buttons",
          buttons: [
            { label: "Open link", action: { type: "url", url: "https://example.com" } },
            ...labels.map((label) => ({
              label,
              action: { type: "question", questionId: QID, optionValue: label },
            })),
            ...(overrides.isOther
              ? [{ label: "Other…", action: { type: "question", questionId: QID, intent: "custom-input" } }]
              : []),
          ],
        },
      ],
    },
    channelData: { askUser: { questionId: QID, ...(optionValues ? { optionValues } : {}) } },
  };
}

afterEach(() => {
  clearVkQuestionDeliveries();
  resetVkQuestionRuntimeForTest();
  vi.doUnmock("openclaw/plugin-sdk/question-gateway-runtime");
});

describe("readVkAskUserQuestionId", () => {
  it("reads a well-formed Gateway question id", () => {
    expect(readVkAskUserQuestionId(corePrompt())).toBe(QID);
  });

  it("ignores payloads that are not questions or carry a malformed id", () => {
    expect(readVkAskUserQuestionId({ text: "hi" })).toBeUndefined();
    expect(readVkAskUserQuestionId({ channelData: { askUser: { questionId: "ask_1" } } })).toBeUndefined();
    expect(readVkAskUserQuestionId({ channelData: { askUser: [QID] } })).toBeUndefined();
    expect(readVkAskUserQuestionId(null)).toBeUndefined();
  });
});

describe("readVkQuestionPrompt", () => {
  it("takes the option buttons from the presentation, skipping the link button", () => {
    expect(readVkQuestionPrompt(corePrompt({ isOther: true }))).toEqual({
      questionId: QID,
      options: ["Сохранить", "Увеличить ×2", "Увеличить ×4"],
      customInput: true,
    });
  });

  it("follows the Gateway option order when the presentation was reordered", () => {
    const payload = corePrompt({ optionValues: ["Увеличить ×4", "Сохранить", "Увеличить ×2"] });
    expect(readVkQuestionPrompt(payload)?.options).toEqual(["Увеличить ×4", "Сохранить", "Увеличить ×2"]);
  });

  it("keeps the presentation order when the Gateway order does not describe the same options", () => {
    const payload = corePrompt({ optionValues: ["Что-то другое", "Сохранить", "Увеличить ×2"] });
    expect(readVkQuestionPrompt(payload)?.options).toEqual(["Сохранить", "Увеличить ×2", "Увеличить ×4"]);
    expect(readVkQuestionPrompt(corePrompt({ optionValues: null }))?.options).toHaveLength(3);
  });

  it("reads the buttons normalizePayload left in channelData", () => {
    const normalized = normalizeVkQuestionPayload(corePrompt({ isOther: true }) as never);
    expect(readVkQuestionPrompt(normalized)).toEqual({
      questionId: QID,
      options: ["Сохранить", "Увеличить ×2", "Увеличить ×4"],
      customInput: true,
    });
  });

  it("returns a text-only question when nothing can be tapped (several questions, multi-select)", () => {
    const textOnly = { text: "1. Имя\n2. Цвет", channelData: { askUser: { questionId: QID } } };
    expect(readVkQuestionPrompt(textOnly)).toEqual({ questionId: QID, options: [], customInput: false });
  });

  it("gives up on buttons when there are more options than VK can show", () => {
    const labels = Array.from({ length: 10 }, (_, i) => `Вариант ${i}`);
    const payload = {
      channelData: { askUser: { questionId: QID }, [VK_QUESTION_CHANNEL_DATA_KEY]: { options: labels } },
    };
    expect(readVkQuestionPrompt(payload)?.options).toEqual([]);
  });

  it("ignores two button blocks and buttons of another question", () => {
    const payload = corePrompt();
    const twoBlocks = {
      ...payload,
      presentation: { blocks: [...payload.presentation.blocks, payload.presentation.blocks[2]] },
    };
    expect(readVkQuestionPrompt(twoBlocks)?.options).toEqual([]);
    const foreign = {
      ...payload,
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "X", action: { type: "question", questionId: `ask_${"b".repeat(32)}`, optionValue: "X" } }],
          },
        ],
      },
    };
    expect(readVkQuestionPrompt(foreign)?.options).toEqual([]);
  });

  it("is undefined for an ordinary reply", () => {
    expect(readVkQuestionPrompt({ text: "Готово" })).toBeUndefined();
  });
});

describe("normalizeVkQuestionPayload", () => {
  it("keeps the core's whole text and moves the buttons into channelData", () => {
    const payload = corePrompt({ isOther: true });
    const normalized = normalizeVkQuestionPayload(payload as never);
    expect(normalized.text).toBe(payload.text);
    expect(normalized.presentation).toBeUndefined();
    expect(normalized.presentationTextMode).toBeUndefined();
    expect(normalized.channelData).toEqual({
      askUser: payload.channelData.askUser,
      [VK_QUESTION_CHANNEL_DATA_KEY]: {
        options: ["Сохранить", "Увеличить ×2", "Увеличить ×4"],
        customInput: true,
      },
    });
  });

  it("is idempotent — the core may normalize the same payload twice", () => {
    const once = normalizeVkQuestionPayload(corePrompt() as never);
    expect(normalizeVkQuestionPayload(once)).toBe(once);
  });

  it("leaves ordinary payloads and non-fallback text alone", () => {
    const ordinary = { text: "hi", presentation: { blocks: [] } };
    expect(normalizeVkQuestionPayload(ordinary as never)).toBe(ordinary);
    const authored = { ...corePrompt(), presentationTextMode: undefined };
    expect(normalizeVkQuestionPayload(authored as never)).toBe(authored);
    const noText = { ...corePrompt(), text: "  " };
    expect(normalizeVkQuestionPayload(noText as never)).toBe(noText);
  });

  it("drops a presentation it cannot turn into buttons without inventing any", () => {
    const payload = { ...corePrompt(), presentation: { blocks: [{ type: "text", text: "?" }] } };
    const normalized = normalizeVkQuestionPayload(payload as never);
    expect(normalized.presentation).toBeUndefined();
    expect(normalized.channelData).toEqual({ askUser: payload.channelData.askUser });
  });
});

describe("buildVkQuestionKeyboard", () => {
  it("builds an inline keyboard of callback buttons, one per row, 'Свой вариант' last", () => {
    const keyboard = JSON.parse(
      buildVkQuestionKeyboard({ questionId: QID, options: ["A", "B"], customInput: true })!,
    );
    expect(keyboard.inline).toBe(true);
    expect(keyboard.one_time).toBeUndefined();
    expect(keyboard.buttons).toHaveLength(3);
    const [a, b, other] = keyboard.buttons.map((row: unknown[]) => {
      expect(row).toHaveLength(1);
      return row[0] as { action: { type: string; label: string; payload: string }; color: string };
    });
    expect(a.action).toMatchObject({ type: "callback", label: "A" });
    expect(JSON.parse(a.action.payload)).toEqual({ ocq: QID, i: 0 });
    expect(JSON.parse(b.action.payload)).toEqual({ ocq: QID, i: 1 });
    expect(a.color).toBe("primary");
    expect(other.action.label).toBe("✍️ Свой вариант");
    expect(JSON.parse(other.action.payload)).toEqual({ ocq: QID, o: 1 });
    expect(other.color).toBe("secondary");
    for (const row of keyboard.buttons) {
      expect(Buffer.byteLength(row[0].action.payload, "utf8")).toBeLessThanOrEqual(255);
    }
  });

  it("truncates long labels to VK's 40 characters", () => {
    const keyboard = JSON.parse(
      buildVkQuestionKeyboard({ questionId: QID, options: ["я".repeat(60)], customInput: false })!,
    );
    const label: string = keyboard.buttons[0][0].action.label;
    expect(Array.from(label)).toHaveLength(40);
    expect(label.endsWith("…")).toBe(true);
    expect(keyboard.buttons).toHaveLength(1);
  });

  it("builds nothing for a text-only question", () => {
    expect(buildVkQuestionKeyboard({ questionId: QID, options: [], customInput: true })).toBeUndefined();
  });
});

describe("parseVkQuestionCallback", () => {
  it("parses a selected option, as an object or as JSON text", () => {
    expect(parseVkQuestionCallback({ ocq: QID, i: 2 })).toEqual({
      questionId: QID,
      intent: "select",
      optionIndex: 2,
    });
    expect(parseVkQuestionCallback(JSON.stringify({ ocq: QID, i: 0 }))).toEqual({
      questionId: QID,
      intent: "select",
      optionIndex: 0,
    });
  });

  it("parses the custom-answer button", () => {
    expect(parseVkQuestionCallback({ ocq: QID, o: 1 })).toEqual({ questionId: QID, intent: "custom-input" });
  });

  it("rejects everything else", () => {
    expect(parseVkQuestionCallback({ oc: "/models" })).toBeNull();
    expect(parseVkQuestionCallback({ ocq: "ask_zz", i: 0 })).toBeNull();
    expect(parseVkQuestionCallback({ ocq: QID, i: -1 })).toBeNull();
    expect(parseVkQuestionCallback({ ocq: QID, i: 1.5 })).toBeNull();
    expect(parseVkQuestionCallback({ ocq: QID, i: 9 })).toBeNull();
    expect(parseVkQuestionCallback({ ocq: QID })).toBeNull();
    expect(parseVkQuestionCallback("{not json")).toBeNull();
    expect(parseVkQuestionCallback(undefined)).toBeNull();
  });
});

describe("formatVkQuestionStatusLine", () => {
  it("translates the core's closed set of status lines", () => {
    expect(formatVkQuestionStatusLine("Expired")).toBe("⌛ Время на ответ вышло");
    expect(formatVkQuestionStatusLine("Cancelled")).toBe("✖️ Вопрос снят");
    expect(formatVkQuestionStatusLine("Answered")).toBe("✅ Ответ получен");
    expect(formatVkQuestionStatusLine("Answered: Увеличить ×2")).toBe("✅ Ответ: Увеличить ×2");
    expect(formatVkQuestionStatusLine("Unavailable: request a new question.")).toBe(
      "⚠️ Вопрос больше недоступен",
    );
  });

  it("shows an unknown line as it came", () => {
    expect(formatVkQuestionStatusLine(" Something new ")).toBe("Something new");
  });
});

describe("question deliveries", () => {
  it("finds an open delivery by account and chat only", () => {
    rememberVkQuestionDelivery(QID, { accountId: "default", peerId: 7, messageId: 10 });
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 7 })).toEqual({
      accountId: "default",
      peerId: 7,
      messageId: 10,
    });
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 8 })).toBeUndefined();
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "other", peerId: 7 })).toBeUndefined();
  });

  it("keeps several deliveries of one question and closes them together", () => {
    rememberVkQuestionDelivery(QID, { accountId: "default", peerId: 7, messageId: 10 });
    rememberVkQuestionDelivery(QID, { accountId: "default", peerId: 9, messageId: 11 });
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 9 })?.messageId).toBe(11);
    markVkQuestionTerminal(QID);
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 7 })).toBeUndefined();
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 9 })).toBeUndefined();
  });

  it("forgets a question after a day", () => {
    vi.useFakeTimers();
    try {
      rememberVkQuestionDelivery(QID, { accountId: "default", peerId: 7, messageId: 10 });
      vi.advanceTimersByTime(24 * 60 * 60 * 1_000 + 1);
      expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: 7 })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marking an unknown question is harmless", () => {
    markVkQuestionTerminal(`ask_${"c".repeat(32)}`);
    expect(findOpenVkQuestionDelivery({ questionId: `ask_${"c".repeat(32)}`, accountId: "default", peerId: 1 })).toBeUndefined();
  });
});

describe("loadVkQuestionRuntime", () => {
  it("loads the core's question runtime once", async () => {
    const runtime = { resolveOption: vi.fn() };
    vi.doMock("openclaw/plugin-sdk/question-gateway-runtime", () => ({ questionGatewayRuntime: runtime }));
    const first = await loadVkQuestionRuntime();
    expect(first).toBe(runtime);
    expect(await loadVkQuestionRuntime()).toBe(first);
  });

  it("is undefined on a core without the subpath, so the question goes out as text", async () => {
    vi.doMock("openclaw/plugin-sdk/question-gateway-runtime", () => {
      throw new Error("Cannot find module");
    });
    expect(await loadVkQuestionRuntime()).toBeUndefined();
  });
});

describe("draft handoff before a question", () => {
  it("calls the handoffs of that chat only, and stops after unregister", async () => {
    const here = vi.fn(async () => {});
    const other = vi.fn(async () => {});
    const unregister = registerVkDraftQuestionHandoff({ accountId: "default", peerId: 7 }, here);
    const unregisterOther = registerVkDraftQuestionHandoff({ accountId: "default", peerId: 8 }, other);
    await handOffVkDraftsBeforeQuestion({ accountId: "default", peerId: 7 });
    expect(here).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    await handOffVkDraftsBeforeQuestion({ accountId: "other", peerId: 7 });
    expect(here).toHaveBeenCalledTimes(1);
    unregister();
    unregister();
    await handOffVkDraftsBeforeQuestion({ accountId: "default", peerId: 7 });
    expect(here).toHaveBeenCalledTimes(1);
    unregisterOther();
  });

  it("a failing handoff does not stop the others or the question", async () => {
    const failing = vi.fn(async () => {
      throw new Error("VK edit failed");
    });
    const next = vi.fn(async () => {});
    const a = registerVkDraftQuestionHandoff({ accountId: "default", peerId: "7" }, failing);
    const b = registerVkDraftQuestionHandoff({ accountId: "default", peerId: 7 }, next);
    await expect(handOffVkDraftsBeforeQuestion({ accountId: "default", peerId: 7 })).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    a();
    b();
  });
});

describe("parseVkQuestionTextAnswer — the core's rules", () => {
  const fixed = { questionId: QID, options: ["Белый", "Чёрный", "Серый"], customInput: false };
  const withOther = { ...fixed, customInput: true };
  const free = { questionId: QID, options: [], customInput: false };

  it("a number picks that option, one-based", () => {
    expect(parseVkQuestionTextAnswer(fixed, "2")).toBe("Чёрный");
    expect(parseVkQuestionTextAnswer(fixed, " 3 ")).toBe("Серый");
  });

  it("an option's text picks it, in any case, as the declared label", () => {
    expect(parseVkQuestionTextAnswer(fixed, "чёрный")).toBe("Чёрный");
  });

  it("anything else is not an answer when the options are fixed", () => {
    expect(parseVkQuestionTextAnswer(fixed, "0")).toBeUndefined();
    expect(parseVkQuestionTextAnswer(fixed, "4")).toBeUndefined();
    expect(parseVkQuestionTextAnswer(fixed, "а что это вообще?")).toBeUndefined();
    expect(parseVkQuestionTextAnswer(fixed, "   ")).toBeUndefined();
  });

  it("free text counts where the question allows its own answer", () => {
    expect(parseVkQuestionTextAnswer(withOther, "  Бирюзовый ")).toBe("Бирюзовый");
    expect(parseVkQuestionTextAnswer(withOther, "1")).toBe("Белый");
    expect(parseVkQuestionTextAnswer(withOther, "7")).toBe("7");
  });

  it("any text answers a question without options", () => {
    expect(parseVkQuestionTextAnswer(free, "2")).toBe("2");
    expect(parseVkQuestionTextAnswer(free, "до пятницы")).toBe("до пятницы");
  });
});

describe("findOpenVkQuestionForChat", () => {
  const prompt = { questionId: QID, options: ["A"], customInput: false };
  const QID2 = `ask_${"b".repeat(32)}`;

  it("finds the latest open question delivered to that chat", () => {
    rememberVkQuestionDelivery(QID, { accountId: "default", peerId: 7, messageId: 1 }, prompt);
    rememberVkQuestionDelivery(QID2, { accountId: "default", peerId: 7, messageId: 2 }, { ...prompt, questionId: QID2 });
    expect(findOpenVkQuestionForChat({ accountId: "default", peerId: 7 })?.questionId).toBe(QID2);
    markVkQuestionTerminal(QID2);
    expect(findOpenVkQuestionForChat({ accountId: "default", peerId: 7 })).toEqual({ questionId: QID, prompt });
  });

  it("skips other chats, closed questions and ones a typed answer cannot settle", () => {
    rememberVkQuestionDelivery(QID, { accountId: "default", peerId: 7, messageId: 1 }, prompt);
    expect(findOpenVkQuestionForChat({ accountId: "default", peerId: 8 })).toBeUndefined();
    expect(findOpenVkQuestionForChat({ accountId: "other", peerId: 7 })).toBeUndefined();
    markVkQuestionNotTextAnswerable(QID);
    expect(findOpenVkQuestionForChat({ accountId: "default", peerId: 7 })).toBeUndefined();
    markVkQuestionNotTextAnswerable(QID2);
  });

  it("a delivery remembered without a prompt answers only by buttons", () => {
    rememberVkQuestionDelivery(QID, { accountId: "default", peerId: 7, messageId: 1 });
    expect(findOpenVkQuestionForChat({ accountId: "default", peerId: 7 })).toBeUndefined();
  });
});

describe("withoutVkQuestionReplyGuidance", () => {
  it("cuts each of the core's closing lines, and only a whole last paragraph", () => {
    for (const line of [
      "Reply by number or question id. Use a declared option where choices are fixed.",
      "Reply with your answer.",
      "Reply with comma-separated option numbers or text, or your own answer.",
      "Reply with the number, the option text, or your own answer.",
      "Reply with the number or option text.",
    ]) {
      expect(withoutVkQuestionReplyGuidance(`Вопрос?\n1. Да\n\n${line}`)).toBe("Вопрос?\n1. Да");
    }
    expect(withoutVkQuestionReplyGuidance("Вопрос?\n\nReply with your answer. Или нет")).toBe(
      "Вопрос?\n\nReply with your answer. Или нет",
    );
    expect(withoutVkQuestionReplyGuidance("Reply with your answer.")).toBe("Reply with your answer.");
  });
});
