-- =====================================================================
-- Secret Santa — 002_ai
-- AI gift assistant: conversations and their messages.
-- Adds new objects only; nothing in 001_init changes. Run once in
-- Supabase → SQL Editor (or psql), after 001_init. PostgreSQL 15+.
-- =====================================================================

begin;

-- Who wrote a message. The model's system instructions are never stored.
create type ai_message_role as enum ('user', 'assistant');

-- ---------------------------------------------------------------------
-- ai_conversations — one chat about one Secret Santa event.
-- The event decides whose gift is being discussed: the API finds the
-- signed-in user's own recipient in it, never from the request.
-- ---------------------------------------------------------------------

create table ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  event_id   uuid not null references events (id) on delete cascade,
  -- first words of the first message; null until the first message is sent
  title      text check (title is null or char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "My conversations, most recent first"
create index ai_conversations_user_updated_idx on ai_conversations (user_id, updated_at desc);
-- the cascade from events
create index ai_conversations_event_idx on ai_conversations (event_id);

create trigger ai_conversations_set_updated_at
  before update on ai_conversations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- ai_messages — the history sent back to the model on the next turn
-- ---------------------------------------------------------------------

create table ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ai_conversations (id) on delete cascade,
  role            ai_message_role not null,
  -- the API caps user messages far lower; this only stops absurd rows
  content         text not null check (char_length(content) between 1 and 20000),
  created_at      timestamptz not null default now()
);

-- a conversation's messages in order (also covers the cascade)
create index ai_messages_conversation_created_idx on ai_messages (conversation_id, created_at, id);

-- ---------------------------------------------------------------------
-- Row Level Security — same model as 001_init: on, with no policies, so
-- Supabase's public REST API (anon key) sees nothing. The NestJS backend
-- connects as postgres (bypasses RLS) and checks ownership itself on every
-- query: a conversation is only ever read or written together with
-- "user_id = the signed-in user".
-- ---------------------------------------------------------------------

alter table ai_conversations enable row level security;
alter table ai_messages      enable row level security;

commit;
