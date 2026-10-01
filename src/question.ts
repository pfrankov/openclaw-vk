/**
 * Questions from the core (`ask_user`, Claude's `AskUserQuestion`) as VK buttons.
 *
 * Since 2026.9.6 both tools hold the turn until somebody answers — 15 minutes by
 * default. The core hands the channel one payload per question: the prompt as
 * text, a portable `presentation` with one button per option (plus "Other…" when
 * a free answer is allowed) and `channelData.askUser.questionId`. A channel that
 * only prints the text leaves the person nothing to press, so the turn stands
 * until the question expires. That happened on 24.09.2026.
 *
 * What lives here is transport-free: reading the question out of a payload,
 * building the VK inline keyboard, parsing a pressed button, and remembering
 * where each question was delivered so a press can be checked against it. The
 * send path (`send.ts`) and the button handler (`question-events.ts`) use it.
 *
 * Typed answers are parsed here too (`parseVkQuestionTextAnswer`, the core's
 * rules) and resolved by `question-events.ts`. The core's own ingress claim
 * (`runReplyQuestionInput`) does not reach `ask_user` over MCP: it looks the
 * question up among the harness's pending questions, where only a native
 * `AskUserQuestion` lands, and a message sent while the run holds the session
 * waits in the queue until the question has expired (live, 24.09.2026).
 */
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { vkDiag } from "./diagnostics.js";

type QuestionGatewayRuntime =
  typeof import("openclaw/plugin-sdk/question-gateway-runtime").questionGatewayRuntime;

/** Gateway question record ids, as the core's resolver accepts them. */
const QUESTION_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

/** Key of our callback payload; short, the whole payload is capped at 255 bytes. */
export const VK_QUESTION_CALLBACK_KEY = "ocq";

/** Where `normalizePayload` leaves the buttons once it has taken the presentation away. */
export const VK_QUESTION_CHANNEL_DATA_KEY = "vkQuestion";

const MAX_BUTTON_LABEL_CHARS = 40;
/** VK: at most 10 buttons in an inline keyboard. ask_user allows 2–4 options. */
const MAX_OPTION_BUTTONS = 9;
const CUSTOM_INPUT_LABEL = "✍️ Свой вариант";

/** One question as the VK send path needs it. */
export type VkQuestionPrompt = {
  questionId: string;
  /**
   * Option labels in the Gateway's order: the button at index `i` resolves
   * option `i`. Empty when the question cannot be answered by one tap —
   * several questions at once, multi-select, a secret: those stay text-only.
   */
  options: string[];
  /** A free answer is allowed ("Other…"). */
  customInput: boolean;
};

export type VkQuestionCallback =
  | { questionId: string; intent: "select"; optionIndex: number }
  | { questionId: string; intent: "custom-input" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The core's `readAskUserQuestionId`, restated: detection must work on any core. */
export function readVkAskUserQuestionId(payload: unknown): string | undefined {
  const askUser = asRecord(asRecord(asRecord(payload)?.channelData)?.askUser);
  const questionId = askUser?.questionId;
  return typeof questionId === "string" && QUESTION_ID_PATTERN.test(questionId)
    ? questionId
    : undefined;
}

/**
 * Gateway option order carried next to the prompt. The presentation may be
 * reordered by adaptation; this list is not, so it wins when present — the same
 * rule the core's Telegram follows (`resolveAskUserQuestionOptionIndex`).
 */
function readGatewayOptionOrder(payload: unknown): string[] | undefined {
  const askUser = asRecord(asRecord(asRecord(payload)?.channelData)?.askUser);
  const values = askUser?.optionValues;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && value)) {
    return undefined;
  }
  return values as string[];
}

function readPresentationButtons(
  payload: unknown,
  questionId: string,
): { options: string[]; customInput: boolean } | undefined {
  const presentation = asRecord(asRecord(payload)?.presentation);
  const blocks = Array.isArray(presentation?.blocks) ? presentation.blocks : [];
  const buttonBlocks = blocks.map(asRecord).filter((block) => block?.type === "buttons");
  if (buttonBlocks.length !== 1) {
    return undefined;
  }
  const buttons = Array.isArray(buttonBlocks[0]?.buttons) ? buttonBlocks[0].buttons : [];
  const options: string[] = [];
  let customInput = false;
  for (const raw of buttons) {
    const action = asRecord(asRecord(raw)?.action);
    if (action?.type !== "question" || action.questionId !== questionId) {
      // "Open link" and anything else: the link is in the text already.
      continue;
    }
    if (action.intent === "custom-input") {
      customInput = true;
    } else if (typeof action.optionValue === "string" && action.optionValue) {
      options.push(action.optionValue);
    }
  }
  return options.length > 0 ? { options, customInput } : undefined;
}

