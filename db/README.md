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
    └── 006_event_chat_reads.sql ← event chat "read up to" (unread badges)
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
