import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthUser } from '../common/auth/auth.types';
import { RateLimit } from '../common/throttle/rate-limit';
import { aiErrorCode, toHttpError } from './ai-errors';
import { AiService, type ReplyEvent } from './ai.service';
import { CreateConversationDto, SendMessageDto } from './dto/ai.dto';

const ConversationId = () => Param('id', ParseUUIDPipe);

/**
 * The AI assistant — /api/ai/conversations: general ones about the app, and ones
 * about an event. Signed-in only (global JwtAuthGuard); ownership is checked in
 * AiService on every call.
 */
@Controller('ai/conversations')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get()
  async list(@CurrentUser() me: AuthUser) {
    return { conversations: await this.ai.list(me.id) };
  }

  @Post()
  @RateLimit('aiConversations')
  async create(
    @CurrentUser() me: AuthUser,
    @Body() dto: CreateConversationDto,
  ) {
    return {
      conversation: await this.ai.create(me.id, dto.eventId ?? null),
    };
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @ConversationId() id: string) {
    return this.ai.get(me.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() me: AuthUser, @ConversationId() id: string) {
    await this.ai.remove(me.id, id);
  }

  /**
   * Sends my message and streams the reply as Server-Sent Events:
   *   event: delta  data: {"text": "…"}           — as the reply is written
   *   event: done   data: {"userMessage", "message"} — both saved
   *   event: error  data: {"code": "ai_…"}        — the model failed mid-reply
   * Anything that fails before the first piece of text (not found, provider down,
   * rate limits) is a regular JSON error response instead.
   */
  @Post(':id/messages')
  @RateLimit('ai')
  async send(
    @CurrentUser() me: AuthUser,
    @ConversationId() id: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    // The browser left (closed the tab, pressed stop): stop paying for the reply
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const events = this.ai.reply(
      me.id,
      id,
      dto.content,
      dto.locale ?? 'en',
      abort.signal,
      dto.page,
    );
    let next: IteratorResult<ReplyEvent>;
    try {
      next = await events.next();
    } catch (error) {
      if (abort.signal.aborted) return void res.end(); // nobody is listening any more
      throw toHttpError(error);
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // no buffering in front-end proxies (nginx)
    });
    res.flushHeaders();

    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      for (; !next.done; next = await events.next()) {
        const { type, ...data } = next.value;
        send(type, data);
      }
    } catch (error) {
      if (!abort.signal.aborted) send('error', { code: aiErrorCode(error) });
    } finally {
      res.end();
    }
  }
}
