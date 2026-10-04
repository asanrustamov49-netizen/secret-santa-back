import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ListChatMessagesQuery,
  SendChatMessageDto,
} from '../chat/dto/chat.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RateLimit } from '../common/throttle/rate-limit';
import type { SantaChatRole } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import { SantaChatService } from './santa-chat.service';

const ROLES = { sender: 'sender', recipient: 'recipient' } as const;

const EventId = () => Param('id', ParseUUIDPipe);
/** My side of the chat: sender — I'm the Santa · recipient — my Santa writes to me */
const Role = () => Param('role', new ParseEnumPipe(ROLES));

const otherSide = (role: SantaChatRole): SantaChatRole =>
  role === 'sender' ? 'recipient' : 'sender';

/**
 * The anonymous Secret Santa chat. Signed-in only (global JwtAuthGuard); who may
 * talk to whom is decided in SantaChatService from the draw, never from the request.
 * REST is the source of truth; a sent message is also pushed to both people's own
 * user rooms — each copy says only "mine / not mine".
 */
@Controller()
export class SantaChatController {
  constructor(
    private readonly chats: SantaChatService,
    private readonly realtime: RealtimeService,
  ) {}

  /** My chats that have messages — for unread badges and "your Santa wrote" */
  @Get('santa-chats')
  @Header('Cache-Control', 'no-store')
  async list(@CurrentUser() me: AuthUser) {
    return { chats: await this.chats.listMine(me.id) };
  }

  @Get('events/:id/santa-chat/:role')
  @Header('Cache-Control', 'no-store')
  open(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Role() role: SantaChatRole,
    @Query() query: ListChatMessagesQuery,
  ) {
    return this.chats.open(me.id, id, role, query.before);
  }

  @Post('events/:id/santa-chat/:role/messages')
  @RateLimit('chat')
  async send(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Role() role: SantaChatRole,
    @Body() dto: SendChatMessageDto,
  ) {
    const { chatId, counterpartId, message } = await this.chats.send(
      me.id,
      id,
      role,
      dto.content,
    );
    // My other tabs, then the other person — their copy is "not mine", and nameless
    this.realtime.santaChatMessage(me.id, {
      chatId,
      eventId: id,
      role,
      message,
    });
    this.realtime.santaChatMessage(counterpartId, {
      chatId,
      eventId: id,
      role: otherSide(role),
      message: { ...message, isMine: false },
    });
    return { chatId, message };
  }

  @Post('events/:id/santa-chat/:role/read')
  @HttpCode(200)
  @RateLimit('chatRead')
  async read(
    @CurrentUser() me: AuthUser,
    @EventId() id: string,
    @Role() role: SantaChatRole,
  ) {
    const read = await this.chats.markRead(me.id, id, role);
    if (read > 0) this.realtime.santaChatRead(me.id, { eventId: id, role });
    return { read };
  }
}
