import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';

/** One message as every participant of the event sees it — nothing about the draw */
export interface ChatMessage {
  id: string;
  eventId: string;
  content: string;
  createdAt: Date;
  /** The same name and picture the event's participants list already shows */
  author: { id: string; name: string; avatarUrl: string | null };
}

/** Messages per page: the newest ones first, older ones on request */
export const CHAT_PAGE_SIZE = 50;

// Field by field, never a whole row: a column added to users later can't leak in
const MESSAGE_SQL = `
  select m.id, m.event_id as "eventId", m.content, m.created_at as "createdAt",
    json_build_object('id', u.id, 'name', u.name, 'avatarUrl', u.avatar_url) as author
  from event_messages m
  join users u on u.id = m.user_id
`;

/**
 * The event chat. Every call starts from the signed-in user and EventsService.get,
 * the same access rule as the event page: someone who isn't in the event gets a 404,
 * whatever event id they send. The chat opens once names are drawn.
 *
 * It only ever stores and returns what participants typed — the matches table is
 * never read here, so no message can carry a pair.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventsService,
  ) {}

  /** A page of messages, oldest first; `before`: the oldest message already on screen */
  async list(userId: string, eventId: string, before?: string) {
    await this.requireOpenChat(userId, eventId);
    const params: unknown[] = [eventId, CHAT_PAGE_SIZE + 1];
    let older = '';
    if (before) {
      params.push(before);
      // An id from another event matches nothing: an empty page, never its messages
      older = `and (m.created_at, m.id) < (
        select created_at, id from event_messages where id = $3 and event_id = $1)`;
    }
    const rows = await this.db.query<ChatMessage>(
      `${MESSAGE_SQL}
       where m.event_id = $1 ${older}
       order by m.created_at desc, m.id desc
       limit $2`,
      params,
    );
    const hasMore = rows.length > CHAT_PAGE_SIZE;
    return {
      messages: rows.slice(0, CHAT_PAGE_SIZE).reverse(),
      hasMore,
    };
  }

  async send(userId: string, eventId: string, content: string) {
    await this.requireOpenChat(userId, eventId);
    const [row] = await this.db.query<{ id: string }>(
      `insert into event_messages (event_id, user_id, content)
       values ($1, $2, $3) returning id`,
      [eventId, userId, content],
    );
    const [message] = await this.db.query<ChatMessage>(
      `${MESSAGE_SQL} where m.id = $1`,
      [row.id],
    );
    return message;
  }

  /** I've read the chat up to now: others' later messages are unread again */
  async markRead(userId: string, eventId: string) {
    await this.requireOpenChat(userId, eventId);
    await this.db.query(
      `insert into event_chat_reads (user_id, event_id) values ($1, $2)
       on conflict (user_id, event_id) do update set last_read_at = now()`,
      [userId, eventId],
    );
  }

  /**
   * Unread messages by others, per event chat of mine that has any — for badges and
   * notices. Counts only: nobody's name or text, and only chats I can open.
   */
  unread(userId: string) {
    return this.db.query<{
      eventId: string;
      eventName: string;
      unread: number;
    }>(
      `select e.id as "eventId", e.name as "eventName", count(m.id)::int as unread
       from participants p
       join events e on e.id = p.event_id and e.status <> 'open'
       left join event_chat_reads r on r.user_id = p.user_id and r.event_id = p.event_id
       join event_messages m on m.event_id = p.event_id and m.user_id <> p.user_id
         and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
       where p.user_id = $1
       group by e.id, e.name
       order by max(m.created_at) desc`,
      [userId],
    );
  }

  /** 404 unless I take part in the event; 409 while names aren't drawn yet */
  private async requireOpenChat(userId: string, eventId: string) {
    const event = await this.events.get(userId, eventId);
    if (event.status === 'open') {
      throw new ConflictException('The chat opens once names are drawn');
    }
    return event;
  }
}
