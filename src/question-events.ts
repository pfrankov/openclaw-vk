/**
 * A pressed question button (`message_event`) → the core's answer to the question.
 *
 * VK delivers a callback button press as `message_event` and keeps the button
 * spinning until the bot answers the event, so every press we recognise is
 * answered exactly once, with a snackbar saying what happened.
 *
 * Who may answer: in a direct chat only its other side — the question was put
 * to them — and only while the DM policy still admits them (`dmPolicy`,
 * `allowFrom`, the pairing store), as for an incoming message; in a group chat
 * only a sender the account's group allowlist admits, and in an open group
 * anyone in it. The check runs before the press is passed
 * on and again as the resolver's `authorize`, right before the answer is
 * written, so access lost in between cannot answer. Cores before 2026.9.5
 * ignore `authorize`; there only the check before the press is passed on holds.
 */
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { resolveVkAccount } from "./accounts.js";
import { resolveVkGroupAccess, resolveVkGroupSenderAdmission } from "./group-access.js";
import { redactVkId, vkDiag } from "./diagnostics.js";
import {
  isVkGroupPeerId,
  normalizeVkAllowlist,
  resolveVkAllowlistMatch,
} from "./send-support.js";
import {
  findOpenVkQuestionDelivery,
  findOpenVkQuestionForChat,
  loadVkQuestionRuntime,
  markVkQuestionNotTextAnswerable,
  markVkQuestionTerminal,
  parseVkQuestionCallback,
  parseVkQuestionTextAnswer,
} from "./question.js";
import { getVkRuntime, readVkRuntimeConfig } from "./runtime.js";
import { sendMessageVk } from "./send.js";
import type { CoreConfig } from "./types.js";

/** The part of vk-io's `MessageEventContext` this handler uses. */
export type VkQuestionEvent = {
  userId: number;
  peerId: number;
  eventPayload: unknown;
  answer: (eventData: { type: "show_snackbar"; text: string }) => Promise<unknown>;
};

const TEXT = {
  closed: "Этот вопрос уже закрыт",
  notYours: "Ответить на этот вопрос может только тот, кому он задан",
  answered: (label: string) => `Ответ принят: ${label}`,
  customInputSnackbar: "Напишите свой вариант ответа сообщением",
  customInputMessage: "✍️ Напишите свой вариант ответа одним сообщением.",
  failed: "Не получилось передать ответ. Ответьте текстом: номер варианта или свой ответ",
  // A group chat takes no typed answers (see `inbound.ts`), so nothing here
  // points to one.
  failedInGroup: "Не получилось передать ответ. Нажмите кнопку ещё раз",
  buttonsOnlyInGroup: "В беседе ответ принимается только кнопками",
} as const;

/** VK snackbar text limit. */
const SNACKBAR_MAX_CHARS = 90;

function snackbarText(text: string): string {
  const chars = Array.from(text);
  return chars.length <= SNACKBAR_MAX_CHARS ? text : `${chars.slice(0, SNACKBAR_MAX_CHARS - 1).join("")}…`;
}

/** Senders approved through pairing, read the way the inbound gate reads them. */
async function readVkDmStoreAllowFrom(accountId: string, dmPolicy: string): Promise<string[]> {
  const pairing = createChannelPairingController({
    core: getVkRuntime(),
    channel: "vk",
    accountId,
  });
  return await readStoreAllowFromForDmPolicy({
    provider: "vk",
    accountId,
    dmPolicy: dmPolicy as never,
    readStore: pairing.readStoreForDmPolicy,
  });
}

