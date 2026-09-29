import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AiContextService } from './ai-context.service';
import {
  type AiContext,
  type AiContextState,
  buildSystemPrompt,
  contextState,
  conversationTitle,
  historyWindow,
} from './ai-prompt';
import {
  AI_PROVIDER,
  type AiProvider,
  AiProviderError,
  type AiTurn,
} from './ai-provider';
import type { AiLocale } from './dto/ai.dto';
import type { AiPage } from './product-knowledge';

export interface AiConversation {
  id: string;
  /** null: a general conversation about the app */
  eventId: string | null;
  eventName: string | null;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

/** Streamed to the browser while a reply is written */
export type ReplyEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; userMessage: AiMessage; message: AiMessage };

const CONVERSATION_COLUMNS = `
  c.id, c.event_id as "eventId", e.name as "eventName", c.title,
  c.created_at as "createdAt", c.updated_at as "updatedAt"
`;
const MESSAGE_COLUMNS = `id, role, content, created_at as "createdAt"`;

/** Newest first in the sidebar; old ones stay reachable by deleting */
const CONVERSATION_LIST_LIMIT = 100;

/**
 * Conversations and messages. Every query about a conversation carries
 * "user_id = the signed-in user": someone else's conversation is simply not found
 * (404, the same answer as a wrong id — its existence isn't revealed).
 */
@Injectable()
export class AiService {
  constructor(
    private readonly db: DatabaseService,
    private readonly contexts: AiContextService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  list(userId: string) {
    return this.db.query<AiConversation>(
      `select ${CONVERSATION_COLUMNS}
       from ai_conversations c left join events e on e.id = c.event_id
       where c.user_id = $1
       order by c.updated_at desc
       limit ${CONVERSATION_LIST_LIMIT}`,
      [userId],
    );
  }

  /** General (no event), or about an event I take part in — 404 otherwise (AiContextService) */
  async create(
    userId: string,
    eventId: string | null,
  ): Promise<AiConversation> {
    if (eventId) await this.contexts.forEvent(userId, eventId);
    const [row] = await this.db.query<{ id: string }>(
      `insert into ai_conversations (user_id, event_id) values ($1, $2) returning id`,
      [userId, eventId],
    );
    return this.requireOwn(userId, row.id);
  }

  async get(userId: string, conversationId: string) {
    const conversation = await this.requireOwn(userId, conversationId);
    const [messages, context] = await Promise.all([
      this.db.query<AiMessage>(
        `select ${MESSAGE_COLUMNS} from ai_messages
         where conversation_id = $1 order by created_at, id`,
        [conversation.id],
      ),
      this.contextOf(userId, conversation).catch((error: unknown) => {
        // I left the event (or it's gone): the history stays readable, the assistant can't continue
        if (error instanceof NotFoundException) return null;
        throw error;
      }),
    ]);
    const state: AiContextState | 'unavailable' = context
      ? contextState(context)
      : 'unavailable';
    return {
      conversation,
      messages,
      // What the header shows; the recipient's name only once I opened my match
      state,
      recipientName: context?.recipient?.name ?? null,
    };
  }

  async remove(userId: string, conversationId: string) {
    const deleted = await this.db.query(
      `delete from ai_conversations where id = $1 and user_id = $2 returning id`,
      [conversationId, userId],
    );
    if (deleted.length === 0)
      throw new NotFoundException('Conversation not found');
  }

  /**
   * One turn: save my message, send the history + context to the model, stream the
   * reply, save it. If the model fails, my message is removed again, so a retry
   * doesn't leave a duplicate question in the history.
   */
  async *reply(
    userId: string,
    conversationId: string,
    content: string,
    locale: AiLocale,
    signal?: AbortSignal,
    page?: AiPage,
  ): AsyncGenerator<ReplyEvent> {
    const conversation = await this.requireOwn(userId, conversationId);
    // Checked on every message: the event may have been deleted, I may have left it,
    // or opened my Secret Santa since the last one
    const context = await this.contextOf(userId, conversation);
    const userMessage = await this.addUserMessage(conversation.id, content);

    let text = '';
    try {
      const history = await this.history(conversation.id);
      const chunks = this.provider.streamChat({
        system: buildSystemPrompt(context, locale, page),
        messages: history,
        signal,
      });
      for await (const chunk of chunks) {
        text += chunk;
        yield { type: 'delta', text: chunk };
      }
      if (!text.trim()) throw new AiProviderError('unavailable');
    } catch (error) {
      await this.db.query(`delete from ai_messages where id = $1`, [
        userMessage.id,
      ]);
      throw error;
    }

    const message = await this.addMessage(conversation.id, 'assistant', text);
    yield { type: 'done', userMessage, message };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async requireOwn(userId: string, conversationId: string) {
    const conversation = await this.db.one<AiConversation>(
      `select ${CONVERSATION_COLUMNS}
       from ai_conversations c left join events e on e.id = c.event_id
       where c.id = $1 and c.user_id = $2`,
      [conversationId, userId],
    );
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  /** General: only me. About an event: 404 unless I'm in it; the recipient only once opened */
  private contextOf(
    userId: string,
    conversation: AiConversation,
  ): Promise<AiContext> {
    return conversation.eventId
      ? this.contexts.forEvent(userId, conversation.eventId)
      : this.contexts.forUser(userId);
  }

  /** My message, and the conversation's title from it the first time */
  private addUserMessage(conversationId: string, content: string) {
    return this.db.transaction(async (tx) => {
      const [message] = await tx.query<AiMessage>(
        `insert into ai_messages (conversation_id, role, content) values ($1, 'user', $2)
         returning ${MESSAGE_COLUMNS}`,
        [conversationId, content],
      );
      // Also bumps updated_at (trigger), moving the conversation to the top of the list
      await tx.query(
        `update ai_conversations set title = coalesce(title, $2) where id = $1`,
        [conversationId, conversationTitle(content)],
      );
      return message;
    });
  }

  private async addMessage(
    conversationId: string,
    role: AiMessage['role'],
    content: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [message] = await tx.query<AiMessage>(
        `insert into ai_messages (conversation_id, role, content) values ($1, $2, $3)
         returning ${MESSAGE_COLUMNS}`,
        [conversationId, role, content],
      );
      await tx.query(
        `update ai_conversations set updated_at = now() where id = $1`,
        [conversationId],
      );
      return message;
    });
  }

  /** The recent turns, within the caps of historyWindow */
  private async history(conversationId: string): Promise<AiTurn[]> {
    const recent = await this.db.query<AiTurn>(
      `select role, content from ai_messages
       where conversation_id = $1
       order by created_at desc, id desc
       limit 40`,
      [conversationId],
    );
    return historyWindow(recent.reverse());
  }
}
