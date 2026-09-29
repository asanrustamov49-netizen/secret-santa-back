import { Injectable, NotFoundException } from '@nestjs/common';
import { type EventSummary, EventsService } from '../events/events.service';
import { UsersService } from '../users/users.service';
import type { AiContext, EventContext } from './ai-prompt';

/**
 * The Secret Santa context for the signed-in user, decided entirely on the server:
 * signed-in user → participant in the event → their own match → their recipient.
 *
 * Built only on EventsService's existing, already access-checked reads — the same
 * ones the "My Secret Santa" page uses — so no new query ever touches the matches
 * table, and the reveal rule (recipient hidden until I open it) can't be bypassed.
 */
@Injectable()
export class AiContextService {
  constructor(
    private readonly events: EventsService,
    private readonly users: UsersService,
  ) {}

  /** A general conversation: only who I am — no event, no recipient */
  async forUser(userId: string): Promise<AiContext> {
    return { user: await this.me(userId), event: null, recipient: null };
  }

  /**
   * A conversation about one event. 404 unless the user takes part in it
   * (EventsService.get). The recipient is read only once my match is open.
   */
  async forEvent(userId: string, eventId: string): Promise<AiContext> {
    const event = await this.events.get(userId, eventId);
    const opened = event.status !== 'open' && event.revealed;

    let recipient: AiContext['recipient'] = null;
    if (opened) {
      // reveal = false: read-only; the recipient is returned only because I already opened it
      try {
        const match = await this.events.myMatch(userId, eventId, false);
        if (match.recipient) {
          recipient = {
            name: match.recipient.name,
            interests: [...match.recipient.interests],
            wishlist: match.recipient.wishlist.map((item) => ({
              title: item.title,
              priceApprox: item.priceApprox,
              url: item.url,
            })),
          };
        }
      } catch (error) {
        // Drawn, but I have no pair in it (can't normally happen): no recipient
        if (!(error instanceof NotFoundException)) throw error;
      }
    }

    return {
      user: await this.me(userId),
      event: eventContext(event, recipient ? 'opened' : undefined),
      recipient,
    };
  }

  private async me(userId: string): Promise<AiContext['user']> {
    const me = await this.users.findById(userId);
    if (!me) throw new NotFoundException('Account not found');
    return { name: me.name, interests: [...me.interests] };
  }
}

/** Field by field: no ids, invite code, description, owner name or other participants */
function eventContext(
  event: EventSummary,
  mySecretSanta?: EventContext['mySecretSanta'],
): EventContext {
  return {
    name: event.name,
    date: event.eventDate,
    budgetMin: event.budgetMin,
    budgetMax: event.budgetMax,
    currency: event.currency,
    status: event.status,
    iAmOrganizer: event.isOwner,
    participantCount: event.participantCount,
    mySecretSanta:
      mySecretSanta ?? (event.status === 'open' ? 'not_drawn' : 'not_opened'),
  };
}