/** May `userId` answer a question delivered to `peerId`, under the current config? */
export async function isVkQuestionAnswerer(params: {
  config: CoreConfig;
  accountId: string;
  peerId: number;
  userId: number;
  /** Pairing-store allowlist; defaults to the core's pairing store. */
  readStoreAllowFrom?: (dmPolicy: string) => Promise<string[]>;
}): Promise<boolean> {
  const account = resolveVkAccount({ cfg: params.config, accountId: params.accountId });
  if (!isVkGroupPeerId(params.peerId)) {
    if (params.userId !== params.peerId) {
      return false;
    }
    // The same DM gate an incoming message passes: someone removed from the
    // allowlist while their question was pending does not answer it.
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      return false;
    }
    if (dmPolicy === "open") {
      return true;
    }
    let storeAllowFrom: string[] = [];
    try {
      storeAllowFrom = await (params.readStoreAllowFrom ??
        ((policy) => readVkDmStoreAllowFrom(params.accountId, policy)))(dmPolicy);
    } catch {
      // An unreadable store admits nobody extra; the config allowlist still counts.
    }
    const allowFrom = normalizeVkAllowlist([
      ...(account.config.allowFrom ?? []),
      ...storeAllowFrom,
    ]);
    return resolveVkAllowlistMatch({ allowFrom, senderId: params.userId }).allowed;
  }
  // The inbound gate's own calculation: inherited defaults, a disabled chat or
  // policy first, the allowlist only in "allowlist" mode.
  const access = resolveVkGroupAccess({
    config: params.config,
    account,
    peerId: params.peerId,
  });
  return resolveVkGroupSenderAdmission(access, params.userId).allowed;
}

/**
 * Handles one `message_event`. Returns false when the press is not a question
 * button, so the caller can leave it alone.
 */
