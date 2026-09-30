import { Controller, Get, Header } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RateLimit } from '../common/throttle/rate-limit';
import {
  RealtimeTicketService,
  TICKET_TTL_SECONDS,
} from './realtime-ticket.service';

/** /api/realtime — signed-in only (global JwtAuthGuard) */
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly tickets: RealtimeTicketService) {}

  /** A one-minute pass to open the realtime socket with (see RealtimeTicketService) */
  @Get('ticket')
  @RateLimit('realtime')
  @Header('Cache-Control', 'no-store')
  async ticket(@CurrentUser() me: AuthUser) {
    return {
      ticket: await this.tickets.issue(me),
      expiresIn: TICKET_TTL_SECONDS,
    };
  }
}
