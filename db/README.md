# Database

Plain SQL, applied by hand. No ORM, no migration tool.

```
db/
└── migrations/
    ├── 001_init.sql   ← all tables, enums, indexes, triggers, RLS
    └── 002_ai.sql     ← AI gift assistant: ai_conversations, ai_messages
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
