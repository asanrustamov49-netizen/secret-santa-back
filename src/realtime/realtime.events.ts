// The realtime vocabulary — shared by the gateway, the emitters and the tests.
//
// Every server → client message is a *notification*, not data: it says which event
// changed, never what changed or who. The client then refetches through the REST
// API, which applies all the usual access rules (above all: my recipient only, and
// only once I opened my match). So no socket message can ever carry a pair.
// The exceptions are chat messages: the event chat (ChatRealtimeEvent below) — plain
// text the participants wrote to each other, delivered only to the event's own room —
// and the anonymous Secret Santa chat (SantaChatRealtimeEvent), delivered only to the
// two people of one pair, each through their own user room.

/** Server → client */
export const RealtimeEvent = {
  /** Someone joined through the invite link */
  participantJoined: 'event:participant_joined',
  /** Someone left, or the organizer removed them */
  participantLeft: 'event:participant_left',
  /** A participant changed their name or interests (their "ready for Santa" may change) */
  participantUpdated: 'event:participant_updated',
  /** A participant changed their wishlist (readiness, and their Santa's view of it) */
  wishlistUpdated: 'event:wishlist_updated',
  /** Event details changed: name, date, budget, limit, invite link — or a new event of mine */
  updated: 'event:updated',
  /** Names are drawn. Just the fact: each client asks the API for its own match */
  drawCompleted: 'event:draw_completed',
  /** Gifts exchanged, the event moved to "past" */
  completed: 'event:completed',
  /** The organizer deleted the event */
  deleted: 'event:deleted',
  /** To the removed person only: they are no longer in this event */
  removed: 'event:removed',
  /** To my own other tabs: I opened my Secret Santa here */
  matchRevealed: 'match:revealed',
} as const;

export type RealtimeEventName =
  (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

/** The only payload any realtime message carries */
export interface RealtimePayload {
  eventId: string;
}

/**
 * The one message that carries data: a new event-chat message, to the event's room.
 * It holds only what any participant reads through GET /events/:id/messages anyway —
 * the text, when, and the author's name and picture (as in the participants list).
 * The chat never reads the matches table, so it can't carry a pair either.
 */
export const ChatRealtimeEvent = {
  message: 'chat:message',
  /** To my own tabs only: I read this event's chat — { eventId } */
  read: 'chat:read',
} as const;

export interface ChatRealtimePayload<Message = unknown> {
  eventId: string;
  message: Message;
}

/**
 * The anonymous Secret Santa chat. Never sent to an event room: each side gets its
 * own copy in its own user room, worded for it — "mine / not mine", with no author
 * id, name or picture. So the recipient's copy can't tell them who their Santa is.
 */
export const SantaChatRealtimeEvent = {
  /** A new message in one of my Secret Santa chats */
  message: 'santa-chat:message',
  /** I read a chat in another tab: my unread badges change */
  read: 'santa-chat:read',
} as const;

/** sender — I'm the Santa (I know who I write to) · recipient — my Santa writes to me */
export type SantaChatRole = 'sender' | 'recipient';

export interface SantaChatRealtimePayload<Message = unknown> {
  chatId: string;
  eventId: string;
  /** The receiving user's own role in this chat */
  role: SantaChatRole;
  message: Message;
}

export interface SantaChatReadPayload {
  eventId: string;
  role: SantaChatRole;
}

/** Client → server */
export const RealtimeCommand = {
  /** Listen to one event (membership is checked) */
  joinEvent: 'event:join',
  leaveEvent: 'event:leave',
} as const;

/** The answer to a command */
export interface RealtimeAck {
  ok: boolean;
}

export const eventRoom = (eventId: string) => `event:${eventId}`;
export const userRoom = (userId: string) => `user:${userId}`;
