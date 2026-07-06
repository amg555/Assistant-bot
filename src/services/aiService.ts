import Groq, { toFile } from "groq-sdk";
import { env, isGroqConfigured } from "../config/env.js";
import { logError, logger } from "../lib/logger.js";
import { checkRateLimit } from "../middleware/rateLimit.js";
import { retrieveRelevantNotes } from "./ragService.js";
import type { RecurrenceRule } from "../lib/parseWhen.js";
import {
  createNoteSchema,
  createTaskSchema,
  createReminderSchema,
  safeValidate,
} from "../validation/schemas.js";

/**
 * SECURITY BOUNDARY — read before touching this file.
 * ---------------------------------------------------------------------
 * 1. Groq NEVER receives direct database access. It only ever sees:
 *      (a) the user's current message text, and
 *      (b) a handful of already-retrieved, already-account-scoped note
 *          snippets (from ragService, which enforces scoping in SQL).
 *    It never receives another user's data, a bulk export, or raw table
 *    contents.
 * 2. Groq NEVER mutates anything directly. Every "action" it proposes
 *    comes back as a tool_call with JSON arguments, which is then
 *    re-validated through the EXACT SAME Zod schemas used for manually
 *    typed commands (src/validation/schemas.ts) before it ever reaches
 *    a service function. A prompt-injected or hallucinated tool call can
 *    at worst fail validation — it cannot bypass it.
 * 3. This entire layer is opt-in twice over: the server must have
 *    GROQ_API_KEY configured (isGroqConfigured), AND the account must
 *    have explicitly run "ai on" (checked by the caller before invoking
 *    anything here). Neither check lives only here — commandHandler
 *    enforces the account-level gate so this file can't be reached
 *    accidentally from a new call site later.
 */

const groqClient = isGroqConfigured ? new Groq({ apiKey: env.GROQ_API_KEY }) : null;

export type AiIntent =
  | { type: "create_note"; title: string; body: string }
  | { type: "create_task"; title: string; dueAt?: string }
  | { type: "create_reminder"; message: string; remindAt: string; recurrence: RecurrenceRule }
  | { type: "answer_question"; answer: string }
  | { type: "chat"; text: string }
  | { type: "unrecognized" };

/**
 * intents is always a non-empty array — even a single-item request
 * (e.g. "remind me to call mom") comes back as a one-element array, so
 * every call site handles the "one or many" cases identically instead
 * of needing separate single-intent and multi-intent code paths.
 */
export type AiResult =
  | { ok: true; intents: AiIntent[] }
  | { ok: false; reason: "not_configured" | "rate_limited" | "provider_error" };

const TOOLS: Groq.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Save a note when the user wants to write something down for later.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the note" },
          body: { type: "string", description: "The note content" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Add a to-do item when the user wants to track something they need to do.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "What needs to be done" },
          dueAtIso: {
            type: "string",
            description: "ISO-8601 due date/time if the user mentioned one, otherwise omit",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Schedule a reminder when the user wants to be reminded of something at a specific future time.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "What to remind the user about" },
          remindAtIso: { type: "string", description: "ISO-8601 timestamp of when to send the reminder" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "monthly"],
            description: "If the user said 'every day'/'every week'/'every month', use that value; otherwise 'none' for a one-time reminder.",
          },
        },
        required: ["message", "remindAtIso"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_question",
      description:
        "Answer a question the user asked about their own notes/tasks, using ONLY the provided context snippets. If the context doesn't contain the answer, say so honestly instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          answer: { type: "string", description: "A concise, direct answer grounded in the given context" },
        },
        required: ["answer"],
      },
    },
  },
];

const SYSTEM_PROMPT = [
  "You are a friendly personal assistant. The user can talk to you naturally.",
  "",
  "If the user wants to save a note, create a task, set a reminder, or ask about their notes — use the appropriate tool.",
  "If the user is just chatting, asking a general question, or greeting you — respond conversationally without using a tool.",
  "You can mix tools and conversation in a single response (e.g., create a note AND reply with a friendly message).",
  "",
  "For reminders: set recurrence to 'daily'/'weekly'/'monthly' if the user said 'every day'/'every week'/'every month' or equivalent; otherwise use 'none'.",
  "Never invent facts. If you don't know something, say so.",
  "Times must be resolved to real ISO-8601 timestamps using the provided current time as the reference point.",
].join("\n");