export async function handleVkQuestionEvent(params: {
  event: VkQuestionEvent;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<boolean> {
  const { event, accountId, runtime } = params;
  const callback = parseVkQuestionCallback(event.eventPayload);
  if (!callback) {
    return false;
  }
  const { questionId } = callback;
  const reply = async (text: string): Promise<void> => {
    try {
      await event.answer({ type: "show_snackbar", text: snackbarText(text) });
    } catch (error) {
      runtime.log?.(`vk: question event answer failed: ${String(error)}`);
    }
  };
  const isOpenHere = () =>
    findOpenVkQuestionDelivery({ questionId, accountId, peerId: event.peerId }) !== undefined;
  const mayAnswer = async () =>
    isOpenHere() &&
    (await isVkQuestionAnswerer({
      config: readVkRuntimeConfig(getVkRuntime()),
      accountId,
      peerId: event.peerId,
      userId: event.userId,
    }));

  vkDiag("question button", {
    questionId,
    intent: callback.intent,
    peerId: event.peerId,
    userId: event.userId,
  });
  if (!isOpenHere()) {
    await reply(TEXT.closed);
    return true;
  }
  if (!(await mayAnswer())) {
    runtime.log?.(
      `vk: question ${questionId} press refused for user=${redactVkId(event.userId)} peer=${redactVkId(event.peerId)}`,
    );
    await reply(TEXT.notYours);
    return true;
  }
  const inGroup = isVkGroupPeerId(event.peerId);
  if (inGroup && callback.intent === "custom-input") {
    // Not offered in a group chat; a button left from an older keyboard must
    // not ask for a typed answer that would never be taken.
    await reply(TEXT.buttonsOnlyInGroup);
    return true;
  }
  const failedText = inGroup ? TEXT.failedInGroup : TEXT.failed;
  const questionRuntime = await loadVkQuestionRuntime();
  if (!questionRuntime) {
    await reply(failedText);
    return true;
  }

  const common = {
    cfg: readVkRuntimeConfig(getVkRuntime()) as OpenClawConfig,
    questionId,
    senderId: String(event.userId),
    clientDisplayName: `VK question (${event.userId})`,
    authorize: mayAnswer,
  };
  try {
    const result =
      callback.intent === "custom-input"
        ? await questionRuntime.resolveOption({ ...common, customInput: true })
        : await questionRuntime.resolveOption({ ...common, optionIndex: callback.optionIndex });
    vkDiag("question button resolved", { questionId, status: result.status });
    switch (result.status) {
      case "answered":
        await reply(TEXT.answered(result.optionValue));
        return true;
      case "custom-input":
        // The typed answer arrives as an ordinary message and is taken by
        // `answerVkQuestionByText` before it reaches the core. Buttons stay: a
        // person who changes their mind can still press one.
        await reply(TEXT.customInputSnackbar);
        try {
          await sendMessageVk(String(event.peerId), TEXT.customInputMessage, { accountId });
        } catch (error) {
          // The snackbar already asked for the answer; the hint is a courtesy.
          runtime.log?.(`vk: question ${questionId} custom-input hint failed: ${String(error)}`);
        }
        return true;
      case "denied":
        await reply(TEXT.notYours);
        return true;
      default:
        markVkQuestionTerminal(questionId);
        await reply(TEXT.closed);
        return true;
    }
  } catch (error) {
    runtime.error?.(`vk: question ${questionId} answer failed: ${String(error)}`);
    await reply(failedText);
    return true;
  }
}

/**
 * A typed message in a chat with an open question: the answer to it, if it is one.
 *
 * Returns true when the message answered the question — the caller then must
 * not pass it on as a turn or as steering: it has been consumed. False leaves
 * the message to the ordinary path: no open question here, the text is not an
 * answer by the core's rules (a stray word to a question with fixed options),
 * the sender may not answer, or the core refused it (already answered,
 * expired, a shape a typed answer cannot resolve).
 *
 * Needed because the core's own ingress claim misses `ask_user` over MCP: it
 * looks in the harness's pending questions, where only a native
 * `AskUserQuestion` lands, and a message sent during the run waits in the
 * session queue until the question has expired (24.09.2026, ask_2fb0d4be…).
 */
export async function answerVkQuestionByText(params: {
  accountId: string;
  peerId: number;
  senderId: number;
  text: string;
  runtime: RuntimeEnv;
}): Promise<boolean> {
  const { accountId, peerId, senderId, runtime } = params;
  const open = findOpenVkQuestionForChat({ accountId, peerId });
  if (!open) {
    return false;
  }
  const { questionId, prompt } = open;
  const answer = parseVkQuestionTextAnswer(prompt, params.text);
  if (answer === undefined) {
    vkDiag("question text not an answer", { questionId });
    return false;
  }
  const mayAnswer = async () =>
    findOpenVkQuestionDelivery({ questionId, accountId, peerId }) !== undefined &&
    (await isVkQuestionAnswerer({
      config: readVkRuntimeConfig(getVkRuntime()),
      accountId,
      peerId,
      userId: senderId,
    }));
  if (!(await mayAnswer())) {
    return false;
  }
  const questionRuntime = await loadVkQuestionRuntime();
  if (!questionRuntime) {
    return false;
  }
  try {
    // `optionValue` carries any non-empty answer to the record as it is: a
    // declared label, or the person's own text where the question allows it.
    const result = await questionRuntime.resolveOption({
      cfg: readVkRuntimeConfig(getVkRuntime()) as OpenClawConfig,
      questionId,
      senderId: String(senderId),
      clientDisplayName: `VK question (${senderId})`,
      optionValue: answer,
      authorize: mayAnswer,
    });
    vkDiag("question text resolved", { questionId, status: result.status });
    if (result.status === "answered") {
      return true;
    }
    if (result.status === "already-terminal") {
      markVkQuestionTerminal(questionId);
    }
    return false;
  } catch (error) {
    // The resolver refuses records a single answer cannot settle (several
    // questions, multi-select, a secret) before writing anything: stop trying
    // for this one. Any other failure — a timeout, a busy gateway — is not a
    // property of the question, so the next answer is tried again. Either way
    // the message goes on as usual.
    if (/one tappable question/.test(String(error))) {
      markVkQuestionNotTextAnswerable(questionId);
    }
    runtime.log?.(`vk: question ${questionId} typed answer not accepted: ${String(error)}`);
    return false;
  }
}
