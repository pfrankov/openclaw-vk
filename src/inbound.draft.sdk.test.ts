import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VkInboundMessage } from "./types.js";

/**
 * The step draft through the REAL core: `channel-outbound` (compositor, stream
 * mode, `isPotentialTruncatedFinal` / `selectLongerFinalText`), `reply-payload`,
 * the real `progress-draft.ts` and the real markdown renderer. Only the VK API
 * (`send.js`) and the agent run itself are replaced.
 *
 * `inbound.test.ts` mocks the whole core surface, and one of its mocks —
 * "the longest text wins" for `selectLongerFinalText` — is what kept the empty
 * final deleting the answer invisible: the real function returns nothing for
 * an empty final. Every property here is asserted on what the recipient ends
 * up seeing in the chat, not on which helper was called.
 *
 * The `openclaw` peer is optional, so this file skips itself where it is not
 * installed, like `diagnostics.sdk.test.ts`, and runs in CI's
 * runtime-compatibility job, which installs the host.
 */
const CHANNEL_OUTBOUND = "openclaw/plugin-sdk/channel-outbound";
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve(CHANNEL_OUTBOUND);
    return true;
  } catch {
    return false;
  }
})();

// ── A VK chat the tests can read back ────────────────────────────────────────

type ChatMessage = {
  id: number;
  text: string;
  media: string[];
  formatData?: unknown;
  /** The message this one quotes, as VK's `reply_to`. */
  replyTo?: string;
  /** Sent with the keyboard removal. */
  clearKeyboard?: boolean;
};

const chat = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  nextId: 100,
  sendMessageCalls: 0,
  /** Fail every sendMessageVk call from this index on (0-based), or never. */
  failSendMessageFrom: null as number | null,
  failSendPayload: false,
  payloadCalls: [] as Array<Record<string, unknown>>,
}));

// Only the calls that reach VK are replaced; the rest of send.js — the markdown
// attachment parser in particular — is the real one.
vi.mock("./send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send.js")>();
  return {
  ...actual,
  sendMessageVk: vi.fn(async (to: string, text: string, opts?: { replyTo?: string }) => {
    const index = chat.sendMessageCalls++;
    if (chat.failSendMessageFrom !== null && index >= chat.failSendMessageFrom) {
      throw new Error("VK API error 10: internal server error");
    }
    const id = chat.nextId++;
    chat.messages.push({ id, text, media: [], replyTo: opts?.replyTo });
    return { messageId: String(id), chatId: to };
  }),
  editMessageVk: vi.fn(
    async (_to: string, id: number, text: string, _account: unknown, opts?: { formatData?: unknown }) => {
      const message = chat.messages.find((m) => m.id === id);
      if (!message) {
        return false;
      }
      message.text = text;
      message.formatData = opts?.formatData;
      return true;
    },
  ),
  deleteMessageVk: vi.fn(async (_to: string, id: number) => {
    chat.messages = chat.messages.filter((m) => m.id !== id);
  }),
  sendPayloadVk: vi.fn(
    async (to: string, payload: Record<string, unknown>, opts?: { clearKeyboard?: boolean }) => {
    chat.payloadCalls.push(payload);
    // A question takes the REAL send path — the one that moves the draft out
    // of its way — down to VK's API, which is the fake chat below.
    const channelData = payload.channelData as { askUser?: unknown } | undefined;
    if (channelData?.askUser) {
      return await actual.sendPayloadVk(to, payload as never, opts);
    }
    if (chat.failSendPayload) {
      throw new Error("VK API error 10: upload failed");
    }
    const id = chat.nextId++;
    // As the real sendPayloadVk does: markdown attachment links leave the text
    // and travel as attachments.
    const parsed = actual.splitVkMarkdownAttachments(String(payload.text ?? ""));
    const media = [
      ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
      ...((payload.mediaUrls as string[] | undefined) ?? []),
      ...parsed.attachments,
    ];
    chat.messages.push({
      id,
      text: parsed.text,
      media,
      replyTo: typeof payload.replyToId === "string" ? payload.replyToId : undefined,
      clearKeyboard: opts?.clearKeyboard,
    });
    return { messageId: String(id), chatId: to };
  },
  ),
  markMessageReadVk: vi.fn(async () => undefined),
  sendTypingVk: vi.fn(async () => undefined),
  resolveVkOwnGroup: vi.fn(async () => ({ id: 239104331, name: "Карамелька" })),
  clearVkInstances: vi.fn(),
  };
});

