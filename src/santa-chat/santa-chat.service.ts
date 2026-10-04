import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CHAT_PAGE_SIZE } from '../chat/chat.service';
import { DatabaseService } from '../database/database.service';
import { EventsService, type EventStatus } from '../events/events.service';
import type { SantaChatRole } from '../realtime/realtime.events';

/**
 * One message as either side sees it: whose it is relative to the reader, nothing
 * else. The author's id stays in the database — not even the sender's own copy has it.
 */
export interface SantaChatMessage {
  id: string;
  content: string;
  createdAt: Date;
  isMine: boolean;
}

/** One of my chats, for badges and the "your Santa wrote" list — nobody's identity in it */
export interface SantaChatSummary {
  chatId: string;
  eventId: string;
  eventName: string;
  status: EventStatus;
  role: SantaChatRole;
  unread: number;
  lastMessageAt: Date;
}

/** My pair in an event, seen from my side of it */
interface Pair {
  eventId: string;
  eventName: string;
  status: EventStatus;
  matchId: string;
  chatId: string | null;
  /**
   * The other person of the pair — only to route their realtime copy of a message.
   * Internal: no response is ever built from it.
   */
  counterpartId: string;
  /** Sender side only: the person I'm gifting (what my reveal already showed me) */
  recipient: {
    name: string;
    avatarUrl: string | null;
    interests: string[];
  } | null;
}

// My pair as the Santa: the recipient's public profile comes along — I already know them.
// $1 event, $2 me. Field by field, never a whole row.
const SENDER_SQL = `
  select m.id as "matchId", m.revealed_at as "revealedAt", c.id as "chatId",
    r.user_id as "counterpartId",
    json_build_object('name', u.name, 'avatarUrl', u.avatar_url, 'interests', u.interests) as recipient
  from matches m
  join participants g on g.id = m.giver_id
  join participants r on r.id = m.receiver_id
  join users u on u.id = r.user_id
  left join secret_santa_chats c on c.match_id = m.id
  where m.event_id = $1 and g.user_id = $2
`;

// My pair as the recipient: nothing about the giver is selected but their id,
// which only routes the realtime copy of my replies.
const RECIPIENT_SQL = `
  select m.id as "matchId", c.id as "chatId", g.user_id as "counterpartId"
  from matches m
  join participants g on g.id = m.giver_id
  join participants r on r.id = m.receiver_id
  left join secret_santa_chats c on c.match_id = m.id
  where m.event_id = $1 and r.user_id = $2
`;

// $1 chat, $2 me — author_id is compared, never selected
const MESSAGE_FIELDS = `id, content, created_at as "createdAt", (author_id = $2) as "isMine"`;

/**
 * The anonymous Secret Santa chat: a Santa asks their recipient about the gift, the
 * recipient answers — and never learns who asks.
 *
 * Nothing from the client decides who talks to whom: every call starts from the
 * signed-in user and the role they ask for, and the pair comes from the draw itself
 * (matches). Event membership is EventsService.get (404 otherwise), the chat opens
 * once names are drawn, and the Santa writes only after opening their match.
 * The recipient's answers are never built from the giver's row — only their id is
 * read, to deliver the realtime copy.
 */
