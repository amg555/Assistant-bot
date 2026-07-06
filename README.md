# Notion-Bot Assistant

A multi-platform personal assistant (Telegram + Discord live, WhatsApp scaffolded)
that replicates a lightweight Notion — notes, tasks, reminders, and activity
charts — with per-user isolated storage in Supabase, deployable on Render's
free tier.

**➡ If you just want to get this running, skip straight to
[`docs/operator-runbook.md`](docs/operator-runbook.md)** — it's the
single, in-order checklist of every manual step (accounts to create,
buttons to click, commands to run) from zero to a fully working bot.
Everything below explains *why* it's built this way.

## Why it's built this way (read before deploying)

- **No client ever touches Supabase directly.** The bot server holds the only
  Supabase service-role key. Every mutation runs through a Zod-validated
  service function in `src/services/`.
- **Every inbound webhook is cryptographically verified** before it reaches
  business logic — Telegram (secret token), Discord (Ed25519 signature),
  WhatsApp (HMAC-SHA256), and our own cron endpoint (shared secret). See
  `src/middleware/`.
- **Reminders don't rely on Render staying awake.** Render's free tier
  suspends the service after ~15 minutes idle, which would silently kill any
  in-process timer. Instead, Supabase's `pg_cron` + `pg_net` calls
  `POST /internal/cron/dispatch` on a schedule from *outside* Render — that
  call itself wakes a sleeping instance. First delivery after a long idle
  period will have a ~20–50s cold-start delay; this is an explicit,
  documented trade-off of the free tier, not a bug.
- **One human, one data vault, many platforms.** `accounts` +
  `platform_identities` let a user link Telegram/Discord/WhatsApp to a single
  account via a one-time code (SHA-256 hashed at rest, never stored in
  plaintext, consumed once, expires in 10 minutes by default).
- **RLS is enabled on every table** as defense-in-depth for when a future
  web dashboard adds real Supabase Auth sessions, even though today only the
  trusted server (service role) reads/writes.
- **AI (Groq + optional Jina) is opt-in, twice over, and never gets write
  access.** A user must send `ai on` (default off), and even then Groq
  only ever sees the current message plus a few already-scoped note
  snippets — retrieved via real semantic (vector) search when Jina is
  configured, Postgres full-text search otherwise (see
  `docs/ai-integration.md`). A single message can describe multiple
  distinct items ("remind me X and also Y") and set recurrence via
  natural language; every action Groq proposes is still re-validated
  through the same Zod schemas as a manually typed command before
  touching the database, per item — it can never write directly. The
  daily digest can also optionally be rewritten into natural sentences
  by Groq, with a plain bullet-list fallback on any failure.
- **Reminders are timezone-correct and can recur.** `timezone <IANA name>`
  sets an account's real timezone (validated, DST-aware, using Node's
  built-in `Intl` — no extra dependency); `remind me <msg> at <time>
  [every day|week|month]` resolves clock times against that timezone and
  the cron dispatcher automatically reinserts the next occurrence after a
  successful delivery.
- **Voice notes work like typed text.** Telegram/WhatsApp voice messages
  are downloaded server-side, transcribed via Groq Whisper, and run
  through the identical command pipeline — gated by the same `ai_enabled`
  opt-in as every other AI feature.
- **Daily digest is proactive, not just reactive — and still opt-in.**
  `digest on [at <hour>]` schedules a once-daily summary (tasks due,
  reminders today, notes added) delivered via Telegram/WhatsApp at the
  account's own local hour. The eligibility check (which accounts are
  due right now, in their own timezone, and haven't already gotten
  today's digest) runs as a single Postgres function
  (`accounts_due_for_digest`) rather than pulling every account into
  application code — this is the feature that actually stops things
  from being missed, versus just answering when asked.
- **Snooze/undo build user trust, not just features.** `snooze <id>
  <duration>` pushes a reminder back; `undo` reverts the last note/task/
  reminder mutation (a short-TTL, per-account in-memory record — see
  `src/lib/undoStore.ts` — same honest single-instance limitation as the
  rate limiter).
