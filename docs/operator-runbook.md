# Operator Runbook — Everything You Do By Hand

This is the single, in-order checklist of every manual step required to
get this bot fully running in production. Nothing here is optional
unless explicitly marked **(optional)**. Steps that touch the same
external service are grouped together so you aren't bouncing between
docs mid-setup.

Each step says **where** to do it (Supabase dashboard, Render dashboard,
Telegram/Discord/etc, or "your own terminal") so it's clear what's a
click-through UI action versus a command you run locally.

---

## Phase 0 — accounts you need before starting
- A Supabase account (free tier) — https://supabase.com
- A Render account (free tier) — https://render.com
- A Telegram account, to talk to @BotFather
- A Discord account with access to the Discord Developer Portal
- (Optional) A Groq account — https://console.groq.com
- (Optional) A Notion account — https://notion.so
- (Optional) A Meta for Developers account, only if you intend to
  complete WhatsApp Business verification later — this is a slow,
  identity-bound process, not a quick step

---

## Phase 1 — Supabase project (your data store)

**Where: Supabase dashboard**

1. Create a new Supabase project.
2. Open the **SQL Editor** and run the entire contents of
   `supabase/schema.sql` top to bottom. This creates every table, RLS
   policy, and the two Postgres functions (`search_notes_for_account`,
   `accounts_due_for_digest`) the bot depends on.
3. Go to **Storage** → create a bucket named exactly `user-attachments`
   and set it to **private** (not public).
4. Go to **Project Settings → API** and copy down:
   - the **Project URL** → this becomes `SUPABASE_URL`
   - the **service_role key** (NOT the anon/public key) → this becomes
     `SUPABASE_SERVICE_ROLE_KEY`. Treat this like a root password —
     never commit it, never paste it anywhere but your `.env`/Render's
     environment settings.

Leave this Supabase dashboard tab open — you'll come back in Phase 6 to
set up the two cron jobs, which need your live Render URL first.

---

## Phase 2 — Telegram bot

**Where: Telegram app, talking to @BotFather**

1. Open a chat with **@BotFather** in Telegram.
2. Send `/newbot`, follow the prompts (name, username).
3. BotFather gives you a token that looks like `123456:ABC-DEF...` →
   this becomes `TELEGRAM_BOT_TOKEN`.
4. You invent `TELEGRAM_WEBHOOK_SECRET` yourself right now — any random
   32+ character string. **Where: your own terminal:**
   ```bash
   openssl rand -hex 32
   ```
   Save that value; you'll put it in your `.env` in Phase 5.

You'll come back after deploying (Phase 7) to actually register the
webhook URL with Telegram — that step needs your live Render URL first.

---

## Phase 3 — Discord application

**Where: Discord Developer Portal — https://discord.com/developers/applications**

1. **New Application**, give it a name.
2. Under **General Information**, copy the **Application ID** →
   `DISCORD_APP_ID`, and the **Public Key** → `DISCORD_PUBLIC_KEY`.
3. Under **Bot**, click **Reset Token** (or **Add Bot** if you haven't
   yet) and copy the token → `DISCORD_BOT_TOKEN`.
4. Leave the **Interactions Endpoint URL** field blank for now — you'll
   fill it in after deploying (Phase 7), because Discord immediately
   test-pings whatever URL you enter, and your server isn't live yet.

---

## Phase 4 — (Optional) Groq — natural-language AI + voice transcription

**Where: https://console.groq.com**

1. Sign up, go to **API Keys**, create a new key → `GROQ_API_KEY`.
2. That's it on Groq's side. Nothing else to configure there.

Reminder: setting this key does **not** turn AI on for any user by
itself — each account must separately send `ai on` in chat. See
`docs/ai-integration.md` for the full security model.

## Phase 4a — (Optional) Jina — real semantic search

**Where: https://jina.ai/embeddings**

1. Sign up, grab a free API key → `JINA_API_KEY`.
2. **Before enabling this, read the license note in
   `docs/ai-integration.md`** — Jina's free-tier embedding models are
   CC-BY-NC (non-commercial use only) as of when this was written. Fine
   for a personal deployment; confirm current terms with Jina (or swap
   in a different embeddings provider) before running this commercially
   or for other people as a paid service.