function readRenderedButtons(payload: unknown): { options: string[]; customInput: boolean } | undefined {
  const rendered = asRecord(asRecord(asRecord(payload)?.channelData)?.[VK_QUESTION_CHANNEL_DATA_KEY]);
  const options = rendered?.options;
  if (!Array.isArray(options) || !options.every((option) => typeof option === "string" && option)) {
    return undefined;
  }
  return { options: options as string[], customInput: rendered?.customInput === true };
}

/**
 * The question in a payload, or undefined when the payload is not one.
 *
 * Buttons come from the presentation (a reply delivered by the dispatcher) or
 * from what `normalizeVkQuestionPayload` left in `channelData` (an outbound send
 * routed by the core). A question without tappable options still counts: it
 * gets no keyboard, but its message is finalized like any other.
 */
export function readVkQuestionPrompt(payload: unknown): VkQuestionPrompt | undefined {
  const questionId = readVkAskUserQuestionId(payload);
  if (!questionId) {
    return undefined;
  }
  const buttons = readRenderedButtons(payload) ?? readPresentationButtons(payload, questionId);
  if (!buttons || buttons.options.length > MAX_OPTION_BUTTONS) {
    return { questionId, options: [], customInput: false };
  }
  const gatewayOrder = readGatewayOptionOrder(payload);
  const ordered =
    gatewayOrder &&
    gatewayOrder.length === buttons.options.length &&
    buttons.options.every((option) => gatewayOrder.includes(option))
      ? gatewayOrder
      : buttons.options;
  return { questionId, options: [...ordered], customInput: buttons.customInput };
}

/**
 * Outbound `normalizePayload`: move a question's buttons out of the presentation.
 *
 * The core renders a presentation away before `sendPayload` unless the channel
 * renders it itself, and for a question it would keep only the fallback text.
 * `renderPresentation` would not do either: it receives the payload with the
 * fallback text already removed, so the header and the option descriptions
 * would be lost. Preparation calls `normalizePayload` first, with the whole
 * payload, so the buttons are taken there and the text stays as the core wrote
 * it. Idempotent: the core may call it twice on the same payload.
 */
export function normalizeVkQuestionPayload(payload: ReplyPayload): ReplyPayload {
  const questionId = readVkAskUserQuestionId(payload);
  // Only when the text is the presentation's fallback: then it already says
  // everything, and dropping the presentation loses nothing but the buttons.
  if (
    !questionId ||
    !payload.presentation ||
    payload.presentationTextMode !== "fallback" ||
    !payload.text?.trim()
  ) {
    return payload;
  }
  const buttons = readPresentationButtons(payload, questionId);
  const { presentation: _presentation, presentationTextMode: _mode, ...rest } = payload;
  return {
    ...rest,
    channelData: {
      ...payload.channelData,
      ...(buttons ? { [VK_QUESTION_CHANNEL_DATA_KEY]: buttons } : {}),
    },
  };
}

function truncateLabel(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length <= MAX_BUTTON_LABEL_CHARS
    ? chars.join("")
    : `${chars.slice(0, MAX_BUTTON_LABEL_CHARS - 1).join("")}…`;
}

/**
 * The core's closing line under a question prompt (`questionReplyGuidance` in
 * the core), one per question shape. Every one of them asks for a typed reply.
 */
const CORE_REPLY_GUIDANCE = new Set([
  "Reply by number or question id. Use a declared option where choices are fixed.",
  "Reply with your answer.",
  "Reply with comma-separated option numbers or text, or your own answer.",
  "Reply with the number, the option text, or your own answer.",
  "Reply with the number or option text.",
]);

/**
 * The prompt for a group chat, where a typed message is never taken as an
 * answer (see `inbound.ts`): without the core's closing line, which asks for
 * one. Only a paragraph that is exactly one of those lines goes; any other
 * text — a newer core's wording included — stays as it came.
 */
export function withoutVkQuestionReplyGuidance(text: string): string {
  const cut = text.lastIndexOf("\n\n");
  if (cut === -1 || !CORE_REPLY_GUIDANCE.has(text.slice(cut + 2).trim())) {
    return text;
  }
  return text.slice(0, cut).trimEnd();
}

/**
 * The keyboard a finished question is edited with: an empty inline one, so the
 * buttons go away explicitly. VK also drops them on an edit without `keyboard`
 * (checked live on 29.09.2026), but `messages.edit` does not promise that.
 */
export function buildVkQuestionKeyboardRemoval(): string {
  return JSON.stringify({ inline: true, buttons: [] });
}

/**
 * VK inline keyboard: one callback button per option, one per row — the labels
 * are sentences more often than words — and "Свой вариант" last. Undefined when
 * there is nothing to press.
 */