- **Notion sync is a real OAuth integration, not a shortcut.** `notion
  connect` bridges the fact that a chat bot can't natively perform a
  browser redirect: the bot hands the user a one-time link (CSRF-
  protected via a hashed, single-use state token — same pattern as
  platform-linking codes), they approve access in their own browser,
  and the resulting access token is encrypted at rest with AES-256-GCM
  (`src/lib/tokenCrypto.ts`) — genuinely reversible, unlike the
  one-way-hashed codes elsewhere, because we must reuse it to call
  Notion's API later. Notion calls are throttled (not just rate-limited)
  to respect the shared 3 req/sec-per-integration ceiling across every
  connected workspace. Two-way sync includes a loop-guard so a bot
  write doesn't re-import itself via webhook forever. Full design in
  `docs/notion-sync.md`.

## Project layout

```
src/
  config/env.ts            Zod-validated environment loading (fail-fast at boot)
  lib/                      logger, supabase client, time parsing
  middleware/                signature verification, cron auth, rate limiting
  validation/schemas.ts      Zod schemas — the single source of truth for input shape
  services/                  DB/storage access, each function try/catch + typed result
  router/commandHandler.ts   platform-agnostic command logic (write business logic ONCE)
  adapters/telegram/          webhook route + Telegram Bot API client
  adapters/discord/            interactions route + Discord REST client
  adapters/whatsapp/           webhook route + Cloud API client (self-disables until configured)
  routes/cronDispatchRoute.ts  delivers due reminders, called only by Supabase pg_cron
  server.ts                   Express bootstrap: helmet, strict CORS, global error boundary
supabase/schema.sql           tables, RLS, storage policies, pg_cron job (commented, fill in values)
```

## Setup

**Full step-by-step instructions (every manual click and command, in the
correct order, including all optional integrations) are in
[`docs/operator-runbook.md`](docs/operator-runbook.md).** The summary
below exists just to show the shape of the process; follow the runbook
for the actual walkthrough.

1. Create a Supabase project, run `supabase/schema.sql`, create the
   `user-attachments` storage bucket.
2. Create a Telegram bot (@BotFather) and a Discord application.
3. Copy `.env.example` to `.env` and fill in what you've collected so far.
4. Deploy to Render (see below), then register the Telegram webhook and
   Discord slash commands against your live URL, and wire the two
   Supabase cron jobs (reminders + daily digest).
5. Optionally enable Groq (AI + voice), UptimeRobot (keep-alive),
   WhatsApp (requires Meta Business verification), and/or Notion sync
   (requires a public OAuth integration) — each is fully optional and
   the bot runs correctly with all of them left unconfigured.

## Deploying to Render (free tier)

1. Push this repo to GitHub.
2. New Web Service on Render → connect the repo.
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
3. Add every variable from `.env.example` in Render's Environment tab —
   never commit `.env`.
4. Once deployed, run the two one-off registration scripts locally
   (`npm run set:telegram-webhook`, `npm run register:discord-commands`)
   pointed at your live `PUBLIC_BASE_URL`.

See `docs/operator-runbook.md` for the full, correctly-ordered checklist
— the summary above skips the exact sequencing (e.g. some values can
only be generated after the first deploy).

## Docker (optional alternative to the buildpack above)

A `Dockerfile` is included for portability (Render can build from it
directly instead of its native buildpack, or you can run this anywhere
else that runs containers). Verified with a real `docker build` + a
running container during development — including confirming chart
rendering (a native-dependency risk in containers) actually produces
legible output, not just that the process boots. Full details, the
specific native-dependency risk this project has and how it's handled,
and deployment instructions are in
[`docs/docker.md`](docs/docker.md).

```bash
npm run docker:build
npm run docker:run   # reads your local .env
```

## Local development

```bash
npm install
cp .env.example .env   # fill in real values
npm run dev             # tsx watch mode
npm run typecheck
npm test                 # runs the automated test suite
```

## Testing

`npm test` runs an automated Vitest suite (93 tests) covering every pure
logic module — timezone/DST math, time parsing, recurrence, encryption,
the undo store, the Notion throttle, and every Zod validation schema.
**It does not test anything that talks to Supabase, Telegram, Discord,
WhatsApp, Groq, or Notion** — see
[`docs/testing.md`](docs/testing.md) for the full, honest breakdown of
what is and isn't covered, including a real bug the suite caught and
fixed during development (`nextOccurrenceOfClockTime` silently accepted
invalid hour+am/pm combinations like "15am").

