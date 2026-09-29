-- =====================================================================
-- Secret Santa — 001_init
-- Creates every table the app needs. Safe to read top to bottom.
-- Run once in Supabase → SQL Editor (or psql). PostgreSQL 15+.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

create type theme_preference as enum ('light', 'dark', 'system');

-- open      — people can still join
-- drawn     — pairs are assigned, reveal is possible
-- completed — gifts exchanged, event is archived
create type event_status as enum ('open', 'drawn', 'completed');

-- ready once the participant has filled in interests / wishlist
create type participant_status as enum ('pending', 'ready');

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------

create table users (
  id               uuid primary key default gen_random_uuid(),
  -- stored lower-cased by the API; the check keeps it that way
  email            text not null unique check (email = lower(email)),
  name             text not null check (char_length(name) between 2 and 60),
  -- null for accounts that sign in with Google only
  password_hash    text,
  google_id        text unique,
  avatar_url       text,

  -- shown to your Secret Santa: {"Football","Coffee"}
  interests        text[] not null default '{}',

  theme_preference theme_preference not null default 'system',
  notify_email     boolean not null default true,
  notify_reminders boolean not null default true,
  notify_invites   boolean not null default true,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- an account must be able to sign in somehow
  constraint users_has_login check (password_hash is not null or google_id is not null)
);

create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- wishlist_items — one wishlist per user, every event reads it from the profile
-- ---------------------------------------------------------------------

create table wishlist_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 120),
  -- approximate price in whole currency units (сом)
  price_approx integer check (price_approx >= 0),
  url          text,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index wishlist_items_user_position_idx on wishlist_items (user_id, position);

create trigger wishlist_items_set_updated_at
  before update on wishlist_items
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- refresh_tokens — opaque tokens stored as SHA-256 hashes, rotated on use
-- ---------------------------------------------------------------------

create table refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz not null default now()
);

create index refresh_tokens_user_idx on refresh_tokens (user_id);

-- ---------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------

create table events (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references users (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  description      text check (char_length(description) <= 500),
  event_date       date,

  budget_min       integer check (budget_min >= 0),
  budget_max       integer check (budget_max >= 0),
  currency         char(3) not null default 'KGS',
  max_participants integer check (max_participants between 3 and 500),

  status           event_status not null default 'open',
  -- public part of the invite link: /join/<invite_code>
  invite_code      text not null unique,
  drawn_at         timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint events_budget_range check (
    budget_min is null or budget_max is null or budget_min <= budget_max
  )
);

create index events_owner_idx on events (owner_id);

create trigger events_set_updated_at
  before update on events
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- participants — a user inside an event
-- ---------------------------------------------------------------------

create table participants (
  id        uuid primary key default gen_random_uuid(),
  event_id  uuid not null references events (id) on delete cascade,
  user_id   uuid not null references users (id) on delete cascade,
  status    participant_status not null default 'pending',
  joined_at timestamptz not null default now(),

  constraint participants_one_per_event unique (event_id, user_id),
  -- lets matches reference (participant, event) pairs — see below
  constraint participants_id_event_key unique (id, event_id)
);

create index participants_user_idx on participants (user_id);

-- ---------------------------------------------------------------------
-- matches — giver → receiver.
-- Only the giver may ever read their own row; not even the event owner
-- sees the pairs. The API enforces this, the schema keeps pairs valid.
-- ---------------------------------------------------------------------

create table matches (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events (id) on delete cascade,
  giver_id    uuid not null unique,
  receiver_id uuid not null unique,
  revealed_at timestamptz,
  created_at  timestamptz not null default now(),

  -- giver and receiver must belong to this very event
  constraint matches_giver_fk foreign key (giver_id, event_id)
    references participants (id, event_id) on delete cascade,
  constraint matches_receiver_fk foreign key (receiver_id, event_id)
    references participants (id, event_id) on delete cascade,
  -- nobody draws themselves
  constraint matches_not_self check (giver_id <> receiver_id)
);

create index matches_event_idx on matches (event_id);

-- ---------------------------------------------------------------------
-- Row Level Security
-- Supabase exposes the public schema through its REST API with the anon key.
-- RLS on + no policies = that API sees nothing. Our NestJS backend connects
-- with the database password (postgres role), which bypasses RLS.
-- ---------------------------------------------------------------------

alter table users          enable row level security;
alter table wishlist_items enable row level security;
alter table refresh_tokens enable row level security;
alter table events         enable row level security;
alter table participants   enable row level security;
alter table matches        enable row level security;

commit;
