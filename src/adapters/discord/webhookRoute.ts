import { Router } from "express";
import { verifyDiscordInteraction } from "../../middleware/verifyDiscord.js";
import { handleCommand } from "../../router/commandHandler.js";
import { sendDiscordFollowup } from "./client.js";
import { env } from "../../config/env.js";
import { logError, logger } from "../../lib/logger.js";
import { checkRateLimit } from "../../middleware/rateLimit.js";

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const InteractionResponseType = { PONG: 1, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 } as const;

interface DiscordInteraction {
  type: number;
  token: string;
  member?: { user?: { id: string; username?: string } };
  user?: { id: string; username?: string };
  data?: {
    name: string;
    options?: Array<{ name: string; value: string }>;
  };
}

function optionsToCommandText(interaction: DiscordInteraction): string {
  const name = interaction.data?.name ?? "";
  const args = (interaction.data?.options ?? []).map((o) => o.value).join(" ");
  // Maps slash-command shape back into the same plain-text grammar the
  // shared commandHandler already understands, so business logic is
  // never duplicated per platform.
  switch (name) {
    case "note":
      return `note ${args}`;
    case "notes":
      return "notes";
    case "task":
      return `task ${args}`;
    case "tasks":
      return "tasks";
    case "done":
      return `done ${args}`;
    case "remind":
      return `remind me ${args}`;
    case "chart":
      return `chart ${args}`;
    case "link":
      return "link";
    case "connect":
      return `connect ${args}`;
    default:
      return "help";
  }
}

export const discordRouter = Router();

discordRouter.post("/interactions", verifyDiscordInteraction, async (req, res) => {
  const interaction = req.body as DiscordInteraction;

  if (interaction.type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
    return res.status(400).json({ error: "unsupported_interaction_type" });
  }

  // Defer immediately — DB + chart rendering can exceed Discord's 3s
  // initial-response window. We follow up asynchronously below.
  res.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const username = interaction.member?.user?.username ?? interaction.user?.username;

  if (!userId) {
    logger.warn({ context: "discordRouter" }, "missing_user_id_on_interaction");
    return;
  }

  try {
    if (!checkRateLimit(`discord:${userId}`, 20, 60_000)) {
      await sendDiscordFollowup(env.DISCORD_APP_ID, interaction.token, {
        content: "You're sending commands too quickly. Please slow down a bit.",
      });
      return;
    }

    const reply = await handleCommand({
      platform: "discord",
      platformUserId: userId,
      displayName: username,
      text: optionsToCommandText(interaction),
    });

    if (reply.kind === "text") {
      await sendDiscordFollowup(env.DISCORD_APP_ID, interaction.token, { content: reply.text });
    } else {
      await sendDiscordFollowup(env.DISCORD_APP_ID, interaction.token, {
        content: reply.caption,
        files: [{ name: "chart.png", buffer: reply.buffer }],
      });
    }
  } catch (err) {
    logError("discordRouter.interactions", err, { userId });
    await sendDiscordFollowup(env.DISCORD_APP_ID, interaction.token, {
      content: "Something went wrong handling that. Please try again.",
    }).catch(() => {});
  }
});
