-- =====================================================================
-- Secret Santa — 006_event_chat_reads
-- "Read up to" for the event chat, kept by the API so unread badges are the
-- same on every device and come back after a reconnect.
-- Adds new objects only; nothing in 001–005 changes.
-- Run once in Supabase → SQL Editor (or psql), after 005_secret_santa_chat.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- event_chat_reads — one row per person per event chat they have opened.
-- Messages by others written after last_read_at are unread. No row yet =
-- everything others wrote is unread.
-- ---------------------------------------------------------------------

create table event_chat_reads (
  user_id      uuid not null references users (id) on delete cascade,
  event_id     uuid not null references events (id) on delete cascade,
  last_read_at timestamptz not null default now(),

  primary key (user_id, event_id)
);

-- the cascade from events
create index event_chat_reads_event_idx on event_chat_reads (event_id);

-- ---------------------------------------------------------------------
-- Row Level Security — same model as 001_init: on, with no policies.
-- ---------------------------------------------------------------------

alter table event_chat_reads enable row level security;

commit;