3. Requires the `vector` (pgvector) Postgres extension, already enabled
   by `supabase/schema.sql` if you ran the full file in Phase 1.
4. Like Groq, this alone does not turn anything on for any user — note
   embedding is gated behind the same per-account `ai on` opt-in.

---

## Phase 5 — Write your `.env` (or Render environment variables)

**Where: your own terminal / text editor, or Render's dashboard later**

1. Copy `.env.example` to `.env`.
2. Fill in every value you collected in Phases 1–4.
3. Generate the one remaining secret:
   ```bash
   openssl rand -hex 32
   ```
   → this becomes `INTERNAL_CRON_SECRET` (used by the reminder and
   digest cron jobs in Phase 6 — you'll paste this same value into
   Supabase's SQL editor).
4. Leave every `WHATSAPP_*` and `NOTION_*` variable blank for now unless
   you're doing those optional setups (Phases 8–9) — the bot runs
   correctly with them empty; those adapters self-disable safely rather
   than half-working.

**Never commit this file.** It's already in `.gitignore`.

---

## Phase 6 — Deploy to Render

**Where: Render dashboard**

Two ways to build the service — pick one. Both produce the exact same
running server; only the build mechanism differs.

### Option A — native Node buildpack (no Docker knowledge needed)
1. Push this repo to GitHub (Render deploys from a Git repo, not a
   local upload).
2. **New → Web Service** → connect your GitHub repo.
3. Build command: `npm install && npm run build`
4. Start command: `npm start`

### Option B — build from the included Dockerfile
1. Same first step: push to GitHub, **New → Web Service** → connect repo.
2. Render auto-detects the `Dockerfile` at the repo root and offers to
   build from it (or explicitly select "Docker" as the environment) —
   no build/start command fields needed, since the Dockerfile already
   specifies both.
3. See `docs/docker.md` for what's actually inside the image and the
   one real native-dependency risk (chart rendering) this project has
   in a container, and how it's handled.

### Either way
5. Go to the **Environment** tab and add every variable from your
   `.env` file (this is how secrets actually reach the running server —
   your local `.env` file itself never gets deployed, and with Docker,
   `.dockerignore` also ensures `.env` is never baked into the image).
6. Deploy. Once live, copy your service's URL (e.g.
   `https://your-app.onrender.com`) — this is your `PUBLIC_BASE_URL`.
   Add it as an environment variable too, and redeploy if you added it
   after the first deploy.

---

## Phase 7 — Wire up the webhooks (now that you have a live URL)

### 7a. Telegram — **Where: your own terminal**
```bash
npm run set:telegram-webhook
```
This registers `${PUBLIC_BASE_URL}/telegram/webhook` with Telegram,
including your `TELEGRAM_WEBHOOK_SECRET`. Run it locally with the same
`.env` values you deployed (or export them in your shell first).

### 7b. Discord — **Where: Discord Developer Portal, then your terminal**
1. Go back to your application → **General Information** → set
   **Interactions Endpoint URL** to
   `${PUBLIC_BASE_URL}/discord/interactions`. Discord immediately
   test-pings this — it should succeed now that the server is live.
2. Register the slash commands:
   ```bash
   npm run register:discord-commands
   ```
   Global commands can take up to an hour to show up in Discord's UI.

### 7c. Supabase cron jobs — **Where: Supabase SQL Editor**
1. Open `supabase/schema.sql` again, scroll to the bottom.
2. Uncomment the first `cron.schedule(...)` block
   (`dispatch-reminders-every-minute`). Replace the placeholder URL with
   `${PUBLIC_BASE_URL}/internal/cron/dispatch` and the placeholder
   secret with your real `INTERNAL_CRON_SECRET`. Run it.
3. Uncomment the second `cron.schedule(...)` block
   (`dispatch-daily-digest-every-15-minutes`). Same substitution, but
   pointed at `${PUBLIC_BASE_URL}/internal/cron/digest`. Run it.

At this point the bot is fully functional on Telegram + Discord with
notes, tasks, reminders (recurring + timezone-aware), daily digest,
snooze/undo, and charts. Everything below is optional.

---

## Phase 8 — (Recommended) UptimeRobot keep-alive

