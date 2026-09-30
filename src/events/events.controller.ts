import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RealtimeEvent } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateEventDto, UpdateEventDto } from './dto/event.dto';
import { EventsService } from './events.service';

const EventId = () => Param('id', ParseUUIDPipe);

/**
 * Signed-in only (global JwtAuthGuard). Owner-only actions are checked in the service.
 * After a change succeeds, the people in the event are told "it changed" (RealtimeService);
 * their pages refetch through these same routes.
 */
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get()
  async list(@CurrentUser() me: AuthUser) {
    return { events: await this.events.list(me.id) };
  }

  @Post()
  async create(@CurrentUser() me: AuthUser, @Body() dto: CreateEventDto) {
    const event = await this.events.create(me.id, dto);
    // My other tabs: a new event in my lists
    this.realtime.toUser(me.id, RealtimeEvent.updated, event.id);
    return { event };
  }

  @Get(':id')
  details(@CurrentUser() me: AuthUser, @EventId() id: string) {
    return this.events.details(me.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Body() dto: UpdateEventDto,
  ) {
    const event = await this.events.update(me.id, id, dto);
    this.realtime.toEvent(id, RealtimeEvent.updated);
    return { event };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() me: AuthUser, @EventId() id: string) {
    await this.events.remove(me.id, id);
    this.realtime.toEvent(id, RealtimeEvent.deleted);
    this.realtime.closeEvent(id);
  }

  @Post(':id/invite')
  @HttpCode(200)
  async regenerateInvite(@CurrentUser() me: AuthUser, @EventId() id: string) {
    const event = await this.events.regenerateInvite(me.id, id);
    this.realtime.toEvent(id, RealtimeEvent.updated);
    return { event };
  }

  @Delete(':id/participants/:participantId')
  @HttpCode(204)
  async removeParticipant(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
  ) {
    const removedUserId = await this.events.removeParticipant(
      me.id,
      id,
      participantId,
    );
    // They stop listening first, then hear it privately; the rest see the list change
    this.realtime.removeFromEvent(removedUserId, id);
    this.realtime.toUser(removedUserId, RealtimeEvent.removed, id);
    this.realtime.toEvent(id, RealtimeEvent.participantLeft);
  }

  @Post(':id/leave')
  @HttpCode(204)
  async leave(@CurrentUser() me: AuthUser, @EventId() id: string) {
    await this.events.leave(me.id, id);
    this.realtime.removeFromEvent(me.id, id);
    this.realtime.toEvent(id, RealtimeEvent.participantLeft);
  }

  @Post(':id/draw')
  @HttpCode(200)
  async draw(@CurrentUser() me: AuthUser, @EventId() id: string) {
    const event = await this.events.draw(me.id, id);
    // Only the fact: each participant fetches their own match through the API
    this.realtime.toEvent(id, RealtimeEvent.drawCompleted);
    return { event };
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(@CurrentUser() me: AuthUser, @EventId() id: string) {
    const event = await this.events.complete(me.id, id);
    this.realtime.toEvent(id, RealtimeEvent.completed);
    return { event };
  }

  /** Whether I have a match; the recipient stays hidden until I reveal it */
  @Get(':id/match')
  match(@CurrentUser() me: AuthUser, @EventId() id: string) {
    return this.events.myMatch(me.id, id, false);
  }

  @Post(':id/match/reveal')
  @HttpCode(200)
  async reveal(@CurrentUser() me: AuthUser, @EventId() id: string) {
    const match = await this.events.myMatch(me.id, id, true);
    // My other tabs only: nobody else's view depends on my reveal
    this.realtime.toUser(me.id, RealtimeEvent.matchRevealed, id);
    return match;
  }
}
