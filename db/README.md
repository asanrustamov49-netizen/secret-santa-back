# Database

Plain SQL, applied by hand. No ORM, no migration tool.

```
db/
└── migrations/
    ├── 001_init.sql   ← all tables, enums, indexes, triggers, RLS
    ├── 002_ai.sql     ← AI gift assistant: ai_conversations, ai_messages
    ├── 003_ai_general.sql ← general AI conversations (event_id nullable)
    ├── 004_event_chat.sql ← event chat: event_messages
    ├── 005_secret_santa_chat.sql ← anonymous Santa ↔ recipient chat
    ├── 006_event_chat_reads.sql ← event chat "read up to" (unread badges)
    ├── 007_auth_rate_limits.sql ← sign-in / sign-up counters (see below)
    └── 008_function_search_path.sql ← pins set_updated_at()'s search_path (security advisor)
```

## Apply on Supabase

1. Supabase dashboard → **SQL Editor** → **New query**.
2. Paste the whole `migrations/001_init.sql` and click **Run**.
   The file runs in a single transaction: either everything is created or nothing.
3. Check **Table Editor**: `users`, `wishlist_items`, `refresh_tokens`, `events`, `participants`, `matches`.

Future changes go into new files — `002_…sql`, `003_…sql` — run in order.
Never edit a file that has already been applied.

## Connect the backend

Supabase → **Connect** → copy a connection string into `backend/.env`:

```
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
DATABASE_SSL=true
```

- Use the **Session pooler** string (port 5432) for a long-running NestJS server.
- `DATABASE_SSL=true` is required for Supabase.

## Tables

| Table | What it holds |
|---|---|
| `users` | Account, profile interests, theme and notification preferences |
| `wishlist_items` | The user's wishlist — one per user, shared by all their events |
| `refresh_tokens` | Hashed refresh tokens (sessions), rotated on every refresh |
| `events` | A Secret Santa group: name, date, budget, status, invite code |
| `participants` | Who is in which event, and whether their profile is ready |
| `matches` | giver → receiver after the draw |
| `ai_conversations` | A user's AI gift-assistant chat about one event (002_ai) |
| `ai_messages` | The chat's user / assistant messages, sent back to the model as history (002_ai) |
| `event_messages` | The event chat: what participants write to each other once names are drawn (004_event_chat) |
| `secret_santa_chats` | One anonymous gift chat per pair of the draw, opened by the Santa's first message (005_secret_santa_chat) |
| `event_chat_reads` | When each person last read each event chat — unread counts for badges (006_event_chat_reads) |
| `secret_santa_messages` | Its messages; the author id never leaves the API — the recipient never learns who their Santa is (005_secret_santa_chat) |
| `auth_rate_limits` | Sign-in and sign-up request counters per fixed window, shared by every API instance — keyed hashes, never an IP address (007_auth_rate_limits) |

Rules the schema itself enforces:

- one participant row per user per event;
- a match never pairs someone with themselves, and giver and receiver must be in the same event;
- every giver gives once, every receiver receives once;
- `budget_min ≤ budget_max`;
- deleting a user or an event cascades to everything that belongs to it.

## Security

**Row Level Security is enabled on every table with no policies.** Supabase's public REST API
(the `anon` key) can therefore read nothing. The NestJS backend connects with the database
password (the `postgres` role), which bypasses RLS. All access control lives in the API —
for example, only the giver can ever read their own match; the event owner cannot see pairs.

## 007 — sign-in limits (`auth_rate_limits`)

**What it is for.** `POST /api/auth/login` and `POST /api/auth/register` run the password
hash, so they are limited per visitor. The counters live here, so every API instance shares
them. A visitor is the IP the Next.js proxy on Vercel signed (`CLIENT_IP_SIGNING_SECRET`,
see `backend/.env.example`); requests without a valid signature share one "unverified" counter.
Rows hold a keyed hash of the IP, never the address; the API deletes rows a day past their window.

**Order.** Without this table the API still lets people sign in — a forgotten migration
must not lock everyone out — but with **no per-visitor limits**, logging
`auth_rate_limits does not exist — apply db/migrations/007_auth_rate_limits.sql` every minute
(the per-email lockout and the password-hash queue still apply). Any other database error on
the count answers 503. So:

1. Run `007_auth_rate_limits.sql` (SQL Editor → paste the whole file → Run).
2. Then deploy the API version that uses it.

**Running it again is safe.** Objects are created only if missing, then the table is checked:
exactly the columns `bucket text`, `window_start timestamptz`, `hits integer default 0`
(all not null), primary key `(bucket, window_start)`, the `char_length(bucket) <= 128` check,
an index on `(window_start)`, RLS on, no policies. If a table of that name exists with any other
shape, the script stops with `auth_rate_limits exists but does not match 007: …` and rolls the
whole transaction back — nothing is changed. Look at that table before doing anything with it.

**Check it (read-only).** Each line should answer as noted:

```sql
select to_regclass('public.auth_rate_limits');                         -- auth_rate_limits
select relrowsecurity from pg_class where oid = 'public.auth_rate_limits'::regclass;  -- true
select count(*) from pg_policy where polrelid = 'public.auth_rate_limits'::regclass; -- 0
select indexname from pg_indexes where tablename = 'auth_rate_limits' order by 1;
  -- auth_rate_limits_pkey, auth_rate_limits_window_idx
```

Running the migration file again is itself the full check: it ends with `COMMIT` only if the
table matches.

After the API is deployed, `https://<frontend>/api/auth/client-ip-check` should answer
`{"signature":"valid"}` — the proxy and the API share the signing secret. And after a few
sign-ins, this shows which counters were used (no IPs in it):

```sql
select split_part(bucket, ':', 2) as kind, count(*), sum(hits)
from auth_rate_limits where window_start > now() - interval '1 hour'
group by 1;
-- kind "ip": signed per-visitor counters; only "unverified" means the signature never verifies
```

**Rolling back.** First put back an API version without the sign-in limits (one that has them
runs unlimited and logs errors without the table). Only then, if the table should go as well:
`drop table public.auth_rate_limits;` — it holds nothing but short-lived counters, so dropping it
loses no user data. Keeping it is harmless too.

## 008 — `set_updated_at()` search path

Fixes Supabase's **Function Search Path Mutable** advisor: the trigger function from 001 gets a
fixed, empty `search_path` (it only calls `now()`, which is always found in `pg_catalog`).
One `ALTER FUNCTION`, safe to run again, no effect on data or on the API — run it whenever,
after 007. Check: `select proconfig from pg_proc where proname = 'set_updated_at';` →
`{search_path=""}`.

The other advisor notices are expected and stay as they are: **RLS Enabled No Policy** on every
table is the model above (the public REST API must see nothing), and **Unindexed foreign keys**
on `matches` is covered in practice — `giver_id` and `receiver_id` each have a unique index.
