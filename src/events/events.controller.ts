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
import { CreateEventDto, UpdateEventDto } from './dto/event.dto';
import { EventsService } from './events.service';

const EventId = () => Param('id', ParseUUIDPipe);

/** Signed-in only (global JwtAuthGuard). Owner-only actions are checked in the service. */
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  async list(@CurrentUser() me: AuthUser) {
    return { events: await this.events.list(me.id) };
  }

  @Post()
  async create(@CurrentUser() me: AuthUser, @Body() dto: CreateEventDto) {
    return { event: await this.events.create(me.id, dto) };
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
    return { event: await this.events.update(me.id, id, dto) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() me: AuthUser, @EventId() id: string) {
    await this.events.remove(me.id, id);
  }

  @Post(':id/invite')
  @HttpCode(200)
  async regenerateInvite(@CurrentUser() me: AuthUser, @EventId() id: string) {
    return { event: await this.events.regenerateInvite(me.id, id) };
  }

  @Delete(':id/participants/:participantId')
  @HttpCode(204)
  async removeParticipant(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
  ) {
    await this.events.removeParticipant(me.id, id, participantId);
  }

  @Post(':id/leave')
  @HttpCode(204)
  async leave(@CurrentUser() me: AuthUser, @EventId() id: string) {
    await this.events.leave(me.id, id);
  }

  @Post(':id/draw')
  @HttpCode(200)
  async draw(@CurrentUser() me: AuthUser, @EventId() id: string) {
    return { event: await this.events.draw(me.id, id) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(@CurrentUser() me: AuthUser, @EventId() id: string) {
    return { event: await this.events.complete(me.id, id) };
  }

  /** Whether I have a match; the recipient stays hidden until I reveal it */
  @Get(':id/match')
  match(@CurrentUser() me: AuthUser, @EventId() id: string) {
    return this.events.myMatch(me.id, id, false);
  }

  @Post(':id/match/reveal')
  @HttpCode(200)
  reveal(@CurrentUser() me: AuthUser, @EventId() id: string) {
    return this.events.myMatch(me.id, id, true);
  }
}