export function buildVkQuestionKeyboard(prompt: VkQuestionPrompt): string | undefined {
  if (prompt.options.length === 0) {
    return undefined;
  }
  type Button = {
    action: { type: "callback"; label: string; payload: string };
    color: "primary" | "secondary";
  };
  const rows: Button[][] = prompt.options.map((label, index) => [
    {
      action: {
        type: "callback",
        label: truncateLabel(label),
        payload: JSON.stringify({ [VK_QUESTION_CALLBACK_KEY]: prompt.questionId, i: index }),
      },
      color: "primary",
    },
  ]);
  if (prompt.customInput) {
    rows.push([
      {
        action: {
          type: "callback",
          label: CUSTOM_INPUT_LABEL,
          payload: JSON.stringify({ [VK_QUESTION_CALLBACK_KEY]: prompt.questionId, o: 1 }),
        },
        color: "secondary",
      },
    ]);
  }
  return JSON.stringify({ inline: true, buttons: rows });
}

/** A pressed question button, or null for anything else. */
export function parseVkQuestionCallback(payload: unknown): VkQuestionCallback | null {
  let record = asRecord(payload);
  if (!record && typeof payload === "string") {
    try {
      record = asRecord(JSON.parse(payload));
    } catch {
      return null;
    }
  }
  const questionId = record?.[VK_QUESTION_CALLBACK_KEY];
  if (typeof questionId !== "string" || !QUESTION_ID_PATTERN.test(questionId)) {
    return null;
  }
  if (record?.o === 1) {
    return { questionId, intent: "custom-input" };
  }
  const optionIndex = record?.i;
  return typeof optionIndex === "number" &&
    Number.isInteger(optionIndex) &&
    optionIndex >= 0 &&
    optionIndex < MAX_OPTION_BUTTONS
    ? { questionId, intent: "select", optionIndex }
    : null;
}

/**
 * The core's terminal status line in Russian.
 *
 * The set is closed (`formatQuestionTerminalStatusLine` plus the "Unavailable"
 * of a lost binding); anything else is shown as it came. "Answered: …" echoes
 * only declared option labels — the core drops free text there on purpose.
 */
export function formatVkQuestionStatusLine(statusLine: string): string {
  const trimmed = statusLine.trim();
  if (trimmed === "Expired") {
    return "⌛ Время на ответ вышло";
  }
  if (trimmed === "Cancelled") {
    return "✖️ Вопрос снят";
  }
  if (trimmed === "Answered") {
    return "✅ Ответ получен";
  }
  if (trimmed.startsWith("Answered: ")) {
    return `✅ Ответ: ${trimmed.slice("Answered: ".length)}`;
  }
  if (trimmed.startsWith("Unavailable")) {
    return "⚠️ Вопрос больше недоступен";
  }
  return trimmed;
}

// ── Where each question went ────────────────────────────────────────────────

export type VkQuestionDelivery = {
  accountId: string;
  peerId: number;
  messageId: number;
};

/** A day, as the core keeps a finished question's deliveries. */
const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;