// VK's API, for the one real send path above (questions): into the same chat.
vi.mock("vk-io", () => ({
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        messages: {
          send: vi.fn(async (params: { message: string }) => {
            const id = chat.nextId++;
            chat.messages.push({ id, text: params.message, media: [] });
            return id;
          }),
        },
      },
    };
  }),
  getRandomId: () => 1,
  // monitor.ts (through channel.ts) extends it at load; never started here.
  PollingTransport: class {},
}));

// ── The agent run: each test scripts what the core delivers ─────────────────

type Scenario = (args: {
  dispatcherOptions: {
    deliver: (payload: unknown, info?: { kind?: string }) => Promise<void>;
  };
  replyOptions: {
    onToolStart?: (payload: Record<string, unknown>) => Promise<void>;
  };
}) => Promise<void>;

const run = vi.hoisted(() => ({ scenario: null as Scenario | null }));

const inbound: typeof import("./inbound.js") | null = sdkInstalled
  ? await import("./inbound.js")
  : null;
const runtimeModule: typeof import("./runtime.js") | null = sdkInstalled
  ? await import("./runtime.js")
  : null;
const helpers: typeof import("./test-helpers.js") | null = sdkInstalled
  ? await import("./test-helpers.js")
  : null;
const channel: typeof import("./channel.js") | null = sdkInstalled
  ? await import("./channel.js")
  : null;
const questionModule: typeof import("./question.js") | null = sdkInstalled
  ? await import("./question.js")
  : null;
const coreQuestions = sdkInstalled
  ? await import("openclaw/plugin-sdk/question-gateway-runtime")
  : null;

const LABEL = "⏳ Работаю";

function progressCfg() {
  return {
    channels: {
      vk: {
        token: "tok",
        dmPolicy: "open",
        allowFrom: ["*"],
        streaming: { mode: "progress", progress: { label: LABEL, toolProgress: true } },
      },
    },
  };
}

