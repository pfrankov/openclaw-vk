import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stand: a question from the core, end to end, without a model and without VK.
 *
 * REAL, from the installed core:
 *  - `runAgentHarnessGatewayQuestion` (plugin-sdk/agent-harness-runtime) — the
 *    harness path Claude's `AskUserQuestion` takes: registers the question,
 *    builds the prompt payload (text, presentation, `channelData.askUser`),
 *    delivers it through `onBlockReply` and waits for the answer;
 *  - the question channel runtime (plugin-sdk/question-gateway-runtime) — the
 *    delivery binding and `finalize` with its status lines;
 *  - `claimPendingAgentQuestionAnswer` — the core's claim of a TYPED answer
 *    ("2", free text), the same parser the ingress runs.
 * REAL, from the plugin: `normalizeVkQuestionPayload`, `sendPayloadVk`,
 * `handleVkQuestionEvent`.
 * FAKE: VK's API (a chat the test reads back) and the Gateway RPC — the
 * question store the gateway keeps (`question.request/waitAnswer/resolve/get`)
 * and the one-line `resolveOption` over it, because the core's resolver only
 * talks to a hosted in-process gateway. The fake announces requests and
 * outcomes to the channel runtime exactly as the gateway does.
 *
 * Skips itself where the `openclaw` peer is not installed.
 */
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve("openclaw/plugin-sdk/question-gateway-runtime");
    require.resolve("openclaw/plugin-sdk/agent-harness-runtime");
    return true;
  } catch {
    return false;
  }
})();

// ── A VK chat the test can read back ─────────────────────────────────────────

type ChatMessage = { id: number; text: string; keyboard?: string };
const chat = vi.hoisted(() => ({ messages: [] as ChatMessage[], nextId: 900 }));

vi.mock("vk-io", () => ({
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        messages: {
          send: vi.fn(async (params: { message: string; keyboard?: string }) => {
            const id = chat.nextId++;
            chat.messages.push({ id, text: params.message, keyboard: params.keyboard });
            return id;
          }),
          edit: vi.fn(async (params: { message_id: number; message: string; keyboard?: string }) => {
            const message = chat.messages.find((m) => m.id === params.message_id);
            if (!message) {
              throw new Error("VK API error 100: message not found");
            }
            message.text = params.message;
            // messages.edit replaces the message: no keyboard sent or an empty one
            // leaves no buttons (both checked live in VK on 29.09.2026).
            message.keyboard = params.keyboard && JSON.parse(params.keyboard).buttons?.length
              ? params.keyboard
              : undefined;
            return 1;
          }),
        },
        groups: { getById: vi.fn(async () => ({ groups: [{ id: 1, name: "Бот" }] })) },
      },
    };
  }),
  getRandomId: () => Math.floor(Math.random() * 1e9),
}));

const sdk = sdkInstalled
  ? {
      harness: await import("openclaw/plugin-sdk/agent-harness-runtime"),
      questions: await import("openclaw/plugin-sdk/question-gateway-runtime"),
      question: await import("./question.js"),
      events: await import("./question-events.js"),
      send: await import("./send.js"),
      runtime: await import("./runtime.js"),
      helpers: await import("./test-helpers.js"),
    }
  : null;

// ── The Gateway's question store ─────────────────────────────────────────────

type Terminal =
  | { status: "answered"; answers: { answers: Record<string, string[]> }; resolutionId?: string }
  | { status: "expired" }
  | { status: "cancelled" };

type ChannelRuntime = {
  handleRequested: (record: unknown, scheduler: QuestionScheduler) => void;
  handleResolved: (event: unknown) => void;
};

/**
 * The scheduler the gateway hands the channel runtime with each request. From
 * 2026.9.7 `handleResolved` schedules the entry's cleanup through it and throws
 * without one; earlier cores ignore the argument.
 */
type QuestionScheduler = {
  schedule: (job: { id: string; delayMs: number; run: () => void }) => { cancel: () => void };
};
const scheduledCleanups = new Set<ReturnType<typeof setTimeout>>();
const questionScheduler: QuestionScheduler = {
  schedule: ({ delayMs, run }) => {
    const timer = setTimeout(() => {
      scheduledCleanups.delete(timer);
      run();
    }, delayMs);
    timer.unref?.();
    scheduledCleanups.add(timer);
    return {
      cancel: () => {
        clearTimeout(timer);
        scheduledCleanups.delete(timer);
      },
    };
  },
};