**Where: https://uptimerobot.com**

1. Sign up (free plan).
2. **Add New Monitor** → type **HTTP(s)** → URL:
   `${PUBLIC_BASE_URL}/keepalive` → interval: 5 minutes (free tier
   default).
3. Save. Nothing to configure on the bot's side — `/keepalive` already
   exists and is excluded from request logging.

This does not affect reminder/digest correctness (that's driven by
Supabase pg_cron regardless); it only reduces cold-start latency on the
*next* chat message after the dyno's been idle. See README for the
full trade-off (instance-hour budget).

---

## Phase 9 — (Optional) WhatsApp

**Where: Meta for Developers dashboard**

This is a slow, identity-verification-bound process only you (the
business owner) can complete — it cannot be scripted or shortcut.

1. Create a Meta Business app with the WhatsApp product added.
2. Complete Meta's Business verification for your account.
3. From the app dashboard, collect:
   - `WHATSAPP_APP_SECRET`
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
4. Invent `WHATSAPP_VERIFY_TOKEN` yourself (any random string) — you'll
   enter this exact value into Meta's webhook setup UI in step 6.
5. Add all four values to your Render environment variables, redeploy.
6. In the Meta dashboard's Webhooks configuration, set the callback URL
   to `${PUBLIC_BASE_URL}/whatsapp/webhook` and the verify token to the
   value you invented in step 4. Meta will immediately GET-verify this
   URL — it should succeed now that the server has the matching token.
7. Subscribe to the `messages` webhook field.

Until all four `WHATSAPP_*` variables are set, the adapter safely
returns `503` rather than accepting unverified traffic — nothing breaks
by skipping this phase.

---

## Phase 10 — (Optional) Notion two-way sync

This is the most involved optional setup — a full OAuth app plus a
webhook subscription. Full details, including *why* it's built this
way, are in `docs/notion-sync.md`. Short version of the manual steps:

**Where: https://www.notion.so/my-integrations**
1. Create a **public** integration (not internal).
2. Enable Read/Update/Insert content capabilities.
3. Under **Distribution**, submit the required info (company name,
   privacy policy URL, terms of use URL) — required for anyone other
   than you to use it; this is Notion's own review process.
4. Copy the OAuth **client ID** and **client secret** →
   `NOTION_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_SECRET`.
5. Set the integration's **redirect URI** to exactly
   `${PUBLIC_BASE_URL}/oauth/notion/callback`.
6. **Where: your own terminal:** generate the encryption key:
   ```bash
   openssl rand -hex 32
   ```
   → `NOTION_TOKEN_ENCRYPTION_KEY`.
7. Add these to Render, redeploy.
8. Back in the integration dashboard's **Webhooks** tab, create a
   subscription pointed at `${PUBLIC_BASE_URL}/webhooks/notion`,
   subscribed to `page.updated`. Notion POSTs a one-time
   `verification_token` — find it in your Render logs
   (`notion_verification_challenge_received`), paste it into Notion's
   UI, click **Verify**.
9. Once verified, Notion shows a `signing_secret` — set that as
   `NOTION_WEBHOOK_SECRET`, redeploy one more time.

Per-user setup after that point (each person sends `notion connect` in
chat, approves access in their browser, then `notion database <id>`) is
documented in `docs/notion-sync.md` and requires no further action from
you as the operator.

---

## Quick reference: which env vars come from where

| Variable | Source |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
| `INTERNAL_CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `NOTION_TOKEN_ENCRYPTION_KEY` | You generate these yourself (`openssl rand -hex 32`) |
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `PUBLIC_BASE_URL` | Your Render service's URL, after first deploy |
| `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` | Discord Developer Portal |
| `GROQ_API_KEY` | console.groq.com |
| `JINA_API_KEY` | jina.ai/embeddings (check the CC-BY-NC license note before enabling commercially) |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta for Developers dashboard |
| `WHATSAPP_VERIFY_TOKEN` | You invent this, then enter the same value into Meta's UI |
| `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` | notion.so/my-integrations |
| `NOTION_WEBHOOK_SECRET` | notion.so/my-integrations, shown only after verifying the webhook subscription |

Every other variable in `.env.example` has a sensible default and does
not require an external account.