## Dependency upgrade policy

Major-version bumps are applied deliberately, one at a time, only after
checking the actual changelog against this codebase's real usage
patterns — never via a blind `npm audit fix --force`. Current state:

- **express** (5.x), **helmet** (8.x), **pino**/**pino-http** (10.x/11.x),
  **zod** (4.x), **dotenv** (17.x) are all upgraded and verified: full
  typecheck, build, and live boot tests (including deliberately
  triggering a real async error to confirm the "generic message to
  caller, detailed log server-side" behavior still holds) pass on every
  one. Helmet 8 also gave us a real security improvement for free —
  `Strict-Transport-Security` max-age went from 180 to 365 days.
- **dotenv 17** changed its default to print an informational
  "N keys loaded" line on every boot. We load it explicitly with
  `{ quiet: true }` in `src/config/env.ts` instead of the side-effect
  `dotenv/config` import, to keep startup logs clean per this project's
  no-chatty-logs standard.
- **`@types/node` is deliberately held at the 20.x line**, not bumped to
  the "latest" 26.x — DefinitelyTyped intentionally version-locks
  `@types/node`'s major version to a real Node.js major version, and we
  target Node 20/22 LTS (matching Render's runtime), not a hypothetical
  future Node 26.
- **TypeScript is deliberately held at 5.x**, not upgraded to 6.x.
  TypeScript 6.0 is an explicit "bridge release" whose entire purpose is
  flipping several risky compiler defaults (`strict`, `module`,
  `types`) to prepare for TypeScript 7 (a from-scratch Go-native
  compiler) landing shortly after. Upgrading now means absorbing two
  disruptive migrations back to back for zero functional gain today;
  the plan is to skip straight to TypeScript 7 once it's stable.

## Known v1 limitations (documented, not hidden)

- Discord reminders and daily digests aren't delivered as unsolicited DMs
  (Discord's interaction webhook model doesn't support that without a bot
  Gateway connection, which the free Render tier can't sustain). Link a
  Telegram or WhatsApp identity to receive reminder/digest pings; use
  Discord for notes/tasks/charts.
- The daily digest fires at most once per local calendar day per account
  (tracked via `accounts.last_digest_sent_date`) — if delivery fails for
  every linked identity on a given day (e.g. no reachable platform), it is
  still marked as sent for that day rather than retried, to avoid retry
  noise every 15 minutes for the rest of the day. It will resume the next
  day automatically.
- WhatsApp chart delivery is text-only in v1 (image messages need a
  two-step media upload flow not yet implemented).
- Rate limiting is in-memory, correct for Render's single free instance;
  swap `src/middleware/rateLimit.ts` for a shared store if you ever scale to
  multiple instances.
- An UptimeRobot keep-alive ping (see setup step 7) reduces but does not
  eliminate cold starts — if Render itself has an outage or your monitor is
  paused, the very next request still pays the 30–60s wake-up cost. Reminder
  delivery timing is unaffected either way, since it's driven by Supabase
  pg_cron independently.
- Voice-note transcription only works on Telegram and WhatsApp; Discord
  bots don't receive voice-message attachments over the interactions
  webhook model.
- The AI natural-language fallback doesn't set recurrence — "remind me to
  stretch every day" via free text creates a one-time reminder today; use
  the explicit `remind me <msg> at <time> every day` syntax for recurring
  reminders until this is extended.
- Timezone is per-account, not per-message — if two people share one
  linked account (see `link`/`connect`) across different real timezones,
  clock-time reminders resolve against the single `accounts.timezone`
  value, not each linked identity individually.
- Notion sync covers notes only (not tasks/reminders), and only two
  properties ("Name" title, "Body" rich text) — see `docs/notion-sync.md`
  for the full list of v1 constraints and why OAuth (not a simpler
  pasted-token flow) was chosen despite the extra setup burden.
- The in-memory undo store and Notion outbound throttle share the same
  honest limitation as the existing rate limiter: correct for Render's
  single free-tier instance, would need a shared backing store if you
  ever scale to multiple instances.
