import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { DatabaseError } from 'pg';
import { DatabaseService, type Queryable } from '../database/database.service';
import { WishlistService } from '../users/wishlist.service';
import type { CreateEventDto, UpdateEventDto } from './dto/event.dto';

export type EventStatus = 'open' | 'drawn' | 'completed';

export interface EventSummary {
  id: string;
  name: string;
  description: string | null;
  /** YYYY-MM-DD */
  eventDate: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  maxParticipants: number | null;
  status: EventStatus;
  inviteCode: string;
  drawnAt: Date | null;
  createdAt: Date;
  isOwner: boolean;
  ownerName: string;
  participantCount: number;
  readyCount: number;
  /** I opened my Secret Santa in this event */
  revealed: boolean;
}

export interface Participant {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  isOwner: boolean;
  isMe: boolean;
  /** Has shared at least one interest or wish — something for their Santa to go on */
  ready: boolean;
  joinedAt: Date;
}

const MIN_PARTICIPANTS = 3;
const UNIQUE_VIOLATION = '23505';

// "Ready" = the user gave their Santa something to go on
const READY_SQL = `(cardinality(u.interests) > 0
  or exists (select 1 from wishlist_items w where w.user_id = u.id))`;

// $1 is always the current user's id
const EVENT_SQL = `
  select
    e.id, e.name, e.description,
    to_char(e.event_date, 'YYYY-MM-DD') as "eventDate",
    e.budget_min as "budgetMin", e.budget_max as "budgetMax", e.currency,
    e.max_participants as "maxParticipants", e.status,
    e.invite_code as "inviteCode", e.drawn_at as "drawnAt", e.created_at as "createdAt",
    (e.owner_id = $1) as "isOwner",
    o.name as "ownerName",
    (select count(*)::int from participants p where p.event_id = e.id) as "participantCount",
    (select count(*)::int from participants p join users u on u.id = p.user_id
      where p.event_id = e.id and ${READY_SQL}) as "readyCount",
    exists (select 1 from matches m join participants g on g.id = m.giver_id
      where m.event_id = e.id and g.user_id = $1 and m.revealed_at is not null) as "revealed"
  from events e
  join participants me on me.event_id = e.id and me.user_id = $1
  join users o on o.id = e.owner_id
`;

/** Short, URL-safe, unguessable: 9 random bytes → 12 characters */
const newInviteCode = () => randomBytes(9).toString('base64url');

/**
 * Gift-exchange day can't already be over. One day of slack for time zones
 * (the browser picks a local date, the server compares in UTC).
 */
function assertNotPast(day: string | null | undefined) {
  if (!day) return;
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (day < yesterday) {
    throw new BadRequestException("Pick a date that hasn't passed");
  }
}

function assertBudget(
  min: number | null | undefined,
  max: number | null | undefined,
) {
  if (min != null && max != null && min > max) {
    throw new BadRequestException('Minimum budget is higher than the maximum');
  }
}