async function runTurn(
  scenario: Scenario,
  message: Partial<VkInboundMessage> = {},
): Promise<void> {
  run.scenario = scenario;
  const cfg = progressCfg();
  await inbound!.handleVkInbound({
    message: helpers!.makeMessage({ conversationMessageId: 42, text: "сделай", ...message }),
    account: helpers!.makeAccount({
      config: { dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open" },
    }),
    config: cfg as never,
    runtime: helpers!.createVkRuntimeEnv(),
  });
}

const toolStart = (name = "exec") => ({
  name,
  phase: "start",
  toolCallId: `call-${name}`,
  args: { command: "ls" },
});

const texts = () => chat.messages.map((m) => m.text);
const voice = { mediaUrl: "file:///tmp/answer.opus", audioAsVoice: true };

describe.skipIf(!inbound || !runtimeModule || !helpers)("step draft through the real core", () => {
  beforeEach(() => {
    chat.messages = [];
    chat.nextId = 100;
    chat.sendMessageCalls = 0;
    chat.failSendMessageFrom = null;
    chat.failSendPayload = false;
    chat.payloadCalls = [];
    run.scenario = null;
    const runtime = helpers!.makeVkRuntime();
    // The agent run: each test scripts what the core delivers.
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = (async (
      args: Parameters<Scenario>[0],
    ) => {
      await run.scenario?.(args);
    }) as never;
    // The real question send path reads the live config for the VK token.
    vi.mocked(runtime.config.current).mockReturnValue(progressCfg() as never);
    runtimeModule!.setVkRuntime(runtime);
  });

  it("shows the tool step in the draft (sanity: the real compositor is wired)", async () => {
    let seen: string[] = [];
    await runTurn(async ({ replyOptions, dispatcherOptions }) => {
      await replyOptions.onToolStart?.(toolStart());
      seen = texts();
      await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith(LABEL)).toBe(true);
    expect(texts()).toEqual(["Готово."]);
  });

  // ── P1-1: an empty final must not delete the answer that is in the draft ──

  describe("empty final after the answer went into the draft as blocks", () => {
    const ANSWER = "Готово: проверил каталог, там три файла, всё на месте.";

    for (const [name, final] of [
      ["empty text", { text: "", ...voice }],
      ["no text at all", { ...voice }],
    ] as const) {
      it(`keeps the answer when the final carries ${name} and a voice note`, async () => {
        await runTurn(async ({ replyOptions, dispatcherOptions }) => {
          await replyOptions.onToolStart?.(toolStart());
          await dispatcherOptions.deliver({ text: ANSWER }, { kind: "block" });
          await dispatcherOptions.deliver(final, { kind: "final" });
        });
        expect(chat.messages.map((m) => m.text)).toContain(ANSWER);
        // The answer is final now: no "working" header left on it.
        expect(texts().some((t) => t.includes(LABEL))).toBe(false);
        expect(chat.messages.some((m) => m.media.includes(voice.mediaUrl))).toBe(true);
      });
    }

    it("still drops a draft that holds only steps when the final is empty", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "", ...voice }, { kind: "final" });
      });
      expect(texts().some((t) => t.includes(LABEL))).toBe(false);
      expect(chat.messages).toHaveLength(1);
      expect(chat.messages[0]?.media).toEqual([voice.mediaUrl]);
    });

    it("keeps the fuller draft when a non-empty final arrives truncated", async () => {
      const full =
        "Проверил все три сервера по очереди и сравнил их журналы за последние сутки, " +
        "расхождений нет, резервные копии свежие и читаются без ошибок.";
      const truncated = `${full.slice(0, 60)}…`;
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: full }, { kind: "block" });
        await dispatcherOptions.deliver({ text: truncated }, { kind: "final" });
      });
      expect(texts()).toContain(full);
      expect(texts()).not.toContain(truncated);
      expect(texts().some((t) => t.includes(LABEL))).toBe(false);
    });
  });

  // ── P1-2: a block that no longer fits must not cost the earlier ones ─────

  describe("blocks that stop fitting into the draft", () => {
    const first = `ПЕРВЫЙ ${"а".repeat(2500)}`;
    const second = `ВТОРОЙ ${"б".repeat(2500)}`;
    const third = "ТРЕТИЙ конец";

    it("delivers every block once and in order, none with the working header", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: first }, { kind: "block" });
        await dispatcherOptions.deliver({ text: second }, { kind: "block" });
        await dispatcherOptions.deliver({ text: third }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "", ...voice }, { kind: "final" });
      });
      const joined = texts().join("\n");
      for (const part of ["ПЕРВЫЙ", "ВТОРОЙ", "ТРЕТИЙ"]) {
        expect(joined.split(part)).toHaveLength(2);
      }
      expect(joined.indexOf("ПЕРВЫЙ")).toBeLessThan(joined.indexOf("ВТОРОЙ"));
      expect(joined.indexOf("ВТОРОЙ")).toBeLessThan(joined.indexOf("ТРЕТИЙ"));
      expect(texts().some((t) => t.includes(LABEL))).toBe(false);
    });

    it("keeps the earlier blocks when the overflowing block is followed by an empty final", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: first }, { kind: "block" });
        await dispatcherOptions.deliver({ text: second }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "", ...voice }, { kind: "final" });
      });
      const joined = texts().join("\n");
      expect(joined).toContain("ПЕРВЫЙ");
      expect(joined).toContain("ВТОРОЙ");
      expect(joined.indexOf("ПЕРВЫЙ")).toBeLessThan(joined.indexOf("ВТОРОЙ"));
      expect(texts().some((t) => t.includes(LABEL))).toBe(false);
    });

    it("keeps the order when a block with a picture goes between text blocks", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "ДО картинки" }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "подпись", mediaUrl: "https://example.com/p.png" },
          { kind: "block" },
        );
        await dispatcherOptions.deliver({ text: "ПОСЛЕ картинки" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "", ...voice }, { kind: "final" });
      });
      const order = chat.messages.map((m) =>
        m.media.includes("https://example.com/p.png") ? "PIC" : m.text,
      );
      const before = order.findIndex((t) => t.includes("ДО картинки"));
      const pic = order.indexOf("PIC");
      const after = order.findIndex((t) => t.includes("ПОСЛЕ картинки"));
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThan(pic);
      expect(pic).toBeLessThan(after);
      expect(texts().filter((t) => t.includes("ДО картинки"))).toHaveLength(1);
    });

    it("delivers a single block longer than one VK message without the header", async () => {
      const huge = `ОГРОМНЫЙ ${"в".repeat(5000)} КОНЕЦ`;
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: huge }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "", ...voice }, { kind: "final" });
      });
      const joined = texts().join("");
      expect(joined).toContain("ОГРОМНЫЙ");
      expect(joined).toContain("КОНЕЦ");
      expect(texts().some((t) => t.includes(LABEL))).toBe(false);
    });
  });

  // ── P1-3: markdown attachments of an answer written into the draft ───────

  describe("markdown attachments in an answer written into the draft", () => {
    it("sends a markdown image as an attachment, not as a link in the draft", async () => {
      const image = "![chart](https://example.com/c.png)";
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: `График: ${image}` }, { kind: "final" });
      });
      expect(texts().some((t) => t.includes("График"))).toBe(true);
      expect(texts().some((t) => t.includes("!chart") || t.includes("c.png"))).toBe(false);
      const carriers = chat.payloadCalls.filter(
        (p) =>
          p.mediaUrl === "https://example.com/c.png" ||
          ((p.mediaUrls as string[] | undefined) ?? []).includes("https://example.com/c.png") ||
          String(p.text ?? "").includes(image),
      );
      expect(carriers).toHaveLength(1);
      // The caption is already in the draft; the attachment goes without it.
      expect(String(carriers[0]?.text ?? "").replace(image, "").trim()).toBe("");
    });

    it("sends a local file link as a document", async () => {
      const file = "[отчёт.pdf](/tmp/report.pdf)";
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: `Отчёт готов: ${file}` }, { kind: "final" });
      });
      expect(texts().some((t) => t.includes("Отчёт готов"))).toBe(true);
      expect(texts().some((t) => t.includes("/tmp/report.pdf"))).toBe(false);
      expect(chat.payloadCalls.some((p) => String(p.text ?? "").includes(file))).toBe(true);
    });

    it("leaves an ordinary web link in the draft as a link", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver(
          { text: "Подробнее: [страница](https://example.com/page)" },
          { kind: "final" },
        );
      });
      expect(chat.payloadCalls).toHaveLength(0);
      expect(chat.messages).toHaveLength(1);
      expect(chat.messages[0]?.text).toContain("страница");
      expect(JSON.stringify(chat.messages[0]?.formatData)).toContain("https://example.com/page");
    });

    it("does not write a block with a markdown image into the draft", async () => {
      const image = "![chart](https://example.com/c.png)";
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: `Промежуточный график: ${image}` }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Итог." }, { kind: "final" });
      });
      expect(texts().some((t) => t.includes("!chart"))).toBe(false);
      expect(chat.payloadCalls.some((p) => String(p.text ?? "").includes(image))).toBe(true);
    });
  });

  // ── P1-4: a failed tail must reach the core ─────────────────────────────

  describe("tail of an answer written into the draft", () => {
    const long = `${"Длинный ответ. ".repeat(600)}Конец.`;

    it("rejects deliver when a text tail chunk fails", async () => {
      let outcome: unknown = "not run";
      chat.failSendMessageFrom = 1; // the draft itself is send #0
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        outcome = await dispatcherOptions.deliver({ text: long }, { kind: "final" }).then(
          () => "resolved",
          (err: unknown) => err,
        );
      });
      expect(outcome).toBeInstanceOf(Error);
    });

    it("rejects deliver when the media after the text fails", async () => {
      let outcome: unknown = "not run";
      chat.failSendPayload = true;
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        outcome = await dispatcherOptions
          .deliver({ text: "Ответ с голосом.", ...voice }, { kind: "final" })
          .then(
            () => "resolved",
            (err: unknown) => err,
          );
      });
      expect(outcome).toBeInstanceOf(Error);
      // What did go out is not sent again.
      expect(texts().filter((t) => t === "Ответ с голосом.")).toHaveLength(1);
    });

    it("resolves when the whole tail is delivered", async () => {
      let outcome: unknown = "not run";
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        outcome = await dispatcherOptions.deliver({ text: long, ...voice }, { kind: "final" }).then(
          () => "resolved",
          (err: unknown) => err,
        );
      });
      expect(outcome).toBe("resolved");
      expect(texts().join("")).toContain("Конец.");
      expect(chat.messages.some((m) => m.media.includes(voice.mediaUrl))).toBe(true);
    });
  });

  // ── Quote and keyboard: the same as a reply without a draft ─────────────

  describe("quote and keyboard", () => {
    const GROUP = { peerId: 2_000_000_001, isGroup: true, messageId: "555" };

    it("quotes the incoming message in a group, and the answer written into the draft keeps it", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "Ответ в беседе." }, { kind: "final" });
      }, GROUP);
      expect(chat.messages).toHaveLength(1);
      expect(chat.messages[0]).toMatchObject({ text: "Ответ в беседе.", replyTo: "555" });
    });

    it("quotes only the first part when the answer outgrows one draft", async () => {
      const first = `ПЕРВЫЙ ${"а".repeat(2500)}`;
      const second = `ВТОРОЙ ${"б".repeat(2500)}`;
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: first }, { kind: "block" });
        await dispatcherOptions.deliver({ text: second }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "", ...voice }, { kind: "final" });
      }, GROUP);
      const drafts = chat.messages.filter((m) => m.media.length === 0);
      expect(drafts.map((m) => m.replyTo)).toEqual(["555", undefined]);
    });

    it("quotes nothing in a direct chat", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "Ответ в личке." }, { kind: "final" });
      });
      expect(chat.messages).toHaveLength(1);
      expect(chat.messages[0]?.replyTo).toBeUndefined();
    });

    it("answers a button press the ordinary way: the keyboard is cleared, the draft removed", async () => {
      await runTurn(
        async ({ replyOptions, dispatcherOptions }) => {
          await replyOptions.onToolStart?.(toolStart());
          await dispatcherOptions.deliver({ text: "Режим включён." }, { kind: "final" });
        },
        { messagePayload: { oc: "/think high" }, messageId: "777" },
      );
      expect(chat.messages).toHaveLength(1);
      expect(chat.messages[0]).toMatchObject({
        text: "Режим включён.",
        replyTo: "777",
        clearKeyboard: true,
      });
    });

    it("clears the keyboard when a button answer streamed in blocks has an empty final", async () => {
      await runTurn(
        async ({ replyOptions, dispatcherOptions }) => {
          await replyOptions.onToolStart?.(toolStart());
          await dispatcherOptions.deliver({ text: "Режим" }, { kind: "block" });
          await dispatcherOptions.deliver({ text: "включён." }, { kind: "block" });
          await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
        },
        { messagePayload: { oc: "/think high" }, messageId: "777" },
      );
      expect(chat.messages).toEqual([
        expect.objectContaining({
          text: "Режим\n\nвключён.",
          replyTo: "777",
          clearKeyboard: true,
        }),
      ]);
      expect(texts().some((text) => text.includes(LABEL))).toBe(false);
    });

    it("keeps a button answer in the draft if its replacement send fails", async () => {
      chat.failSendPayload = true;
      await expect(
        runTurn(
          async ({ replyOptions, dispatcherOptions }) => {
            await replyOptions.onToolStart?.(toolStart());
            await dispatcherOptions.deliver({ text: "Ответ блоком." }, { kind: "block" });
            await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
          },
          { messagePayload: { oc: "/think high" }, messageId: "777" },
        ),
      ).rejects.toThrow("upload failed");
      expect(chat.messages).toEqual([
        expect.objectContaining({ text: "Ответ блоком.", replyTo: "777" }),
      ]);
    });
  });

  // ── P2: a turn that ends without a final ────────────────────────────────

  describe("turn without a final", () => {
    it("removes a draft that holds only steps", async () => {
      await runTurn(async ({ replyOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
      });
      expect(chat.messages).toHaveLength(0);
    });

    it("keeps the answer blocks, without the working header", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "Ответ блоками." }, { kind: "block" });
      });
      expect(texts()).toEqual(["Ответ блоками."]);
    });

    it("keeps the answer when a later tool start does not redraw the draft", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "Ответ блоками." }, { kind: "block" });
        // `message` is not a working tool for the compositor: nothing is redrawn.
        await replyOptions.onToolStart?.({ name: "message", phase: "start" });
      });
      expect(texts()).toEqual(["Ответ блоками."]);
    });
  });

  // ── A question from the core holds the turn: it must stay its own message ─

  describe("question from the core (ask_user / AskUserQuestion) during a turn", () => {
    const QID = `ask_${"d".repeat(32)}`;
    const question = {
      text: "Question for you:\n\nАпскейл\nКакой размер?\n1. ×2\n2. ×4",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "text", text: "Какой размер?" },
          {
            type: "buttons",
            buttons: [
              { label: "×2", action: { type: "question", questionId: QID, optionValue: "×2" } },
              { label: "×4", action: { type: "question", questionId: QID, optionValue: "×4" } },
            ],
          },
        ],
      },
      channelData: { askUser: { questionId: QID, optionValues: ["×2", "×4"] } },
    };

    for (const kind of ["block", "tool"] as const) {
      it(`a ${kind} question goes out as its own message with its presentation, not into the draft`, async () => {
        await runTurn(async ({ replyOptions, dispatcherOptions }) => {
          await replyOptions.onToolStart?.(toolStart());
          await dispatcherOptions.deliver(question, { kind });
          // The next tool step redraws the draft; the question must survive it.
          await replyOptions.onToolStart?.(toolStart("render"));
          await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
        });
        const sent = chat.payloadCalls.find((payload) => payload.channelData);
        // Handed to sendPayloadVk whole: it builds the keyboard from these.
        expect(sent?.channelData).toEqual(question.channelData);
        expect(sent?.presentation).toEqual(question.presentation);
        // Not labelled as progress: it is a question, not a step.
        expect(String(sent?.text).startsWith(LABEL)).toBe(false);
        // The step list above the question is gone; the steps after it and
        // the answer land below it, in the order they happened.
        expect(texts()).toEqual([question.text, "Готово."]);
      });
    }

    it("steps after the question are drawn in a fresh draft below it", async () => {
      let during: string[] = [];
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver(question, { kind: "tool" });
        await replyOptions.onToolStart?.(toolStart("render"));
        during = texts();
      });
      expect(during).toHaveLength(2);
      expect(during[0]).toBe(question.text);
      expect(during[1]?.startsWith(LABEL)).toBe(true);
    });

    /**
     * `ask_user` over MCP — the production path: the core sends the question
     * as an outbound send (`normalizePayload` → `sendPayload`), never through
     * this turn's `deliver`. 24.09 the draft stayed above it and the final
     * answer was edited into it, above the question.
     */
    const sendOutbound = async (payload: Record<string, unknown>) => {
      const outbound = channel!.vkPlugin.outbound!;
      const cfg = progressCfg();
      const normalized = outbound.normalizePayload!({ payload, cfg } as never) ?? payload;
      await outbound.sendPayload!({ cfg, to: "vk:123456", payload: normalized, accountId: "default" } as never);
    };

    it("a question sent as an outbound send moves the draft below it too", async () => {
      let during: string[] = [];
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await sendOutbound(question);
        during = texts();
        await replyOptions.onToolStart?.(toolStart("render"));
        await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
      });
      // The bare step list is gone the moment the question goes out.
      expect(during).toEqual([question.text]);
      expect(texts()).toEqual([question.text, "Готово."]);
    });

    it("an outbound question keeps the answer already in the draft, above it", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "Сначала посмотрю варианты." }, { kind: "block" });
        await sendOutbound(question);
        await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
      });
      expect(texts()).toEqual(["Сначала посмотрю варианты.", question.text, "Готово."]);
    });

    it("an ordinary outbound send leaves the draft alone", async () => {
      let during: string[] = [];
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await sendOutbound({ text: "🍬 Рендер готов" });
        during = texts();
        await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
      });
      expect(during).toHaveLength(2);
      expect(during[0]?.startsWith(LABEL)).toBe(true);
      expect(during[1]).toBe("🍬 Рендер готов");
      // The draft took the final, as before: it is the first message.
      expect(texts()).toEqual(["Готово.", "🍬 Рендер готов"]);
    });

    it("a question to another chat leaves this turn's draft alone", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        const outbound = channel!.vkPlugin.outbound!;
        const cfg = progressCfg();
        await outbound.sendPayload!({ cfg, to: "vk:999", payload: question, accountId: "default" } as never);
        await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
      });
      expect(texts()).toEqual(["Готово.", question.text]);
    });

    it("after the turn ends, a question no longer touches its (finished) draft", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
      });
      await sendOutbound(question);
      expect(texts()).toEqual(["Готово.", question.text]);
    });

    it("the answer blocks already in the draft stay above the question", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "Сначала посмотрю варианты." }, { kind: "block" });
        await dispatcherOptions.deliver(question, { kind: "block" });
      });
      expect(texts()).toEqual(["Сначала посмотрю варианты.", question.text]);
    });
  });
});