@Injectable()
export class SantaChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventsService,
  ) {}

  /** My side of the chat in an event and a page of messages (oldest first) */
  async open(
    userId: string,
    eventId: string,
    role: SantaChatRole,
    before?: string,
  ) {
    const pair = await this.pair(userId, eventId, role);
    const { messages, hasMore } = pair.chatId
      ? await this.page(pair.chatId, userId, before)
      : { messages: [] as SantaChatMessage[], hasMore: false };
    const unread = pair.chatId ? await this.unreadIn(pair.chatId, userId) : 0;

    // Built field by field: counterpartId and matchId stay here
    const base = {
      chatId: pair.chatId,
      role,
      event: { id: pair.eventId, name: pair.eventName, status: pair.status },
      messages,
      hasMore,
      unread,
    };
    return role === 'sender' ? { ...base, recipient: pair.recipient } : base;
  }

  /**
   * Saves a message. The Santa's first message opens the chat; the recipient can only
   * answer one that exists. Returns the other person's id for the realtime copy —
   * the controller must never put it in a response.
   */
  async send(
    userId: string,
    eventId: string,
    role: SantaChatRole,
    content: string,
  ) {
    const pair = await this.pair(userId, eventId, role);
    if (pair.status === 'completed') {
      throw new ConflictException('This Secret Santa is finished');
    }
    let chatId = pair.chatId;
    if (!chatId) {
      if (role === 'recipient') {
        throw new ConflictException(
          "Your Secret Santa hasn't written to you yet",
        );
      }
      chatId = await this.createChat(pair.matchId);
    }
    const [message] = await this.db.query<SantaChatMessage>(
      `insert into secret_santa_messages (chat_id, author_id, content)
       values ($1, $2, $3)
       returning id, content, created_at as "createdAt", true as "isMine"`,
      [chatId, userId, content],
    );
    return { chatId, counterpartId: pair.counterpartId, message };
  }

  /** Everything the other side wrote is read now; how many messages that was */
  async markRead(userId: string, eventId: string, role: SantaChatRole) {
    const pair = await this.pair(userId, eventId, role);
    if (!pair.chatId) return 0;
    const rows = await this.db.query(
      `update secret_santa_messages set read_at = now()
       where chat_id = $1 and author_id <> $2 and read_at is null
       returning id`,
      [pair.chatId, userId],
    );
    return rows.length;
  }

  /** My chats that have messages — at most two per event (one per role) */
  listMine(userId: string) {
    return this.db.query<SantaChatSummary>(
      `select c.id as "chatId", e.id as "eventId", e.name as "eventName", e.status,
         case when m.giver_id = me.id then 'sender' else 'recipient' end as role,
         s.unread, s."lastMessageAt"
       from participants me
       join matches m on m.giver_id = me.id or m.receiver_id = me.id
       join secret_santa_chats c on c.match_id = m.id
       join events e on e.id = m.event_id
       cross join lateral (
         select count(*) filter (where x.author_id <> $1 and x.read_at is null)::int as unread,
           max(x.created_at) as "lastMessageAt"
         from secret_santa_messages x where x.chat_id = c.id
       ) s
       where me.user_id = $1 and s."lastMessageAt" is not null
       order by s."lastMessageAt" desc`,
      [userId],
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * My pair in this event from my side: 404 unless I'm in the event, 409 before the
   * draw, 404 without a match, 409 for a Santa who hasn't opened theirs yet.
   */
  private async pair(
    userId: string,
    eventId: string,
    role: SantaChatRole,
  ): Promise<Pair> {
    const event = await this.events.get(userId, eventId);
    if (event.status === 'open') {
      throw new ConflictException(
        'The Secret Santa chat opens once names are drawn',
      );
    }

    const row = await this.db.one<{
      matchId: string;
      revealedAt?: Date | null;
      chatId: string | null;
      counterpartId: string;
      recipient?: Pair['recipient'];
    }>(role === 'sender' ? SENDER_SQL : RECIPIENT_SQL, [eventId, userId]);
    if (!row) throw new NotFoundException('You are not part of this draw');
    if (role === 'sender' && !row.revealedAt) {
      throw new ConflictException('Open your Secret Santa first');
    }

    return {
      eventId: event.id,
      eventName: event.name,
      status: event.status,
      matchId: row.matchId,
      chatId: row.chatId,
      counterpartId: row.counterpartId,
      recipient: role === 'sender' ? (row.recipient ?? null) : null,
    };
  }

  /** The chat of this match — created now, or the one a parallel first message just made */
  private async createChat(matchId: string): Promise<string> {
    const [created] = await this.db.query<{ id: string }>(
      `insert into secret_santa_chats (match_id) values ($1)
       on conflict (match_id) do nothing returning id`,
      [matchId],
    );
    if (created) return created.id;
    const [existing] = await this.db.query<{ id: string }>(
      `select id from secret_santa_chats where match_id = $1`,
      [matchId],
    );
    return existing.id;
  }

  private async page(chatId: string, userId: string, before?: string) {
    const params: unknown[] = [chatId, userId, CHAT_PAGE_SIZE + 1];
    let older = '';
    if (before) {
      params.push(before);
      // An id from another chat matches nothing: an empty page, never its messages
      older = `and (created_at, id) < (
        select created_at, id from secret_santa_messages where id = $4 and chat_id = $1)`;
    }
    const rows = await this.db.query<SantaChatMessage>(
      `select ${MESSAGE_FIELDS} from secret_santa_messages
       where chat_id = $1 ${older}
       order by created_at desc, id desc
       limit $3`,
      params,
    );
    return {
      messages: rows.slice(0, CHAT_PAGE_SIZE).reverse(),
      hasMore: rows.length > CHAT_PAGE_SIZE,
    };
  }

  private async unreadIn(chatId: string, userId: string) {
    const [row] = await this.db.query<{ count: number }>(
      `select count(*)::int as count from secret_santa_messages
       where chat_id = $1 and author_id <> $2 and read_at is null`,
      [chatId, userId],
    );
    return row.count;
  }
}
