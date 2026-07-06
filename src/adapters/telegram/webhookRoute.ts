import { Router } from "express";
import { verifyTelegramWebhook } from "../../middleware/verifyTelegram.js";
import { handleCommand } from "../../router/commandHandler.js";
import { sendTelegramMessage, sendTelegramPhoto, downloadTelegramFile } from "./client.js";
import { logError, logger } from "../../lib/logger.js";
import { checkRateLimit } from "../../middleware/rateLimit.js";
import { isGroqConfigured } from "../../config/env.js";
import { isAiEnabledForAccount, resolveOrCreateAccount } from "../../services/accountService.js";
import { transcribeAudio } from "../../services/aiService.js";

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    voice?: { file_id: string; mime_type?: string };
    audio?: { file_id: string; mime_type?: string };
  };
}

export const telegramRouter = Router();

telegramRouter.post("/webhook", verifyTelegramWebhook, async (req, res) => {
  // Acknowledge immediately — Telegram retries aggressively on timeout,
  // and our own work below should never block that ack.
  res.status(200).json({ ok: true });

  const update = req.body as TelegramUpdate;
  const message = update.message;
  const voiceFileId = message?.voice?.file_id ?? message?.audio?.file_id;
  if (!message?.from || (!message.text && !voiceFileId)) return;

  const chatId = message.chat.id;
  const platformUserId = String(message.from.id);
  const displayName = message.from.username ?? message.from.first_name;

  try {
    if (!checkRateLimit(`telegram:${platformUserId}`, 20, 60_000)) {
      await sendTelegramMessage(chatId, "You're sending messages too quickly. Please slow down a bit.");
      return;
    }

    let inputText: string | undefined = message.text;
    let resolvedAccountId: string | undefined;

    if (!inputText && voiceFileId) {
      const transcribed = await transcribeVoiceMessage(platformUserId, displayName, chatId, voiceFileId);
      if (transcribed === null) return; // a reply was already sent (or nothing to do)
      inputText = transcribed.text;
      resolvedAccountId = transcribed.accountId;
    }

    if (!inputText) return;

    const reply = await handleCommand({
      platform: "telegram",
      platformUserId,
      displayName,
      text: inputText,
      resolvedAccountId,
    });

    if (reply.kind === "text") {
      const delivered = await sendTelegramMessage(chatId, reply.text);
      if (!delivered) logger.warn({ context: "telegramRouter" }, "message_delivery_failed");
    } else {
      const delivered = await sendTelegramPhoto(chatId, reply.buffer, reply.caption);
      if (!delivered) logger.warn({ context: "telegramRouter" }, "photo_delivery_failed");
    }
  } catch (err) {
    logError("telegramRouter.webhook", err, { chatId });
    // Best-effort user-facing fallback; never let a failure here throw
    // past the response we already sent.
    await sendTelegramMessage(chatId, "Something went wrong handling that. Please try again.").catch(() => {});
  }
});

/**
 * Handles a voice/audio message: resolves the account, checks the same
 * two-layer AI opt-in gate used for text-based AI (server config +
 * per-account ai_enabled), downloads the audio from Telegram, and
 * transcribes it via Groq Whisper. Returns the transcribed text to be
 * run through the normal command pipeline, or null if a terminal reply
 * was already sent to the user (e.g. AI not enabled, download failed).
 */
async function transcribeVoiceMessage(
  platformUserId: string,
  displayName: string | undefined,
  chatId: number,
  fileId: string
): Promise<{ text: string; accountId: string } | null> {
  if (!isGroqConfigured) {
    await sendTelegramMessage(chatId, "Voice messages need AI features enabled on this server. Please type your message instead.");
    return null;
  }

  const accountResult = await resolveOrCreateAccount("telegram", platformUserId, displayName);
  if (!accountResult.ok) {
    await sendTelegramMessage(chatId, "Sorry — I couldn't reach your account storage. Please try again in a moment.");
    return null;
  }
  const accountId = accountResult.data.accountId;

  if (!(await isAiEnabledForAccount(accountId))) {
    await sendTelegramMessage(chatId, 'Voice messages require AI to be on for your account. Send "ai on" first, or type your message instead.');
    return null;
  }

  const audioBuffer = await downloadTelegramFile(fileId);
  if (!audioBuffer) {
    await sendTelegramMessage(chatId, "I couldn't download that voice message. Please try again or type it instead.");
    return null;
  }

  const transcription = await transcribeAudio(accountId, audioBuffer, "voice.ogg");
  if (!transcription.ok) {
    const reason =
      transcription.reason === "rate_limited"
        ? "You've sent a lot of voice messages recently — please try again in a bit, or type your message."
        : "I couldn't transcribe that voice message. Please try again or type it instead.";
    await sendTelegramMessage(chatId, reason);
    return null;
  }

  return { text: transcription.text, accountId };
}

