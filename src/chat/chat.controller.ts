import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RateLimit } from '../common/throttle/rate-limit';
import { RealtimeService } from '../realtime/realtime.service';
import { ChatService } from './chat.service';
import { ListChatMessagesQuery, SendChatMessageDto } from './dto/chat.dto';

const EventId = () => Param('id', ParseUUIDPipe);

/**
 * /api/events/:id/messages — the event chat. Signed-in only (global JwtAuthGuard);
 * membership and the "names drawn" rule are checked in ChatService on every call.
 * REST is the source of truth; a sent message is also pushed to the event's
 * realtime room so the others see it at once.
 */
@Controller('events/:id/messages')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Query() query: ListChatMessagesQuery,
  ) {
    return this.chat.list(me.id, id, query.before);
  }

  @Post()
  @RateLimit('chat')
  async send(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Body() dto: SendChatMessageDto,
  ) {
    const message = await this.chat.send(me.id, id, dto.content);
    this.realtime.chatMessage(id, message);
    return { message };
  }

  /** I've read this chat up to now — kept by the API, so badges agree on every device */
  @Post('read')
  @HttpCode(204)
  @RateLimit('chatRead')
  async read(@CurrentUser() me: AuthUser, @EventId() id: string) {
    await this.chat.markRead(me.id, id);
    this.realtime.chatRead(me.id, id);
  }
}

/** /api/chats — across my event chats */
@Controller('chats')
export class ChatsController {
  constructor(private readonly chat: ChatService) {}

  /** Unread counts per event chat (only those with any) */
  @Get('unread')
  @Header('Cache-Control', 'no-store')
  async unread(@CurrentUser() me: AuthUser) {
    return { chats: await this.chat.unread(me.id) };
  }
}
