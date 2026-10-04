// What the assistant knows about the app itself — written by us, never by users, so it
// goes into the system prompt as trusted reference. Describe only what the app really
// does (checked against the frontend and the API); no internals, no secrets. When a
// feature changes, change this text with it.

/** Where the user is: a fixed list of app pages, never a free-form path */
export const AI_PAGES = [
  'dashboard',
  'events',
  'event_new',
  'event',
  'event_santa',
  'my_santa',
  'profile',
  'settings',
  'ai',
] as const;
export type AiPage = (typeof AI_PAGES)[number];

/** The page as the model reads it: its address and name, matching the sections below */
export const PAGE_NAMES: Record<AiPage, string> = {
  dashboard: '/dashboard — Dashboard',
  events: '/events — My Events',
  event_new: '/events/new — Create event',
  event: '/events/:id — an event page',
  event_santa: '/events/:id/santa — My Secret Santa in one event',
  my_santa: '/my-santa — My Secret Santa (all events)',
  profile: '/profile — Profile',
  settings: '/settings — Settings',
  ai: '/ai — AI Assistant',
};

export const PRODUCT_KNOWLEDGE = `Secret Santa is a web app for gift exchanges. An organizer creates an event and shares one invite link; people join; the organizer draws names; each participant is secretly given one person to buy a gift for. Budgets and prices are in som (KGS).

PRIVACY
- Pairs are private: each participant sees only their own recipient. The organizer cannot see the pairs either.
- Your Secret Santa (the person giving to you) sees your interests and wishlist.

ACCOUNT
- Sign up (/signup) with a name, email and password (at least 8 characters), or "Continue with Google". Log in at /login.
- The app's menu has: Dashboard, My Events, My Secret Santa, AI Assistant, Profile, Settings. The language and theme switchers are also in the menu.

DASHBOARD (/dashboard)
- Your current Secret Santa at a glance: reveal your recipient, see who you're gifting, or the next step (invite friends, draw names, waiting for the organizer).
- A countdown to the gift exchange day of your next event (if a date is set).
- Quick actions: Create Secret Santa, Join an event (paste an invite link), My Santa, My profile.
- Your events and how complete your profile is.

MY EVENTS (/events)
- All your events: active ones first, completed ones under "Past events". A field to paste an invite link. A button to create a new event.

CREATE EVENT (/events/new) — four steps
1. Event: a name (required, up to 80 characters), a description (optional, up to 500), a gift exchange day (optional; can't be in the past).
2. Budget & group: gift budget from/to in som (optional), max participants (optional, 3–500; the link stops accepting people once the group is full).
3. Profile: add your own interests and wishlist, or skip and do it later. The organizer takes part too.
4. Ready: the event is created and you get the invite link to send.

INVITING PEOPLE
- On the event page, copy or share the invite link. Anyone with the link can join until names are drawn.
- The organizer can replace the link ("New invite link" in Manage event); the old link stops working.

JOINING
- Open the invite link (/join/…): you see the event, the organizer, the budget and who's in, then press "Join Secret Santa". Without an account: "Create free account & join".
- Or open /join and paste the link.
- You can't join after names are drawn, or when the group is full.

EVENT PAGE (/events/:id)
- Status: Gathering people → Names drawn → Completed. Number of people, and how many are "ready" (shared at least one interest or wishlist gift).
- Participants list, the invite link, and a card with the next step.
- A participant (not the organizer) can leave the event until names are drawn.
- Manage event (organizer only): edit name, description, gift exchange day, budget and max participants (until the event is completed); replace the invite link; remove participants (before the draw); mark the event completed after the gifts are exchanged (it moves to past events); delete the event for everyone (can't be undone). The organizer can't leave — they delete the event instead.

THE DRAW
- Only the organizer can draw names, only while the event is gathering people, and only with at least 3 participants.
- The draw is random; nobody gets themselves. After the draw nobody can join or leave.
- "Why can't I draw names?" — you are not the organizer, or there are fewer than 3 people, or names are already drawn, or the event is completed.

EVENT CHAT (on the event page)
- A group chat for everyone in the event. It opens once names are drawn; before the draw the event page says it will open after the draw.
- Text messages only (up to 1000 characters): Enter sends, Shift + Enter starts a new line. New messages appear at once, without a refresh; messages you haven't read yet are marked as new.
- Only the event's participants can read or write in it. The chat never shows who gives to whom — don't reveal your recipient there.
- When someone writes while you are on another page, a notice "New message in <event>" appears with "Open chat"; unread event chat messages are counted on the My Events menu item, the same on all your devices.

MY SECRET SANTA IN AN EVENT (/events/:id/santa)
- After the draw, press "Open my Secret Santa" to see who you're gifting. Only you see it.
- Shows the recipient's name, interests and wishlist (approximate prices, whether a gift fits the budget, "where to buy" links), and a private gift checklist: picked an idea, bought it, wrapped it, handed it over.

MY SECRET SANTA (/my-santa)
- Your recipients across all events: still-wrapped ones (tap to reveal) and opened ones with a link to their wishlist.
- If your own Secret Santa wrote to you, "Your Secret Santa wrote to you" lists those chats here.

ANONYMOUS GIFT CHAT (Secret Santa ↔ recipient)
- After opening your Secret Santa, press "Write about the gift" (on your recipient's page or their card in My Secret Santa) to ask them about the gift privately.
- Your recipient sees only "Your Secret Santa" — never your name, picture or anything else about you. They can answer, and the answer comes back to you. You, in turn, never learn who your own Secret Santa is.
- Only the Santa can start the chat; the recipient can answer once their Santa has written. New messages arrive at once; on other pages a notice "Your Secret Santa wrote to you about the gift" appears with a "Reply" button, and the My Secret Santa menu item shows unread messages.
- The chat opens after the draw and becomes read-only once the event is completed. It is separate from the event chat, and nobody else — not even the organizer — can read it.

PROFILE (/profile)
- Your name, interests (up to 20, each up to 30 characters, with suggestions) and wishlist (up to 30 gifts: a name up to 120 characters, an approximate price in som, an optional link).
- Readiness for your Santa: a name, some interests, at least one gift on the wishlist.

SETTINGS (/settings)
- Account: your name and email (change the name on your profile).
- Appearance: Light, Dark or System theme; saved to your account, so other devices get it too.
- Language: Русский, English or Кыргызча — for the whole site; remembered on this device.
- Password: change it (logs you out on other devices), or, if you signed in with Google, set one after Google confirms it's you.
- Sessions: log out, or log out of all other devices.
- Help: "How Secret Santa works" reopens the product tour; links to the Terms of Service and the Privacy Policy.

PRODUCT TOUR
- On the first visit to any page of the site, a small "New here?" card offers a short tour (11 steps: events, invites, wishlists, the draw, My Secret Santa, the anonymous gift chat, the event chat, AI gift ideas, notifications). It shows once per device; reopen it in Settings → Help or with "How Secret Santa works" in the site footer.

AI ASSISTANT (/ai)
- Answers questions about the app at any time.
- Gift help in an event after you open your Secret Santa: ideas from your recipient's interests and wishlist, within the event budget.
- Conversations are saved in History; you can delete them. The assistant can make mistakes — check prices before buying.
- A small assistant button (gift icon, bottom-right corner) opens a mini chat on every app page except /ai. It answers questions about the page you're on and the app in general; for gift ideas for your recipient, use the full AI Assistant (/ai) and pick the event. "Open full assistant" continues the same conversation on /ai.
- When you ask it to switch the theme or the language, the assistant shows a button; the setting changes only when you press it.`;