type Entry = {
  deliveries: VkQuestionDelivery[];
  terminal: boolean;
  /** What a typed answer is checked against; absent → only buttons answer. */
  prompt?: VkQuestionPrompt;
  /** False once the core refused a typed answer for this record's shape. */
  textAnswerable: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const deliveries = new Map<string, Entry>();

export function rememberVkQuestionDelivery(
  questionId: string,
  delivery: VkQuestionDelivery,
  prompt?: VkQuestionPrompt,
): void {
  let entry = deliveries.get(questionId);
  if (!entry) {
    const timer = setTimeout(() => deliveries.delete(questionId), DELIVERY_RETENTION_MS);
    timer.unref?.();
    entry = { deliveries: [], terminal: false, textAnswerable: true, timer };
    deliveries.set(questionId, entry);
  }
  entry.prompt ??= prompt;
  entry.deliveries.push(delivery);
}

/** The core refused a typed answer for this question (several questions, multi-select). */
export function markVkQuestionNotTextAnswerable(questionId: string): void {
  const entry = deliveries.get(questionId);
  if (entry) {
    entry.textAnswerable = false;
  }
}

/**
 * The open question a typed message in this chat may answer: the latest one
 * delivered there, still open and still answerable by text.
 */
export function findOpenVkQuestionForChat(params: {
  accountId: string;
  peerId: number;
}): { questionId: string; prompt: VkQuestionPrompt } | undefined {
  let found: { questionId: string; prompt: VkQuestionPrompt } | undefined;
  for (const [questionId, entry] of deliveries) {
    if (
      !entry.terminal &&
      entry.textAnswerable &&
      entry.prompt &&
      entry.deliveries.some(
        (delivery) => delivery.accountId === params.accountId && delivery.peerId === params.peerId,
      )
    ) {
      found = { questionId, prompt: entry.prompt };
    }
  }
  return found;
}

/**
 * A typed reply as the answer it gives, by the core's rules
 * (`normalizeAgentHarnessUserInputAnswer`): a number 1..N picks that option,
 * an option's text (any case) picks it, and free text counts only when the
 * question has no options or allows its own answer. Otherwise undefined — the
 * message is not an answer and goes on as an ordinary message.
 */
export function parseVkQuestionTextAnswer(prompt: VkQuestionPrompt, text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const options = prompt.options;
  const indexed = /^\d+$/.test(trimmed) ? options[Number(trimmed) - 1] : undefined;
  if (indexed) {
    return indexed;
  }
  const exact = options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
  if (exact) {
    return exact;
  }
  if (options.length > 0 && !prompt.customInput) {
    return undefined;
  }
  return trimmed;
}

export function markVkQuestionTerminal(questionId: string): void {
  const entry = deliveries.get(questionId);
  if (entry) {
    entry.terminal = true;
  }
}

/** The delivery a press came from: same account and chat, question still open. */
export function findOpenVkQuestionDelivery(params: {
  questionId: string;
  accountId: string;
  peerId: number;
}): VkQuestionDelivery | undefined {
  const entry = deliveries.get(params.questionId);
  if (!entry || entry.terminal) {
    return undefined;
  }
  return entry.deliveries.find(
    (delivery) => delivery.accountId === params.accountId && delivery.peerId === params.peerId,
  );
}

export function clearVkQuestionDeliveries(): void {
  for (const entry of deliveries.values()) {
    clearTimeout(entry.timer);
  }
  deliveries.clear();
}

// ── Step drafts that a question must move ────────────────────────────────────

/**
 * What a live turn does with its step draft when a question lands in its chat.
 *
 * A question reaches VK two ways: through the turn's own reply dispatcher
 * (`AskUserQuestion`), or as an outbound send routed by the core (`ask_user`
 * over MCP — the production path, which never passes the dispatcher). Either
 * way the draft of the turn waiting on the question must get out of its way:
 * otherwise later steps keep redrawing it above the question and the final
 * answer is edited into it, above the question it follows (24.09.2026,
 * `edited INTO final msgId=10417` over question 10418). So the turn registers
 * its handoff here, and the question send calls it, whichever path it came by.
 */
type VkDraftHandoff = () => Promise<void>;

const draftHandoffs = new Map<string, Set<VkDraftHandoff>>();

function draftKey(accountId: string, peerId: number | string): string {
  return `${accountId}:${peerId}`;
}

/** Registers a live turn's handoff for its chat; returns the unregister call. */
export function registerVkDraftQuestionHandoff(
  target: { accountId: string; peerId: number | string },
  handoff: VkDraftHandoff,
): () => void {
  const key = draftKey(target.accountId, target.peerId);
  let set = draftHandoffs.get(key);
  if (!set) {
    set = new Set();
    draftHandoffs.set(key, set);
  }
  set.add(handoff);
  return () => {
    const current = draftHandoffs.get(key);
    current?.delete(handoff);
    if (current?.size === 0) {
      draftHandoffs.delete(key);
    }
  };
}

/**
 * Before a question goes out: every live draft in that chat seals the answer it
 * holds and drops a bare step list. A failing handoff must not stop the
 * question — it is only logged.
 */
export async function handOffVkDraftsBeforeQuestion(target: {
  accountId: string;
  peerId: number | string;
}): Promise<void> {
  const handoffs = [...(draftHandoffs.get(draftKey(target.accountId, target.peerId)) ?? [])];
  for (const handoff of handoffs) {
    try {
      await handoff();
    } catch (error) {
      vkDiag("draft handoff before question failed", { reason: String(error) });
    }
  }
}

// ── The core's question runtime ─────────────────────────────────────────────

let runtimePromise: Promise<QuestionGatewayRuntime | undefined> | undefined;

/**
 * `plugin-sdk/question-gateway-runtime`, loaded on first use.
 *
 * Dynamic on purpose: the plugin still starts on cores that predate the
 * subpath (the peer range begins at 2026.8.1), and there a question simply goes
 * out as text, as it did before.
 */
export function loadVkQuestionRuntime(): Promise<QuestionGatewayRuntime | undefined> {
  runtimePromise ??= import("openclaw/plugin-sdk/question-gateway-runtime")
    .then((module) => module.questionGatewayRuntime)
    .catch((error: unknown) => {
      vkDiag("question runtime unavailable", { reason: String(error) });
      return undefined;
    });
  return runtimePromise;
}

/** Forget the loaded runtime; with `preset`, pretend the load gave that instead. */
export function resetVkQuestionRuntimeForTest(preset?: { runtime: QuestionGatewayRuntime | undefined }): void {
  runtimePromise = preset ? Promise.resolve(preset.runtime) : undefined;
}