/** Converts free-form user text into a structured intent via Groq
 * tool-calling. Optionally includes RAG context snippets (already
 * scoped to the caller's own account) for question-answering. Never
 * throws — all failure paths return a typed AiResult so callers always
 * have a safe, explicit fallback branch. */
export async function interpretMessage(
  accountId: string,
  message: string,
  nowIso: string,
  contextSnippets: string[] = [],
  history: { role: "user" | "assistant"; text: string }[] = []
): Promise<AiResult> {
  if (!groqClient) {
    return { ok: false, reason: "not_configured" };
  }

  if (!checkRateLimit(`groq:${accountId}`, env.GROQ_MAX_CALLS_PER_HOUR, 60 * 60 * 1000)) {
    logger.warn({ context: "interpretMessage", accountId }, "groq_rate_limit_exceeded");
    return { ok: false, reason: "rate_limited" };
  }

  try {
    const contextBlock =
      contextSnippets.length > 0
        ? `\n\nRelevant notes for this user (use only if answering a question):\n${contextSnippets
            .map((s, i) => `[${i + 1}] ${s}`)
            .join("\n")}`
        : "";

    const historyMessages = history.map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.text,
    }));

    const completion = await groqClient.chat.completions.create({
      model: env.GROQ_MODEL,
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\nCurrent time (ISO-8601): ${nowIso}${contextBlock}` },
        ...historyMessages,
        { role: "user", content: message },
      ],
      tools: TOOLS,
      parallel_tool_calls: true,
      temperature: 0.7,
      max_tokens: 800,
    });

    const responseMessage = completion.choices[0]?.message;
    const textContent = responseMessage?.content?.trim() ?? "";
    const toolCalls = responseMessage?.tool_calls ?? [];
    const functionCalls = toolCalls.filter(
      (call): call is Groq.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } =>
        call.type === "function"
    );

    const intents: AiIntent[] = [];

    if (functionCalls.length > 0) {
      intents.push(...functionCalls.map((call) => parseToolCall(call.function.name, call.function.arguments)));
    }

    if (textContent) {
      intents.push({ type: "chat", text: textContent });
    }

    if (intents.length === 0) {
      intents.push({ type: "unrecognized" });
    }

    return { ok: true, intents };
  } catch (err) {
    logError("interpretMessage", err, { accountId });
    return { ok: false, reason: "provider_error" };
  }
}

function parseToolCall(name: string, rawArgs: string): AiIntent {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return { type: "unrecognized" };
  }

  switch (name) {
    case "create_note": {
      const validation = safeValidate(createNoteSchema, {
        title: String(args.title ?? ""),
        body: String(args.body ?? ""),
        tags: [],
      });
      if (!validation.ok) return { type: "unrecognized" };
      return { type: "create_note", title: validation.data.title, body: validation.data.body };
    }
    case "create_task": {
      const validation = safeValidate(createTaskSchema, {
        title: String(args.title ?? ""),
        dueAt: args.dueAtIso ? new Date(String(args.dueAtIso)) : undefined,
        priority: "normal",
      });
      if (!validation.ok) return { type: "unrecognized" };
      return {
        type: "create_task",
        title: validation.data.title,
        dueAt: validation.data.dueAt?.toISOString(),
      };
    }
    case "create_reminder": {
      const rawRecurrence = String(args.recurrence ?? "none");
      const recurrence: RecurrenceRule = ["none", "daily", "weekly", "monthly"].includes(rawRecurrence)
        ? (rawRecurrence as RecurrenceRule)
        : "none";

      const validation = safeValidate(createReminderSchema, {
        message: String(args.message ?? ""),
        remindAt: args.remindAtIso ? new Date(String(args.remindAtIso)) : undefined,
        recurrence,
      });
      if (!validation.ok) return { type: "unrecognized" };
      return {
        type: "create_reminder",
        message: validation.data.message,
        remindAt: validation.data.remindAt.toISOString(),
        recurrence: validation.data.recurrence,
      };
    }
    case "answer_question": {
      const answer = String(args.answer ?? "").trim();
      if (!answer) return { type: "unrecognized" };
      return { type: "answer_question", answer: answer.slice(0, 2000) };
    }
    default:
      return { type: "unrecognized" };
  }
}

export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; reason: "not_configured" | "rate_limited" | "provider_error" | "empty_result" };

/**
 * Transcribes a voice message via Groq's Whisper endpoint. Subject to
 * the exact same two-layer opt-in gate as text-based AI features
 * (server GROQ_API_KEY + per-account ai_enabled) — a user's voice audio
 * is at least as sensitive as their typed text, so it must never leave
 * this server without the same explicit consent. Callers (the Telegram/
 * WhatsApp voice-note handlers) are responsible for checking
 * isAiEnabledForAccount before calling this — this function does not
 * re-check it itself, mirroring interpretMessage's contract, so there is
 * exactly one place (commandHandler) that owns the opt-in decision.
 */
export async function transcribeAudio(accountId: string, audioBuffer: Buffer, filename: string): Promise<TranscriptionResult> {
  if (!groqClient) {
    return { ok: false, reason: "not_configured" };
  }

  if (!checkRateLimit(`groq-audio:${accountId}`, env.GROQ_MAX_CALLS_PER_HOUR, 60 * 60 * 1000)) {
    logger.warn({ context: "transcribeAudio", accountId }, "groq_rate_limit_exceeded");
    return { ok: false, reason: "rate_limited" };
  }

  try {
    const file = await toFile(audioBuffer, filename);
    const transcription = await groqClient.audio.transcriptions.create({
      model: "whisper-large-v3-turbo",
      file,
      response_format: "text",
    });

    const text = typeof transcription === "string" ? transcription : transcription.text;
    const trimmed = (text ?? "").trim();
    if (!trimmed) return { ok: false, reason: "empty_result" };

    return { ok: true, text: trimmed };
  } catch (err) {
    logError("transcribeAudio", err, { accountId });
    return { ok: false, reason: "provider_error" };
  }
}

/** Convenience wrapper used by the question-answering command path:
 * retrieves account-scoped context via RAG, then asks Groq to answer
 * grounded only in that context. */
export async function answerQuestionWithRag(accountId: string, question: string): Promise<AiResult> {
  const retrieval = await retrieveRelevantNotes(accountId, question, 5);
  const snippets = retrieval.ok ? retrieval.data.map((n) => `${n.title}: ${n.body}`) : [];
  return interpretMessage(accountId, question, new Date().toISOString(), snippets);
}

export type SummaryResult = { ok: true; summary: string } | { ok: false; reason: "not_configured" | "rate_limited" | "provider_error" };

/**
 * Turns the raw bullet-point digest content into a short, natural
 * paragraph. Deliberately a SEPARATE, narrowly-scoped call from
 * interpretMessage — it never uses tool-calling (there is nothing to
 * "do" here, only text to write) and its system prompt forbids adding
 * any information beyond what's given, since the whole point is
 * accurate rephrasing, not new content generation.
 *
 * Callers (digestDispatchRoute) MUST check isAiEnabledForAccount before
 * calling this, mirroring transcribeAudio's contract — this function
 * does not re-check it itself, so there remains exactly one place that
 * owns the opt-in decision.
 */
export async function summarizeDigest(accountId: string, rawDigestText: string): Promise<SummaryResult> {
  if (!groqClient) {
    return { ok: false, reason: "not_configured" };
  }

  // Distinct rate-limit key from interpretMessage/transcribeAudio so a
  // busy digest cycle (many accounts summarized back to back) can't
  // silently starve a user's own interactive "ask"/"ai on" usage of its
  // separate hourly budget, or vice versa.
  if (!checkRateLimit(`groq-digest:${accountId}`, env.GROQ_MAX_CALLS_PER_HOUR, 60 * 60 * 1000)) {
    logger.warn({ context: "summarizeDigest", accountId }, "groq_rate_limit_exceeded");
    return { ok: false, reason: "rate_limited" };
  }

  try {
    const completion = await groqClient.chat.completions.create({
      model: env.GROQ_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the following structured daily summary as 2-4 short, natural sentences a person would actually want to read first thing in the morning. " +
            "Do NOT invent, add, or infer any task, reminder, or note that isn't explicitly listed below. " +
            "Do NOT add encouragement, advice, or commentary beyond what's given. If the input says nothing is due, say that plainly and briefly.",
        },
        { role: "user", content: rawDigestText },
      ],
      temperature: 0.3,
      max_tokens: 220,
    });

    const summary = completion.choices[0]?.message?.content?.trim();
    if (!summary) return { ok: false, reason: "provider_error" };

    return { ok: true, summary };
  } catch (err) {
    logError("summarizeDigest", err, { accountId });
    return { ok: false, reason: "provider_error" };
  }
}
