-- =====================================================================
-- Secret Santa — 004_event_chat
-- Event chat: a group chat for the people in one event, open once names
-- are drawn. Adds new objects only; nothing in 001–003 changes.
-- Run once in Supabase → SQL Editor (or psql), after 003_ai_general.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- event_messages — what participants write to each other in an event.
-- Plain text only. It never holds anything about the draw: the API
-- stores exactly what a participant typed, and reads messages only for
-- people who are in the event.
-- ---------------------------------------------------------------------

create table event_messages (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references events (id) on delete cascade,
  -- the author; their messages go with their account
  user_id    uuid not null references users (id) on delete cascade,
  -- the API caps messages far lower (and trims them); this only stops absurd rows
  content    text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);

-- An event's messages in order, newest first for paging (also covers the cascade from events)
create index event_messages_event_created_idx on event_messages (event_id, created_at desc, id desc);
-- the cascade from users
create index event_messages_user_idx on event_messages (user_id);

-- ---------------------------------------------------------------------
-- Row Level Security — same model as 001_init: on, with no policies, so
-- Supabase's public REST API (anon key) sees nothing. The NestJS backend
-- connects as postgres (bypasses RLS) and checks on every query that the
-- signed-in user is a participant of the event.
-- ---------------------------------------------------------------------

alter table event_messages enable row level security;

commit;