function channelRuntime(): ChannelRuntime {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.questionChannelRuntime")
  ] as ChannelRuntime;
}

type StoredQuestion = {
  record: {
    id: string;
    status: string;
    questions: Array<{ questionId: string; options: Array<{ label: string }>; isSecret?: boolean }>;
  };
  terminal?: Terminal;
  settle: (terminal: Terminal) => void;
  done: Promise<Terminal>;
  timer: ReturnType<typeof setTimeout>;
};

const gateway = {
  store: new Map<string, StoredQuestion>(),
  finish(id: string, terminal: Terminal) {
    const stored = gateway.store.get(id);
    if (!stored || stored.terminal) {
      return false;
    }
    clearTimeout(stored.timer);
    stored.terminal = terminal;
    stored.record.status = terminal.status;
    stored.settle(terminal);
    channelRuntime().handleResolved({ id, ...terminal });
    return true;
  },
  async call(method: string, _opts: unknown, params: Record<string, any>): Promise<unknown> {
    switch (method) {
      case "question.request": {
        let settle!: (terminal: Terminal) => void;
        const done = new Promise<Terminal>((resolve) => {
          settle = resolve;
        });
        const record = { id: params.id, status: "pending", questions: params.questions };
        const timer = setTimeout(() => gateway.finish(params.id, { status: "expired" }), params.timeoutMs);
        gateway.store.set(params.id, { record, settle, done, timer });
        channelRuntime().handleRequested(record, questionScheduler);
        return { id: params.id };
      }
      case "question.waitAnswer":
        return await gateway.store.get(params.id)!.done;
      case "question.get":
        return { question: gateway.store.get(params.id)!.record };
      case "question.resolve": {
        if (params.cancel) {
          gateway.finish(params.id, { status: "cancelled" });
          return { status: "cancelled" };
        }
        if (!gateway.finish(params.id, {
          status: "answered",
          answers: params.answers,
          resolutionId: params.resolutionId,
        })) {
          throw Object.assign(new Error("already terminal"), {
            name: "GatewayClientRequestError",
            details: { reason: "QUESTION_ALREADY_TERMINAL" },
          });
        }
        return { status: "answered" };
      }
      default:
        throw new Error(`unexpected gateway method ${method}`);
    }
  },
};

