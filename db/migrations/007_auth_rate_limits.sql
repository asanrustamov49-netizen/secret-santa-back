-- =====================================================================
-- Secret Santa — 007_auth_rate_limits
-- Request counters for sign-in and sign-up, shared by every API instance.
-- Adds new objects only; nothing in 001–006 changes.
-- Run in Supabase → SQL Editor (or psql), after 006_event_chat_reads.
-- Apply BEFORE deploying the API that uses it: without this table that API
-- runs /auth/login and /auth/register with no limits, logging an error.
--
-- Safe to run again: objects are created only if missing, and then the
-- table is checked against the shape the API needs. A table of that name
-- with any other shape is never taken as correct — the script stops with
-- an error, and the whole transaction (this run's changes included) rolls
-- back, leaving the database exactly as it was. See db/README.md.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- auth_rate_limits — one row per bucket per fixed time window.
-- bucket is e.g. "login:ip:<keyed hash>" or "register:unverified": never a
-- raw IP address. Rows older than a day are deleted by the API itself.
-- ---------------------------------------------------------------------

create table if not exists public.auth_rate_limits (
  bucket       text not null check (char_length(bucket) <= 128),
  window_start timestamptz not null,
  hits         integer not null default 0,

  primary key (bucket, window_start)
);

-- the API's cleanup of old windows
create index if not exists auth_rate_limits_window_idx
  on public.auth_rate_limits (window_start);

-- ---------------------------------------------------------------------
-- Row Level Security — same model as 001_init: on, with no policies.
-- ---------------------------------------------------------------------

alter table public.auth_rate_limits enable row level security;

-- ---------------------------------------------------------------------
-- Check the result — also when the table existed before this run.
-- ---------------------------------------------------------------------

do $$
declare
  t constant regclass := 'public.auth_rate_limits'::regclass;
  problems text[] := '{}';
  col record;
begin
  -- Exactly these three columns, with these types, all NOT NULL
  for col in
    select * from (values
      ('bucket', 'text'),
      ('window_start', 'timestamp with time zone'),
      ('hits', 'integer')
    ) as expected (name, type)
  loop
    if not exists (
      select 1 from pg_attribute a
      where a.attrelid = t and a.attname = col.name and not a.attisdropped
        and format_type(a.atttypid, a.atttypmod) = col.type and a.attnotnull
    ) then
      problems := problems || format('column %s must be %s not null', col.name, col.type);
    end if;
  end loop;

  if exists (
    select 1 from pg_attribute a
    where a.attrelid = t and a.attnum > 0 and not a.attisdropped
      and a.attname not in ('bucket', 'window_start', 'hits')
  ) then
    problems := problems || 'unexpected extra columns'::text;
  end if;

  -- hits starts at 0 (the API's upsert relies on it)
  if coalesce((
    select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = t and a.attname = 'hits'
  ), '') <> '0' then
    problems := problems || 'hits must default to 0'::text;
  end if;

  -- Primary key exactly (bucket, window_start): the upsert's ON CONFLICT target
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = t and c.contype = 'p'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(c.conkey) with ordinality as k (attnum, ord)
        join pg_attribute a on a.attrelid = t and a.attnum = k.attnum
      ) = array['bucket', 'window_start']
  ) then
    problems := problems || 'primary key must be (bucket, window_start)'::text;
  end if;

  -- The bucket length check
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = t and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~ 'char_length\(bucket\) <= 128'
  ) then
    problems := problems || 'check char_length(bucket) <= 128 is missing'::text;
  end if;

  -- An index whose only key is window_start (the cleanup's delete)
  if not exists (
    select 1 from pg_index i
    join pg_attribute a on a.attrelid = t and a.attnum = i.indkey[0]
    where i.indrelid = t and i.indnkeyatts = 1 and a.attname = 'window_start'
  ) then
    problems := problems || 'index on (window_start) is missing'::text;
  end if;

  -- RLS on and no policies: Supabase's public REST API must see nothing
  if not (select relrowsecurity from pg_class where oid = t) then
    problems := problems || 'row level security is off'::text;
  end if;
  if exists (select 1 from pg_policy where polrelid = t) then
    problems := problems || 'it has RLS policies (expected none)'::text;
  end if;

  if cardinality(problems) > 0 then
    raise exception 'auth_rate_limits exists but does not match 007: %. Nothing was changed.',
      array_to_string(problems, '; ')
      using hint = 'Inspect the table before deciding what to do with it (db/README.md).';
  end if;
end
$$;

commit;
