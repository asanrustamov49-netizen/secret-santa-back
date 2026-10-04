-- =====================================================================
-- Secret Santa — 005_secret_santa_chat
-- Anonymous gift chat: a Secret Santa asks their recipient about the gift,
-- the recipient answers without ever learning who is asking.
-- Adds new objects only; nothing in 001–004 changes.
-- Run once in Supabase → SQL Editor (or psql), after 004_event_chat.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- secret_santa_chats — at most one chat per pair of the draw.
-- Giver and receiver are not copied here: they come from the match itself,
-- so a chat can never point at anyone the draw didn't pair. The row appears
-- with the Santa's first message; deleting the event (or an account) removes
-- the match, and the chat with it.
-- ---------------------------------------------------------------------

create table secret_santa_chats (
  id         uuid primary key default gen_random_uuid(),
  match_id   uuid not null unique references matches (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- secret_santa_messages — what the Santa and their recipient write.
-- author_id tells the API whose message it is (so a reply reaches the right
-- Santa). It never leaves the API: messages go out as "mine / not mine".
-- ---------------------------------------------------------------------

create table secret_santa_messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references secret_santa_chats (id) on delete cascade,
  author_id  uuid not null references users (id) on delete cascade,
  -- the API caps messages far lower (and trims them); this only stops absurd rows
  content    text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now(),
  -- when the other side read it; null = unread
  read_at    timestamptz
);

-- A chat's messages in order, newest first for paging (also covers the cascade from chats)
create index secret_santa_messages_chat_created_idx
  on secret_santa_messages (chat_id, created_at desc, id desc);
-- Unread counts: only the few unread rows are indexed
create index secret_santa_messages_unread_idx
  on secret_santa_messages (chat_id) where read_at is null;
-- the cascade from users
create index secret_santa_messages_author_idx on secret_santa_messages (author_id);

-- ---------------------------------------------------------------------
-- Row Level Security — same model as 001_init: on, with no policies, so
-- Supabase's public REST API (anon key) sees nothing. The NestJS backend
-- connects as postgres (bypasses RLS) and checks on every query that the
-- signed-in user is the giver or the receiver of the chat's match.
-- ---------------------------------------------------------------------

alter table secret_santa_chats    enable row level security;
alter table secret_santa_messages enable row level security;

commit;
