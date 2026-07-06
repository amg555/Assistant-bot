# Testing — What's Actually Covered, and What Isn't

## Run it yourself
```bash
npm test              # runs the full suite once
npm run test:watch    # re-runs on file changes
npx vitest run --coverage   # includes a coverage report
```

## What this suite covers (93 tests, all passing, run 3x to confirm no flakiness)
Pure logic only — no network calls, no real credentials, nothing that
talks to Supabase/Telegram/Discord/WhatsApp/Groq/Notion:

- **`src/lib/timezone.ts`** — DST-correct wall-clock↔UTC conversion,
  clock-time resolution (including the 12am/12pm edge cases and invalid
  am/pm-hour combinations), local-hour/date-key computation across
  midnight boundaries.
- **`src/lib/parseWhen.ts`** — relative duration parsing ("2h", "10m"),
  the full `parseWhen` grammar (relative/clock/ISO), hour-of-day
  parsing, recurrence-phrase extraction, and the next-occurrence
  calculation for daily/weekly/monthly recurrence (including the
  end-of-month clamping case).
- **`src/lib/tokenCrypto.ts`** — AES-256-GCM encrypt/decrypt round-trip,
  confirms distinct ciphertext per call (random IV), and confirms
  tampering with either the ciphertext or the auth tag is rejected
  rather than silently decrypting to garbage.
- **`src/lib/undoStore.ts`** — record/take semantics, clear-on-read
  (no double-undo), per-account isolation, and TTL expiry using fake
  timers (deterministic, not dependent on real wall-clock delays).
- **`src/lib/notionThrottle.ts`** — confirms calls are serialized
  (not silently dropped/reordered) and that both successful results and
  thrown errors propagate correctly through the throttle wrapper.
- **`src/validation/schemas.ts`** — every Zod schema's accept/reject
  boundaries (100% statement and branch coverage).
- **`src/config/env.ts`** — the `isWhatsAppConfigured` /
  `isGroqConfigured` / `isNotionConfigured` fail-closed flags, in both
  their "not configured" and "fully configured" states, plus a
  regression test confirming a malformed encryption key still crashes
  the process at boot rather than silently starting with a broken key.

## A real bug this suite already caught
Writing `nextOccurrenceOfClockTime`'s tests surfaced a genuine bug: the
function accepted nonsensical inputs like `"15am"` or `"13pm"` (an hour
outside 1-12 combined with an am/pm suffix) instead of rejecting them,
because its range check didn't distinguish the 12-hour case from the
24-hour case the way the otherwise-equivalent `parseHourOfDay` in
`parseWhen.ts` already did correctly. Fixed and covered by a regression
test (`tests/lib/timezone.test.ts`, "rejects a 12-hour value paired with
am/pm outside the valid 1-12 range"). This is exactly the value of a
real suite over one-off manual test scripts: it's the kind of
inconsistency that's easy to introduce silently and easy to miss without
systematically testing every branch.

## What this suite deliberately does NOT cover, and why
- **Anything touching Supabase** (`src/services/*.ts`, `src/lib/
  supabase.ts`, `src/lib/deliverToAccount.ts`). These require either a
  real Postgres connection or a mocking layer elaborate enough to risk
  testing the mock instead of the real integration. **This is the
  single largest untested surface in the codebase** — the schema
  (`supabase/schema.sql`) has never been run against a real Supabase
  project by this suite, and no service function has ever executed a
  real query.
- **Telegram, Discord, WhatsApp adapters** — real signature verification
  has only ever been tested against self-generated signatures matching
  self-written verification code (internally consistent, but never
  validated against a real Telegram/Discord/Meta request).
- **Groq (`src/services/aiService.ts`)** — tool-calling intent
  extraction, RAG question-answering, and Whisper transcription have
  never been exercised against the real Groq API.
- **Notion (`src/services/notion*.ts`)** — OAuth exchange, page
  create/update, and property extraction were built from documentation,
  never run against a real Notion workspace.
- **Chart rendering (`src/services/chartService.ts`)** — never invoked
  in this suite; `chartjs-node-canvas` has native dependencies that can
  behave differently across environments, which is a real, unverified
  risk between this sandbox and Render's runtime.
- **`src/server.ts` and Express route wiring** — verified previously via
  manual `curl` against a locally-run instance with fake credentials
  (see conversation history), never via an automated integration test.
  A supertest-based route suite would be a reasonable next addition.

## The honest bottom line
This suite proves the *pure logic* is correct and guards against
regressions in it. It does **not** prove the bot works end-to-end
against real Telegram/Discord/WhatsApp/Groq/Notion/Supabase — that
requires either connecting real (even if free-tier) instances of those
services and testing against them directly, or a staging environment.
Treat "all tests pass" as "the math and validation are solid," not as
"the whole system has been proven to work."
