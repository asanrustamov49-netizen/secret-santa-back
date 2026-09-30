// The realtime vocabulary — shared by the gateway, the emitters and the tests.
//
// Every server → client message is a *notification*, not data: it says which event
// changed, never what changed or who. The client then refetches through the REST
// API, which applies all the usual access rules (above all: my recipient only, and
// only once I opened my match). So no socket message can ever carry a pair.
// The single exception is a chat message (ChatRealtimeEvent below): plain text the
// participants wrote to each other, delivered only to the event's own room.

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
export const ChatRealtimeEvent = { message: 'chat:message' } as const;

export interface ChatRealtimePayload<Message = unknown> {
  eventId: string;
  message: Message;
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
