# Feature Roadmap & AI Integration Plan

## Part 1 — Non-AI feature ideas (ordered by leverage vs. effort)

### Tier 1 — highest impact, fits current architecture cleanly
1. **Recurring reminders** ("remind me every Monday 9am to submit report").
   Currently `reminders.remind_at` is a single timestamp — add a `recurrence_rule`
   (simple enum: daily/weekly/monthly, or a cron string) and have the cron
   dispatcher re-insert the next occurrence after sending.
2. **Proactive daily/weekly digest** — instead of only replying when asked,
   have `pg_cron` trigger a `/internal/cron/digest` route every morning per
   user's own `timezone` (already a column on `accounts`), summarizing open
   tasks, notes added, and upcoming reminders. This is the single feature
   that most directly answers "make sure the user never misses anything" —
   right now the bot is purely reactive.
3. **Per-user timezone command** (`timezone Asia/Kolkata`) — the column
   exists in schema but there's no command to set it yet, so "remind me at
   9am" currently means UTC 9am, which is wrong for almost every real user.
4. **Snooze / undo** — `snooze <reminder-id> 1h`, `undo` (revert the last
   mutation). Cheap to build, disproportionately improves trust in a bot
   that manages your data.
5. **Voice note capture** — Telegram/WhatsApp voice messages transcribed to
   text, then run through the *same* command handler as typed text (no new
   business logic, just a new "input adapter").
6. **Real Notion sync (optional)** — since this is explicitly a "Notion
   replica," the highest-fidelity version isn't reinventing blocks, it's
   using the official Notion API as an optional two-way sync target per
   account (store a Notion integration token, encrypted, per account).

### Tier 2 — valuable, more effort
7. Photo/receipt capture with OCR → structured note.
8. Shared/team workspaces (multiple accounts can see one set of notes —
   needs a `workspace_id` layer and real permission checks, not just RLS).
9. Google/Outlook Calendar sync for tasks with due dates.
10. Web dashboard (Next.js) for browsing/editing — the bot stays the primary
    capture surface, the dashboard is for review, using real Supabase Auth
    sessions (which is also when the RLS policies already scaffolded in
    `schema.sql` start actually mattering).

---

## Part 2 — Where AI genuinely helps (and where it's just risk for no gain)

### Good fits
- **Natural-language command parsing.** Today `note`, `task`, `remind me ...
  in ...` require fairly rigid syntax. An LLM can turn free text like
  *"grab milk tomorrow after work and remind me around 6"* into a structured
  `{intent: "create_reminder", message, remindAt}` object. This is the
  single biggest UX upgrade for a "personal assistant" bot.
- **Semantic search over notes** ("find that note about the Q3 budget" even
  if it doesn't contain those exact words) — via embeddings stored in
  Supabase (`pgvector` extension), not a third-party vector DB.
- **Note/task summarization** — "summarize my notes tagged #work this week."
- **Auto-tagging** new notes instead of asking the user to type tags.

### Deliberately NOT recommended (for this project, at this stage)
- Letting an LLM directly write to the database via "function calling" with
  no intermediate validation. Every AI-proposed action still passes through
  the exact same Zod schemas as manual commands — the AI never gets a more
  trusted path than a human typing a command.
- Sending full note contents to a third-party LLM without your explicit
  sign-off — this is a real privacy decision, not just an engineering one
  (see below).

### Security & cost architecture for adding AI (non-negotiable if we do this)
1. **New isolated service, `src/services/aiService.ts`.** The LLM API key
   lives only in env config server-side, exactly like the Supabase key —
   never touches any adapter or client code.
2. **AI never mutates data directly.** It only returns a structured intent
   guess. That guess is re-validated through `createNoteSchema` /
   `createTaskSchema` / `createReminderSchema` before touching Supabase —
   same as today. Prompt injection in a user's message can at worst produce
   a malformed intent that validation rejects; it cannot smuggle a direct
   DB write.
3. **Hard fallback, not a hard dependency.** If the AI call times out,
   errors, or the provider is down, the bot falls back to the existing
   rule-based parser instead of leaving the user stuck — consistent with
   the "no silent crashes / graceful fallback" principle already in place.
4. **Per-account rate limiting on AI calls specifically** (reusing
   `checkRateLimit`), separate from the general chat rate limit — LLM calls
   cost real money per request, unlike Supabase's free tier, so a
   misbehaving or abusive user must not be able to run up a bill.
5. **Data privacy is a real, explicit trade-off.** Sending a user's note/
   task text to OpenAI/Anthropic/Google means that provider's data
   handling and retention policy now applies to your users' personal data.
   Options, roughly cheapest→most private:
   - Use a provider with a strict no-training/short-retention API policy
     (this is standard for API tiers, but always read the current terms).
   - Only send AI the specific message being parsed *right now*, never bulk
     personal history — never batch-upload someone's whole notes archive.
   - Offer AI parsing as **opt-in per account** (a `ai_enabled` boolean),
     defaulting OFF, so nothing leaves your Supabase project unless a user
     explicitly turns it on.