/** The resolver's protocol over the fake gateway: read, map the index, authorize, write. */
async function resolveOverFakeGateway(params: Record<string, any>) {
  const { question: record } = (await gateway.call("question.get", {}, { id: params.questionId })) as {
    question: StoredQuestion["record"];
  };
  if (record.status !== "pending") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  // As the core's resolver: one question, not multi-select, not secret.
  const question = record.questions.length === 1 ? record.questions[0] : undefined;
  if (!question || (question as { multiSelect?: boolean }).multiSelect || question.isSecret) {
    throw new Error("question button resolution requires one tappable question");
  }
  if (params.customInput) {
    return { status: "custom-input", questionId: question.questionId };
  }
  const optionValue = params.optionValue ?? question.options[params.optionIndex]?.label;
  if (params.authorize && !(await params.authorize())) {
    return { status: "denied" };
  }
  await gateway.call("question.resolve", {}, {
    id: params.questionId,
    answers: { answers: { [question.questionId]: [optionValue] } },
    resolvedBy: params.senderId,
  });
  return { status: "answered", questionId: question.questionId, optionValue };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DM = 7654321;
const SESSION = "agent:main:vk:direct:7654321";

const UPSCALE = {
  id: "size",
  header: "Апскейл",
  question: "До какого размера увеличить картинку?",
  isOther: true,
  isSecret: false,
  multiSelect: false,
  options: [
    { label: "Оставить", description: "1024×1024, как есть" },
    { label: "×2", description: "2048×2048" },
    { label: "×4", description: "4096×4096, дольше" },
  ],
};

let deliveredPayloads: unknown[] = [];

/** Starts the core's question as Claude's AskUserQuestion would; returns its answer promise. */
function ask(questions: unknown[], options: { timeoutMs?: number; outbound?: boolean } = {}) {
  return sdk!.harness.runAgentHarnessGatewayQuestion({
    questions: questions as never,
    sessionKey: SESSION,
    timeoutMs: options.timeoutMs ?? 60_000,
    gatewayCall: gateway.call as never,
    delivery: {
      onBlockReply: async (payload: unknown) => {
        deliveredPayloads.push(payload);
        // The two ways a question reaches VK: the reply dispatcher hands the
        // payload as it is; an outbound send goes through normalizePayload.
        const outgoing = options.outbound
          ? sdk!.question.normalizeVkQuestionPayload(payload as never)
          : payload;
        await sdk!.send.sendPayloadVk(String(DM), outgoing as never, {});
      },
    } as never,
    promptOptions: { intro: "Claude needs input:" },
  });
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const promptMessage = () => waitFor(() => chat.messages[0], "the question in the chat");

function buttonsOf(message: ChatMessage) {
  const keyboard = JSON.parse(message.keyboard!);
  return (keyboard.buttons as Array<Array<{ action: { label: string; payload: string } }>>).map(
    (row) => row[0]!.action,
  );
}

/** Ivan types a message in the chat; true when the plugin took it as the answer. */
function type(text: string, senderId = DM) {
  return sdk!.events.answerVkQuestionByText({
    accountId: "default",
    peerId: DM,
    senderId,
    text,
    runtime: sdk!.helpers.createVkRuntimeEnv(),
  });
}

async function press(payload: string, userId = DM) {
  const answer = vi.fn().mockResolvedValue(1);
  await sdk!.events.handleVkQuestionEvent({
    event: { userId, peerId: DM, eventPayload: JSON.parse(payload), answer },
    accountId: "default",
    runtime: sdk!.helpers.createVkRuntimeEnv(),
  });
  return answer.mock.calls[0]?.[0]?.text as string | undefined;
}

describe.skipIf(!sdk)("stand: a question from the core through VK", () => {
  beforeEach(() => {
    chat.messages = [];
    deliveredPayloads = [];
    const runtime = sdk!.helpers.makeVkRuntime();
    vi.mocked(runtime.config.current).mockReturnValue({
      channels: { vk: { token: "stand-token", dmPolicy: "open", allowFrom: ["*"] } },
    } as never);
    sdk!.runtime.setVkRuntime(runtime);
    sdk!.send.clearVkInstances();
    // The real runtime, except the one call that needs a hosted gateway.
    sdk!.question.resetVkQuestionRuntimeForTest({
      runtime: { ...sdk!.questions.questionGatewayRuntime, resolveOption: resolveOverFakeGateway as never },
    });
  });

  afterEach(() => {
    for (const stored of gateway.store.values()) {
      clearTimeout(stored.timer);
    }
    for (const timer of scheduledCleanups) {
      clearTimeout(timer);
    }
    scheduledCleanups.clear();
    gateway.store.clear();
    sdk!.question.clearVkQuestionDeliveries();
    sdk!.question.resetVkQuestionRuntimeForTest();
  });

  it("the prompt arrives with the core's text and a button per option plus 'Свой вариант'", async () => {
    const answer = ask([UPSCALE]);
    const message = await promptMessage();
    expect(message.text).toContain("Апскейл");
    expect(message.text).toContain("До какого размера увеличить картинку?");
    expect(message.text).toContain("2. ×2 - 2048×2048");
    expect(buttonsOf(message).map((b) => b.label)).toEqual(["Оставить", "×2", "×4", "✍️ Свой вариант"]);
    // Close the question so the test does not leave it pending.
    await press(buttonsOf(message)[0]!.payload);
    await answer;
  });

  it("a pressed button answers the question, and the message loses its buttons", async () => {
    const answer = ask([UPSCALE]);
    const message = await promptMessage();
    const twoX = buttonsOf(message)[1]!.payload;

    expect(await press(twoX)).toBe("Ответ принят: ×2");

    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: ["×2"] } } });
    await waitFor(() => (message.keyboard === undefined ? true : undefined), "the buttons to go");
    expect(message.text.endsWith("\n\n✅ Ответ: ×2")).toBe(true);
    // A second press from a client that still shows the button finds it closed.
    expect(await press(twoX)).toBe("Этот вопрос уже закрыт");
  });

  it("the same through the outbound path (normalizePayload → sendPayload)", async () => {
    const answer = ask([UPSCALE], { outbound: true });
    const message = await promptMessage();
    expect(message.text).toContain("1. Оставить - 1024×1024, как есть");
    await press(buttonsOf(message)[2]!.payload);
    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: ["×4"] } } });
    await waitFor(() => (message.text.includes("✅") ? true : undefined), "the outcome line");
    expect(message.keyboard).toBeUndefined();
  });

  it("someone else cannot press it", async () => {
    const answer = ask([UPSCALE]);
    const message = await promptMessage();
    expect(await press(buttonsOf(message)[1]!.payload, 777)).toBe(
      "Ответить на этот вопрос может только тот, кому он задан",
    );
    expect(message.keyboard).toBeDefined();
    await press(buttonsOf(message)[1]!.payload);
    await answer;
  });

  it("a typed '2' is claimed by the core as the second option", async () => {
    const answer = ask([UPSCALE]);
    const message = await promptMessage();

    expect(await sdk!.harness.claimPendingAgentQuestionAnswer({ sessionKey: SESSION, text: "2" })).toBe(true);

    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: ["×2"] } } });
    await waitFor(() => (message.keyboard === undefined ? true : undefined), "the buttons to go");
    expect(message.text.endsWith("\n\n✅ Ответ: ×2")).toBe(true);
  });

  it("'Свой вариант', then a typed answer: the free text reaches the model, the chat shows no echo", async () => {
    const answer = ask([UPSCALE]);
    const message = await promptMessage();

    expect(await press(buttonsOf(message)[3]!.payload)).toBe("Напишите свой вариант ответа сообщением");
    expect(chat.messages.at(-1)!.text).toBe("✍️ Напишите свой вариант ответа одним сообщением.");

    const typed = "3000 пикселей по длинной стороне";
    expect(await sdk!.harness.claimPendingAgentQuestionAnswer({ sessionKey: SESSION, text: typed })).toBe(true);
    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: [typed] } } });
    await waitFor(() => (message.keyboard === undefined ? true : undefined), "the buttons to go");
    // The core never echoes free text into the status line: it may be private.
    expect(message.text.endsWith("\n\n✅ Ответ получен")).toBe(true);
    expect(message.text).not.toContain(typed);
  });

  it("silence: the question expires, the message says so and loses its buttons", async () => {
    const answer = ask([UPSCALE], { timeoutMs: 120 });
    const message = await promptMessage();
    expect(message.keyboard).toBeDefined();

    expect(await answer).toEqual({ status: "expired" });
    await waitFor(() => (message.keyboard === undefined ? true : undefined), "the buttons to go");
    expect(message.text.endsWith("\n\n⌛ Время на ответ вышло")).toBe(true);
    // A press that was already on its way finds it closed.
    expect(await press(JSON.stringify({ ocq: [...gateway.store.keys()][0], i: 0 }))).toBe(
      "Этот вопрос уже закрыт",
    );
  });

  it("several questions at once stay text-only and are answered by typed lines", async () => {
    const color = {
      id: "color",
      header: "Фон",
      question: "Какой фон?",
      isOther: false,
      isSecret: false,
      multiSelect: false,
      options: [{ label: "Белый" }, { label: "Прозрачный" }],
    };
    const answer = ask([UPSCALE, color]);
    const message = await promptMessage();
    expect(message.keyboard).toBeUndefined();
    expect(message.text).toContain("1. Апскейл");
    expect(message.text).toContain("2. Фон");

    expect(
      await sdk!.harness.claimPendingAgentQuestionAnswer({ sessionKey: SESSION, text: "×4\nПрозрачный" }),
    ).toBe(true);
    expect(await answer).toEqual({
      status: "answered",
      answers: { answers: { size: ["×4"], color: ["Прозрачный"] } },
    });
    await waitFor(() => (message.text.includes("✅") ? true : undefined), "the outcome line");
    expect(message.text.endsWith("\n\n✅ Ответ: ×4, Прозрачный")).toBe(true);
  });

  it("multi-select stays text-only; a comma list picks several", async () => {
    const answer = ask([{ ...UPSCALE, multiSelect: true, isOther: false }]);
    const message = await promptMessage();
    expect(message.keyboard).toBeUndefined();
    expect(await sdk!.harness.claimPendingAgentQuestionAnswer({ sessionKey: SESSION, text: "1, 3" })).toBe(true);
    expect(await answer).toEqual({
      status: "answered",
      answers: { answers: { size: ["Оставить", "×4"] } },
    });
  });

  it("a secret question is plain text with no question id: VK sends it as an ordinary message", async () => {
    const answer = ask([{ ...UPSCALE, isSecret: true, options: [] }], { timeoutMs: 5_000 });
    const message = await promptMessage();
    expect(message.keyboard).toBeUndefined();
    expect(sdk!.question.readVkAskUserQuestionId(deliveredPayloads[0])).toBeUndefined();
    expect(await sdk!.harness.claimPendingAgentQuestionAnswer({ sessionKey: SESSION, text: "s3cret" })).toBe(true);
    expect(await answer).toMatchObject({ status: "answered" });
  });

  // ── Typed answers taken by the plugin (ask_user over MCP never reaches the
  //    core's own claim while the run holds the session) ─────────────────────

  it("a typed «2» taken by the plugin answers the second option; the core's claim then finds nothing", async () => {
    const answer = ask([UPSCALE]);
    const message = await promptMessage();

    expect(await type("2")).toBe(true);

    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: ["×2"] } } });
    await waitFor(() => (message.keyboard === undefined ? true : undefined), "the buttons to go");
    expect(message.text.endsWith("\n\n✅ Ответ: ×2")).toBe(true);
    // No double answer: were the same text to reach the core, it has no
    // pending question left to claim it for.
    expect(await sdk!.harness.claimPendingAgentQuestionAnswer({ sessionKey: SESSION, text: "2" })).toBe(false);
    // And the plugin no longer takes «2» in this chat.
    expect(await type("2")).toBe(false);
  });

  it("'Свой вариант', then free text: the plugin takes it as the answer", async () => {
    const answer = ask([UPSCALE]);
    const message = await promptMessage();
    await press(buttonsOf(message)[3]!.payload);

    expect(await type("3000 пикселей")).toBe(true);
    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: ["3000 пикселей"] } } });
  });

  it("a question without options takes any typed text", async () => {
    const answer = ask([{ ...UPSCALE, isOther: false, options: [] }]);
    const message = await promptMessage();
    expect(message.keyboard).toBeUndefined();

    expect(await type("до пятницы")).toBe(true);
    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: ["до пятницы"] } } });
  });

  it("fixed options: a stray message is not an answer and stays an ordinary message", async () => {
    const answer = ask([{ ...UPSCALE, isOther: false }]);
    await promptMessage();
    expect(await type("а зачем это?")).toBe(false);
    expect(await type("оставить")).toBe(true);
    expect(await answer).toEqual({ status: "answered", answers: { answers: { size: ["Оставить"] } } });
  });

  it("someone else's typed answer is not taken", async () => {
    const answer = ask([UPSCALE]);
    await promptMessage();
    expect(await type("2", 777)).toBe(false);
    expect(await type("2")).toBe(true);
    await answer;
  });

  it("several questions: the plugin leaves the text to the core, which parses the lines", async () => {
    const color = {
      id: "color",
      header: "Фон",
      question: "Какой фон?",
      isOther: false,
      isSecret: false,
      multiSelect: false,
      options: [{ label: "Белый" }, { label: "Прозрачный" }],
    };
    const answer = ask([UPSCALE, color]);
    await promptMessage();
    expect(await type("×4\nПрозрачный")).toBe(false);
    expect(
      await sdk!.harness.claimPendingAgentQuestionAnswer({ sessionKey: SESSION, text: "×4\nПрозрачный" }),
    ).toBe(true);
    expect(await answer).toMatchObject({ status: "answered" });
  });
});
