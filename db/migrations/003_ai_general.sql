-- =====================================================================
-- Secret Santa — 003_ai_general
-- General assistant conversations: a chat about the app itself, not tied
-- to any event. Changes one column; nothing else in 002_ai changes.
-- Run once in Supabase → SQL Editor (or psql), after 002_ai.
-- =====================================================================

begin;

-- null = a general conversation (no event, no recipient: the API never
-- builds a gift context for it). Non-null = a conversation about that
-- event, as before; ON DELETE CASCADE from events still applies.
alter table ai_conversations alter column event_id drop not null;

commit;
