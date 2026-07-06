import { supabaseAdmin } from "./supabase.js";
import { logger } from "./logger.js";
import { env } from "../config/env.js";

const SQL = `
create table if not exists public.conversation_history (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,
  role          text not null check (role in ('user', 'assistant')),
  text          text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_conversation_history_account
  on public.conversation_history (account_id, created_at desc);

alter table public.conversation_history enable row level security;
`;

export async function runMigrations(): Promise<void> {
  if (!env.SUPABASE_DB_URL) {
    logger.warn("SUPABASE_DB_URL not set — skipping startup migration");
    return;
  }

  let client: any;
  try {
    const { default: pg } = await import("pg");
    client = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
    await client.connect();
    await client.query(SQL);
    logger.info("Startup migration complete: conversation_history table ready");
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Startup migration failed — conversation_history may not exist");
  } finally {
    if (client) try { await client.end(); } catch {}
  }
}
