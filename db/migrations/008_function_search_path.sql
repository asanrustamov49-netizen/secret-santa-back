-- =====================================================================
-- Secret Santa — 008_function_search_path
-- Pins the search_path of set_updated_at() (from 001_init), the fix for
-- Supabase's "Function Search Path Mutable" security advisor.
-- Changes one setting of one function; nothing else in 001–007 changes.
-- Run in Supabase → SQL Editor (or psql), after 007_auth_rate_limits.
-- Safe to run again: ALTER FUNCTION … SET just sets the same value.
-- =====================================================================

begin;

-- The function calls only now(), which lives in pg_catalog — always searched,
-- even with an empty search_path. Without a fixed path, a caller who controls
-- search_path could make a trigger resolve names to objects of their own.
alter function public.set_updated_at() set search_path = '';

commit;
