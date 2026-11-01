import { Injectable, NotFoundException } from '@nestjs/common';
import { type EventSummary, EventsService } from '../events/events.service';
import { UsersService } from '../users/users.service';
import type { AiContext, EventContext } from './ai-prompt';

@Injectable()
export class AiContextService {
  constructor(
    private readonly events: EventsService,
    private readonly users: UsersService,
  ) {}

  async forUser(userId: string): Promise<AiContext> {
    return { user: await this.me(userId), event: null, recipient: null };
  }

  async forEvent(userId: string, eventId: string): Promise<AiContext> {
    const event = await this.events.get(userId, eventId);
    const opened = event.status !== 'open' && event.revealed;

    let recipient: AiContext['recipient'] = null;
    if (opened) {
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