@Injectable()
export class EventsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly wishlist: WishlistService,
  ) {}

  /** Every event I'm in: upcoming first, finished ones last */
  list(userId: string) {
    return this.db.query<EventSummary>(
      `${EVENT_SQL}
       order by (e.status = 'completed'), e.event_date nulls last, e.created_at desc`,
      [userId],
    );
  }

  /** 404 for events you're not in — don't reveal that they exist */
  async get(userId: string, eventId: string): Promise<EventSummary> {
    const event = await this.db.one<EventSummary>(
      `${EVENT_SQL} where e.id = $2`,
      [userId, eventId],
    );
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  async details(userId: string, eventId: string) {
    const event = await this.get(userId, eventId);
    const participants = await this.db.query<Participant>(
      `select p.id, u.id as "userId", u.name, u.avatar_url as "avatarUrl",
         (u.id = e.owner_id) as "isOwner", (u.id = $2) as "isMe",
         ${READY_SQL} as ready, p.joined_at as "joinedAt"
       from participants p
       join users u on u.id = p.user_id
       join events e on e.id = p.event_id
       where p.event_id = $1
       order by (u.id = e.owner_id) desc, p.joined_at`,
      [eventId, userId],
    );
    return { event, participants };
  }

  async create(userId: string, dto: CreateEventDto) {
    assertBudget(dto.budgetMin, dto.budgetMax);
    assertNotPast(dto.eventDate);

    const eventId = await this.db.transaction(async (tx) => {
      const [event] = await this.insertEvent(tx, userId, dto);
      // The organizer takes part in their own Secret Santa
      await tx.query(
        `insert into participants (event_id, user_id) values ($1, $2)`,
        [event.id, userId],
      );
      return event.id;
    });
    return this.get(userId, eventId);
  }

  async update(userId: string, eventId: string, dto: UpdateEventDto) {
    const event = await this.requireOwner(userId, eventId);
    if (event.status === 'completed') {
      throw new ConflictException('This Secret Santa is finished');
    }
    assertBudget(
      dto.budgetMin !== undefined ? dto.budgetMin : event.budgetMin,
      dto.budgetMax !== undefined ? dto.budgetMax : event.budgetMax,
    );
    // Only a *changed* date is checked — an event whose day has passed can still be renamed
    if (dto.eventDate !== event.eventDate) assertNotPast(dto.eventDate);
    if (
      dto.maxParticipants != null &&
      dto.maxParticipants < event.participantCount
    ) {
      throw new BadRequestException(
        `${event.participantCount} people have already joined`,
      );
    }

    // Only the fields that were sent; column names come from this fixed map, values are parameters
    const columns: Record<keyof UpdateEventDto, string> = {
      name: 'name',
      description: 'description',
      eventDate: 'event_date',
      budgetMin: 'budget_min',
      budgetMax: 'budget_max',
      maxParticipants: 'max_participants',
    };
    const sets: string[] = [];
    const values: unknown[] = [eventId];
    for (const [key, column] of Object.entries(columns)) {
      const value = dto[key as keyof UpdateEventDto];
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length > 0) {
      await this.db.query(
        `update events set ${sets.join(', ')} where id = $1`,
        values,
      );
    }
    return this.get(userId, eventId);
  }

  async remove(userId: string, eventId: string) {
    await this.requireOwner(userId, eventId);
    await this.db.query(`delete from events where id = $1`, [eventId]);
  }

  /** Old link stops working — for when it was shared too widely */
  async regenerateInvite(userId: string, eventId: string) {
    const event = await this.requireOwner(userId, eventId);
    if (event.status !== 'open') {
      throw new ConflictException('Invites are closed after the draw');
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.query(
          `update events set invite_code = $2 where id = $1`,
          [eventId, newInviteCode()],
        );
        break;
      } catch (error) {
        if (!this.isUniqueViolation(error) || attempt >= 3) throw error;
      }
    }
    return this.get(userId, eventId);
  }

  async removeParticipant(
    userId: string,
    eventId: string,
    participantId: string,
  ) {
    await this.requireOwner(userId, eventId);
    // Under the same row lock the draw takes: a removal can't slip in mid-draw
    // (it would cascade-delete that person's pairs and break the gift circle)
    await this.db.transaction(async (tx) => {
      await this.lockOpenEvent(
        tx,
        eventId,
        "The draw is done — participants can't change now",
      );
      const removed = await tx.query(
        `delete from participants p
         using events e
         where p.id = $1 and p.event_id = $2 and e.id = p.event_id and p.user_id <> e.owner_id
         returning p.id`,
        [participantId, eventId],
      );
      if (removed.length === 0)
        throw new NotFoundException('Participant not found');
    });
  }

  async leave(userId: string, eventId: string) {
    const event = await this.get(userId, eventId);
    if (event.isOwner) {
      throw new BadRequestException(
        'Organizers delete the event instead of leaving',
      );
    }
    await this.db.transaction(async (tx) => {
      await this.lockOpenEvent(
        tx,
        eventId,
        "The draw is done — you can't leave now",
      );
      await tx.query(
        `delete from participants where event_id = $1 and user_id = $2`,
        [eventId, userId],
      );
    });
  }

  /**
   * Shuffle everyone into one big circle: each person gives to the next one.
   * Nobody draws themselves, everyone gives once and receives once.
   */
  async draw(userId: string, eventId: string) {
    await this.requireOwner(userId, eventId);

    await this.db.transaction(async (tx) => {
      // Row lock: two clicks on "Draw" can't both run
      const [locked] = await tx.query<{ status: EventStatus }>(
        `select status from events where id = $1 for update`,
        [eventId],
      );
      if (locked?.status !== 'open') {
        throw new ConflictException('Names have already been drawn');
      }

      const people = await tx.query<{ id: string }>(
        `select id from participants where event_id = $1`,
        [eventId],
      );
      if (people.length < MIN_PARTICIPANTS) {
        throw new BadRequestException(
          `You need at least ${MIN_PARTICIPANTS} people to draw names`,
        );
      }

      // Fisher–Yates with a cryptographic RNG — nobody can predict the pairs
      const ids = people.map((p) => p.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }

      const values: string[] = [];
      const params: unknown[] = [eventId];
      ids.forEach((giver, i) => {
        params.push(giver, ids[(i + 1) % ids.length]);
        values.push(`($1, $${params.length - 1}, $${params.length})`);
      });
      await tx.query(
        `insert into matches (event_id, giver_id, receiver_id) values ${values.join(', ')}`,
        params,
      );
      await tx.query(
        `update events set status = 'drawn', drawn_at = now() where id = $1`,
        [eventId],
      );
    });

    return this.get(userId, eventId);
  }

  /** Gifts exchanged — the event moves to "past" */
  async complete(userId: string, eventId: string) {
    const event = await this.requireOwner(userId, eventId);
    if (event.status !== 'drawn') {
      throw new ConflictException('Draw names before finishing the event');
    }
    await this.db.query(
      `update events set status = 'completed' where id = $1`,
      [eventId],
    );
    return this.get(userId, eventId);
  }

  /**
   * My recipient. Before I open it, only the fact that a match exists —
   * the name stays hidden until the reveal (and nobody else ever sees it).
   */
  async myMatch(userId: string, eventId: string, reveal: boolean) {
    const event = await this.get(userId, eventId);
    if (event.status === 'open') {
      throw new NotFoundException('Names have not been drawn yet');
    }

    const match = await this.db.one<{
      id: string;
      revealedAt: Date | null;
      receiverUserId: string;
      name: string;
      avatarUrl: string | null;
      interests: string[];
    }>(
      `select m.id, m.revealed_at as "revealedAt", ru.id as "receiverUserId",
         ru.name, ru.avatar_url as "avatarUrl", ru.interests
       from matches m
       join participants g on g.id = m.giver_id
       join participants r on r.id = m.receiver_id
       join users ru on ru.id = r.user_id
       where m.event_id = $1 and g.user_id = $2`,
      [eventId, userId],
    );
    // Joined after the draw can't happen (invites close), but a missing row must not crash
    if (!match) throw new NotFoundException('You are not part of this draw');

    let revealedAt = match.revealedAt;
    if (reveal && !revealedAt) {
      const [row] = await this.db.query<{ revealedAt: Date }>(
        `update matches set revealed_at = now() where id = $1 returning revealed_at as "revealedAt"`,
        [match.id],
      );
      revealedAt = row.revealedAt;
    }

    const base = { event, revealedAt };
    if (!revealedAt) return { ...base, recipient: null };

    return {
      ...base,
      recipient: {
        name: match.name,
        avatarUrl: match.avatarUrl,
        interests: match.interests,
        wishlist: await this.wishlist.list(match.receiverUserId),
      },
    };
  }

  /** "My Secret Santa" page: one row per drawn event I'm giving in */
  myMatches(userId: string) {
    return this.db.query<{
      eventId: string;
      eventName: string;
      eventDate: string | null;
      budgetMin: number | null;
      budgetMax: number | null;
      currency: string;
      status: EventStatus;
      revealedAt: Date | null;
      recipientName: string | null;
      recipientAvatarUrl: string | null;
    }>(
      `select e.id as "eventId", e.name as "eventName",
         to_char(e.event_date, 'YYYY-MM-DD') as "eventDate",
         e.budget_min as "budgetMin", e.budget_max as "budgetMax", e.currency, e.status,
         m.revealed_at as "revealedAt",
         case when m.revealed_at is not null then ru.name end as "recipientName",
         case when m.revealed_at is not null then ru.avatar_url end as "recipientAvatarUrl"
       from matches m
       join participants g on g.id = m.giver_id
       join participants r on r.id = m.receiver_id
       join users ru on ru.id = r.user_id
       join events e on e.id = m.event_id
       where g.user_id = $1
       order by (e.status = 'completed'), e.event_date nulls last, e.drawn_at desc`,
      [userId],
    );
  }

  // ─── Invites ────────────────────────────────────────────────────────

  /** Public preview for /join/<code> — only what a stranger with the link may see */
  async invitePreview(code: string) {
    const event = await this.db.one<{
      id: string;
      name: string;
      description: string | null;
      eventDate: string | null;
      budgetMin: number | null;
      budgetMax: number | null;
      currency: string;
      maxParticipants: number | null;
      status: EventStatus;
      ownerName: string;
      participantCount: number;
    }>(
      `select e.id, e.name, e.description,
         to_char(e.event_date, 'YYYY-MM-DD') as "eventDate",
         e.budget_min as "budgetMin", e.budget_max as "budgetMax", e.currency,
         e.max_participants as "maxParticipants", e.status,
         o.name as "ownerName",
         (select count(*)::int from participants p where p.event_id = e.id) as "participantCount"
       from events e join users o on o.id = e.owner_id
       where e.invite_code = $1`,
      [code],
    );
    if (!event) throw new NotFoundException('This invite link is not valid');

    // A few faces for the "who's in" row — first names only
    const people = await this.db.query<{
      name: string;
      avatarUrl: string | null;
    }>(
      `select split_part(u.name, ' ', 1) as name, u.avatar_url as "avatarUrl"
       from participants p join users u on u.id = p.user_id
       where p.event_id = $1 order by p.joined_at limit 6`,
      [event.id],
    );
    // The id is for members only — a guest needs just the preview
    const { id: _id, ...preview } = event;
    return { ...preview, people };
  }

  /** Idempotent: joining twice just returns the event */
  /**
   * Idempotent: joining twice just returns the event. The status + capacity check
   * and the insert run under the event row lock the draw also takes, so nobody can
   * join mid-draw (ending up without a pair) or squeeze past maxParticipants.
   */
  join(userId: string, code: string) {
    return this.db.transaction(async (tx) => {
      const [event] = await tx.query<{
        id: string;
        status: EventStatus;
        maxParticipants: number | null;
        participantCount: number;
        isMember: boolean;
      }>(
        `select e.id, e.status, e.max_participants as "maxParticipants",
           (select count(*)::int from participants p where p.event_id = e.id) as "participantCount",
           exists (select 1 from participants p where p.event_id = e.id and p.user_id = $2) as "isMember"
         from events e where e.invite_code = $1
         for update of e`,
        [code, userId],
      );
      if (!event) throw new NotFoundException('This invite link is not valid');
      if (event.isMember) return { eventId: event.id, joined: false };

      if (event.status !== 'open') {
        throw new ConflictException(
          'Names have already been drawn — this Secret Santa is closed',
        );
      }
      if (
        event.maxParticipants != null &&
        event.participantCount >= event.maxParticipants
      ) {
        throw new ConflictException('This Secret Santa is full');
      }

      await tx.query(
        `insert into participants (event_id, user_id) values ($1, $2)
         on conflict (event_id, user_id) do nothing`,
        [event.id, userId],
      );
      return { eventId: event.id, joined: true };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /** Take the same row lock the draw takes, and insist the event is still open */
  private async lockOpenEvent(
    tx: Queryable,
    eventId: string,
    closedMessage: string,
  ) {
    const [row] = await tx.query<{ status: EventStatus }>(
      `select status from events where id = $1 for update`,
      [eventId],
    );
    if (!row) throw new NotFoundException('Event not found');
    if (row.status !== 'open') throw new ConflictException(closedMessage);
  }

  private async requireOwner(userId: string, eventId: string) {
    const event = await this.get(userId, eventId);
    if (!event.isOwner) {
      throw new ForbiddenException('Only the organizer can do this');
    }
    return event;
  }

  // 72 random bits: an invite-code clash is astronomically unlikely, and a retry
  // inside a transaction wouldn't work anyway (Postgres aborts it on the error)
  private insertEvent(tx: Queryable, userId: string, dto: CreateEventDto) {
    return tx.query<{ id: string }>(
      `insert into events
         (owner_id, name, description, event_date, budget_min, budget_max, max_participants, invite_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        userId,
        dto.name,
        dto.description ?? null,
        dto.eventDate ?? null,
        dto.budgetMin ?? null,
        dto.budgetMax ?? null,
        dto.maxParticipants ?? null,
        newInviteCode(),
      ],
    );
  }

  private isUniqueViolation(error: unknown) {
    return error instanceof DatabaseError && error.code === UNIQUE_VIOLATION;
  }
}