// ── A typed answer to an open question never becomes a turn ─────────────────

describe.skipIf(!inbound || !channel || !questionModule || !coreQuestions)(
  "typed answer to a question sent as an outbound send (ask_user over MCP)",
  () => {
    const QID = `ask_${"c".repeat(32)}`;
    const question = {
      text: "Question for you:\n\nФон\nКакой фон?\n1. Белый\n2. Чёрный\n3. Серый",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: ["Белый", "Чёрный", "Серый"].map((label) => ({
              label,
              action: { type: "question", questionId: QID, optionValue: label },
            })),
          },
        ],
      },
      channelData: { askUser: { questionId: QID } },
    };
    const resolveOption = vi.fn();
    let dispatched: string[] = [];

    const incoming = (text: string) =>
      inbound!.handleVkInbound({
        message: helpers!.makeMessage({ conversationMessageId: 43, messageId: "m2", text }),
        account: helpers!.makeAccount({ config: { dmPolicy: "open", allowFrom: ["*"] } }),
        config: progressCfg() as never,
        runtime: helpers!.createVkRuntimeEnv(),
      });

    beforeEach(async () => {
      chat.messages = [];
      chat.payloadCalls = [];
      dispatched = [];
      resolveOption.mockReset();
      // This block is not under the shared beforeEach: set its own runtime.
      const runtime = helpers!.makeVkRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = (async (
        args: Parameters<Scenario>[0],
      ) => {
        await run.scenario?.(args);
      }) as never;
      vi.mocked(runtime.config.current).mockReturnValue(progressCfg() as never);
      // The core's own command detection, so /new is known for what it is.
      runtime.channel.text.hasControlCommand = (
        await import("openclaw/plugin-sdk/command-auth-native")
      ).hasControlCommand as never;
      runtimeModule!.setVkRuntime(runtime);
      questionModule!.clearVkQuestionDeliveries();
      // The core's runtime, except the call that needs a hosted gateway.
      questionModule!.resetVkQuestionRuntimeForTest({
        runtime: { ...coreQuestions!.questionGatewayRuntime, resolveOption } as never,
      });
      // The question goes out the production way, during a turn.
      await runTurn(async () => {
        const outbound = channel!.vkPlugin.outbound!;
        const cfg = progressCfg();
        const normalized = outbound.normalizePayload!({ payload: question, cfg } as never) ?? question;
        await outbound.sendPayload!({ cfg, to: "vk:123456", payload: normalized, accountId: "default" } as never);
      });
      run.scenario = async () => {
        dispatched.push("turn");
      };
    });

    afterEach(() => {
      questionModule!.clearVkQuestionDeliveries();
      questionModule!.resetVkQuestionRuntimeForTest();
    });

    it("«3» answers the question and does not reach the core as a turn", async () => {
      resolveOption.mockResolvedValue({ status: "answered", questionId: "q", optionValue: "Серый" });
      await incoming("3");
      expect(resolveOption).toHaveBeenCalledTimes(1);
      expect(resolveOption.mock.calls[0][0]).toMatchObject({ questionId: QID, optionValue: "Серый" });
      expect(dispatched).toEqual([]);
    });

    it("an option's text answers too", async () => {
      resolveOption.mockResolvedValue({ status: "answered", questionId: "q", optionValue: "Чёрный" });
      await incoming("чёрный");
      expect(resolveOption.mock.calls[0][0].optionValue).toBe("Чёрный");
      expect(dispatched).toEqual([]);
    });

    it("a message that is not an answer goes on as a turn", async () => {
      await incoming("подожди, а зачем фон?");
      expect(resolveOption).not.toHaveBeenCalled();
      expect(dispatched).toEqual(["turn"]);
    });

    it("a stop word or a control command stays a command, even where any text answers", async () => {
      // As every ask_user question: its own answer allowed, so free text answers it.
      const QID2 = `ask_${"d".repeat(32)}`;
      const own = {
        ...question,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                ...["Белый", "Чёрный"].map((label) => ({
                  label,
                  action: { type: "question", questionId: QID2, optionValue: label },
                })),
                { label: "Свой вариант", action: { type: "question", questionId: QID2, intent: "custom-input" } },
              ],
            },
          ],
        },
        channelData: { askUser: { questionId: QID2 } },
      };
      questionModule!.clearVkQuestionDeliveries();
      await runTurn(async () => {
        const outbound = channel!.vkPlugin.outbound!;
        const cfg = progressCfg();
        const normalized = outbound.normalizePayload!({ payload: own, cfg } as never) ?? own;
        await outbound.sendPayload!({ cfg, to: "vk:123456", payload: normalized, accountId: "default" } as never);
      });
      resolveOption.mockResolvedValue({ status: "denied" });
      await incoming("стоп");
      await incoming("/stop");
      await incoming("/new");
      expect(resolveOption).not.toHaveBeenCalled();
      // Sanity: the same question takes ordinary free text.
      await incoming("что-то своё");
      expect(resolveOption.mock.calls[0][0]).toMatchObject({ questionId: QID2, optionValue: "что-то своё" });
    });

    it("in a group chat typed text is not taken as an answer", async () => {
      resolveOption.mockResolvedValue({ status: "answered", questionId: "q", optionValue: "Серый" });
      await inbound!.handleVkInbound({
        message: helpers!.makeMessage({
          conversationMessageId: 44,
          messageId: "m3",
          text: "3",
          isGroup: true,
        }),
        account: helpers!.makeAccount({
          config: { dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open" },
        }),
        config: progressCfg() as never,
        runtime: helpers!.createVkRuntimeEnv(),
      });
      expect(resolveOption).not.toHaveBeenCalled();
    });

    it("an answer the core refuses (already answered) goes on as a turn", async () => {
      resolveOption.mockResolvedValue({ status: "already-terminal", reason: "already-terminal" });
      await incoming("2");
      expect(dispatched).toEqual(["turn"]);
      // Closed here now: the next «2» is not even tried.
      await incoming("2");
      expect(resolveOption).toHaveBeenCalledTimes(1);
    });
  },
);
