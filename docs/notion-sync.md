# Notion Two-Way Sync — Design & Setup

## What this does
- `notion connect` — the bot gives a user a one-time link to their
  browser; they approve access to their own Notion workspace via OAuth.
- `notion database <id>` — the user chooses which Notion database new
  bot notes should sync into.
- Creating a note via the bot (`note ...`, or the AI natural-language
  path) pushes it to that Notion database automatically, best-effort.
- Editing the page directly in Notion flows back into the bot's note
  content via a webhook, within about a minute.
- `notion status` / `notion disconnect` — check or revoke the connection
  at any time; disconnecting deletes the stored (encrypted) access
  token immediately.

## Why OAuth instead of a pasted internal-integration token
A simpler v1 would have been "paste your own internal integration
token via chat," mirroring how account-linking codes already work in
this codebase. We built the full OAuth flow instead, which is a
materially bigger commitment:
- It requires **hosting a public HTTP redirect endpoint**
  (`/oauth/notion/callback`) — the one deliberately browser-facing route
  in an otherwise entirely server-to-server service.
- To distribute this to anyone other than yourself, Notion requires the
  integration to go through their **public integration review process**
  (company info, privacy policy URL, terms of use URL — see Notion's
  integration settings under "Distribution").
- Two-way sync additionally requires **webhook infrastructure** (see
  below), which internal-token integrations don't need at all.

If that overhead isn't worth it for your use case, the simpler
paste-a-token design is still a reasonable v2 fallback and would reuse
`notionConnectionService.ts`'s encryption/storage functions unchanged —
only the "how do we get the token" half would change.

## Why the rate limiter is a throttle, not a reject gate
Notion enforces an average of **3 requests/second per integration
token** — and because every connected user's workspace shares the same
one OAuth app (one integration token pair), that ceiling is shared
across every account combined, not per-account. `src/lib/
notionThrottle.ts` queues and delays calls to stay under a configurable
fraction of that limit (`NOTION_MAX_REQUESTS_PER_SECOND`, default 2)
rather than rejecting requests outright — we choose when to call
Notion, so the correct behavior is "wait your turn," never "fail the
user's note save because Notion is busy."

## Why tokens are encrypted, not hashed
Every other reusable secret pattern in this codebase (link codes, OAuth
CSRF state) is one-time and hashed at rest with SHA-256 — hashing is
correct there because we only ever need to *compare* them, never
recover the original value. A Notion access token is different: we must
be able to *use* it, repeatedly, to call the Notion API on the user's
behalf. That requires real, reversible encryption
(`src/lib/tokenCrypto.ts`, AES-256-GCM) with a server-held key
(`NOTION_TOKEN_ENCRYPTION_KEY`), decrypted only in memory, only for the
duration of a single request, and never logged or re-serialized.

## The loop-guard (why two-way sync doesn't sync forever)
When the bot pushes a note to Notion, that write itself triggers a
`page.updated` webhook back to us. Without a guard, we would re-import
our own write as if it were a new external change — forever. The fix:
`notes.notion_last_synced_edit` records the Notion `last_edited_time` we
last wrote ourselves. When an inbound webhook arrives, we fetch the
page's *current* `last_edited_time` and only apply the change if it's
strictly newer than what we last synced — anything else is recognized
as "this is the edit we just made" and skipped
(`handleInboundNotionPageEvent` in `notionSyncService.ts`).

## Idempotency (why duplicate webhook deliveries are safe)
Notion's own docs state webhook deliveries can be retried. Every event
carries an `id`; `notion_webhook_events` records each one we've
processed, and a duplicate delivery is recognized via a unique-key
violation and skipped rather than reprocessed.

## Setup (operator steps — done once, not per-user)
1. Go to https://www.notion.so/my-integrations, create a **public**
   integration (not internal — internal tokens can't do OAuth).
2. Under Capabilities, enable "Read content," "Update content," and
   "Insert content."
3. Under Distribution, fill in the required fields (company name,
   privacy policy URL, terms of use URL) and submit for the public
   integration to become usable outside your own workspace. This step
   is Notion's review process, not something this codebase can automate.
4. Copy the **OAuth client ID** and **client secret** into
   `NOTION_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_SECRET`.
5. In the integration's settings, set the **redirect URI** to exactly
   `${PUBLIC_BASE_URL}/oauth/notion/callback`.
6. Generate `NOTION_TOKEN_ENCRYPTION_KEY` with `openssl rand -hex 32`.
7. After deploying, go to the integration's **Webhooks** tab, create a
   subscription pointed at `${PUBLIC_BASE_URL}/webhooks/notion`,
   subscribe to `page.updated` (and optionally `page.content_updated`).
   Notion will POST a one-time `verification_token` to that URL — check
   your server logs (`notion_verification_challenge_received`), copy the
   token from Notion's dashboard confirmation UI, and click "Verify."
8. Set `NOTION_WEBHOOK_SECRET` to the `signing_secret` Notion shows you
   once the subscription is verified, and redeploy.

## Each user's setup (done per-account, via chat)
1. `notion connect` → open the returned link in a browser, approve
   access, choose which pages/databases to share with the integration.
2. In Notion, ensure the target database has a **"Name" title property**
   and a **"Body" rich text property** — that's the minimal schema this
   sync writes to/reads from (see `extractTitleAndBody` in
   `notionClient.ts`). Other properties on the database are left alone.
3. Find the database's id (the string of characters in its URL) and
   send `notion database <id>`.
4. From then on, `note ...` commands sync automatically. Editing the
   page in Notion updates the bot's copy within about a minute.

## Known v1 limitations (documented, not hidden)
- Only the "Name" and "Body" properties sync — tags, due dates, or any
  other Notion property on the row are not populated or read.
- Sync is notes-only; tasks and reminders do not sync to Notion in v1.
- If a user disconnects Notion (`notion disconnect`), previously-synced
  notes keep their `notion_page_id` stamped but nothing further syncs;
  reconnecting and re-running `notion database <id>` resumes syncing new
  notes, not retroactively.
- The rate-limiting throttle is in-memory and per-process, correct for
  Render's single free-tier instance; a multi-instance deployment would
  need a shared counter (e.g. a small Supabase-backed token bucket)
  since each instance would otherwise believe it has the full 3 req/sec
  budget to itself.
