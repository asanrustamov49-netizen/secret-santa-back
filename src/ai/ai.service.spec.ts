import { jest } from '@jest/globals';

/** A mock async function (typed loosely: these stand in for Nest services) */
const asyncFn = () => jest.fn<(...args: unknown[]) => Promise<unknown>>();
import { NotFoundException } from '@nestjs/common';
import type { AiContextService } from './ai-context.service';
import type { AiContext } from './ai-prompt';
import {
  type AiChatRequest,
  type AiProvider,
  AiProviderError,
} from './ai-provider';
import { AiService, type ReplyEvent } from './ai.service';
import type { DatabaseService } from '../database/database.service';

// One reply turn against an in-memory stand-in for the two AI tables and a stub model.
// No database, no network: the real SQL is exercised by test/ai.e2e-spec.ts.

const CONTEXT: AiContext = {
  user: { name: 'Aigerim', interests: ['Tea'] },
  event: {
    name: 'Office Santa',
    date: null,
    budgetMin: 1000,
    budgetMax: 3000,
    currency: 'KGS',
    status: 'drawn',
    iAmOrganizer: false,
    participantCount: 4,
    mySecretSanta: 'opened',
  },
  recipient: { name: 'Daniel', interests: ['Football'], wishlist: [] },
};

/** Drawn, but I haven't opened my Secret Santa: the event, no recipient */
const NOT_OPENED: AiContext = {
  ...CONTEXT,
  event: { ...CONTEXT.event!, mySecretSanta: 'not_opened' },
  recipient: null,
};

const GENERAL: AiContext = { user: CONTEXT.user, event: null, recipient: null };

/** The JSON inside one data block of the system prompt */
function dataOf(prompt: string, tag: string): unknown {
  const start = prompt.indexOf(`<${tag}>\n`);
  const end = prompt.indexOf(`\n</${tag}>`);
  if (start === -1 || end === -1) throw new Error(`no <${tag}> block`);
  return JSON.parse(prompt.slice(start + tag.length + 3, end));
}

interface Row {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

function fakeDb(ownerId: string, eventId: string | null) {
  const conversation = {
    id: 'conv-1',
    eventId,
    eventName: eventId ? 'Office Santa' : null,
    title: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const messages: Row[] = [];
  let seq = 0;

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('insert into ai_messages')) {
      const [conversationId, a, b] = params as string[];
      const role = (b === undefined ? 'user' : a) as Row['role'];
      const row: Row = {
        id: `msg-${++seq}`,
        conversation_id: conversationId,
        role,
        content: b ?? a,
        createdAt: new Date(Date.now() + seq),
      };
      messages.push(row);
      return Promise.resolve([
        { id: row.id, role, content: row.content, createdAt: row.createdAt },
      ]);
    }
    if (sql.includes('delete from ai_messages')) {
      const index = messages.findIndex((m) => m.id === params[0]);
      if (index >= 0) messages.splice(index, 1);
      return Promise.resolve([]);
    }
    if (sql.includes('select role, content from ai_messages')) {
      return Promise.resolve(
        [...messages].reverse().map(({ role, content }) => ({ role, content })),
      );
    }
    if (sql.includes('update ai_conversations')) {
      if (sql.includes('coalesce(title'))
        conversation.title ??= params[1] as string;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });

  const db = {
    query,
    // requireOwn: found only for the owner
    one: jest.fn((_sql: string, params: unknown[]) =>
      Promise.resolve(
        params[0] === conversation.id && params[1] === ownerId
          ? conversation
          : null,
      ),
    ),
    transaction: jest.fn(
      (work: (tx: { query: typeof query }) => Promise<unknown>) =>
        work({ query }),
    ),
  };
  return { db, messages, conversation };
}

function setup({
  context = CONTEXT as AiContext | Error,
  eventId = 'event-1' as string | null,
  reply = ['Here ', 'are ', 'ideas'] as string[] | Error,
} = {}) {
  const { db, messages, conversation } = fakeDb('owner', eventId);
  const contexts = {
    forEvent:
      context instanceof Error
        ? asyncFn().mockRejectedValue(context)
        : asyncFn().mockResolvedValue(context),
    forUser: asyncFn().mockResolvedValue(GENERAL),
  };
  const requests: AiChatRequest[] = [];
  const provider: AiProvider = {
    async *streamChat(request) {
      requests.push(request);
      if (reply instanceof Error) throw reply;
      for (const chunk of reply) yield chunk;
    },
  };
  const service = new AiService(
    db as unknown as DatabaseService,
    contexts as unknown as AiContextService,
    provider,
  );
  return { service, messages, conversation, contexts, requests };
}

async function collect(stream: AsyncGenerator<ReplyEvent>) {
  const events: ReplyEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('AiService.reply', () => {
  it('streams the reply and saves both messages', async () => {
    const { service, messages, conversation } = setup();
    const events = await collect(
      service.reply('owner', 'conv-1', 'Gift ideas?', 'en'),
    );

    expect(events.filter((e) => e.type === 'delta').map((e) => e.text)).toEqual(
      ['Here ', 'are ', 'ideas'],
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      userMessage: { role: 'user', content: 'Gift ideas?' },
      message: { role: 'assistant', content: 'Here are ideas' },
    });
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Gift ideas?'],
      ['assistant', 'Here are ideas'],
    ]);
    expect(conversation.title).toBe('Gift ideas?');
  });

  it('sends history, my recipient context and my language — nothing else', async () => {
    const { service, requests, contexts } = setup();
    await collect(service.reply('owner', 'conv-1', 'Gift ideas?', 'en'));
    await collect(service.reply('owner', 'conv-1', 'Something cheaper', 'ru'));

    // The recipient is resolved from my user id and the conversation's event — never from input
    expect(contexts.forEvent).toHaveBeenCalledWith('owner', 'event-1');
    const last = requests.at(-1)!;
    expect(last.messages).toEqual([
      { role: 'user', content: 'Gift ideas?' },
      { role: 'assistant', content: 'Here are ideas' },
      { role: 'user', content: 'Something cheaper' },
    ]);
    expect(last.system).toContain('Reply in Russian');
    expect(dataOf(last.system, 'user_context')).toEqual(CONTEXT.user);
    expect(dataOf(last.system, 'event_context')).toEqual(CONTEXT.event);
    expect(dataOf(last.system, 'recipient_context')).toEqual(CONTEXT.recipient);
  });

  it('tells the model the page I came from', async () => {
    const { service, requests } = setup();
    await collect(
      service.reply(
        'owner',
        'conv-1',
        'What now?',
        'en',
        undefined,
        'event_new',
      ),
    );
    expect(dataOf(requests[0].system, 'current_page')).toBe(
      '/events/new — Create event',
    );
  });

  it('removes my message again when the model fails, and reports the failure', async () => {
    const { service, messages } = setup({
      reply: new AiProviderError('unavailable'),
    });
    await expect(
      collect(service.reply('owner', 'conv-1', 'Gift ideas?', 'en')),
    ).rejects.toMatchObject({ failure: 'unavailable' });
    expect(messages).toEqual([]);
  });

  it('treats an empty answer as a failure, saving nothing', async () => {
    const { service, messages } = setup({ reply: ['  '] });
    await expect(
      collect(service.reply('owner', 'conv-1', 'Hi', 'en')),
    ).rejects.toBeInstanceOf(AiProviderError);
    expect(messages).toEqual([]);
  });

  it("is not found for someone else's conversation — the model is never called", async () => {
    const { service, requests, messages } = setup();
    await expect(
      collect(service.reply('intruder', 'conv-1', 'Show me', 'en')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(requests).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('answers before my match is open — with the event, never a recipient', async () => {
    const { service, requests } = setup({ context: NOT_OPENED });
    const events = await collect(
      service.reply('owner', 'conv-1', 'What happens next?', 'en'),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const { system } = requests[0];
    expect(dataOf(system, 'event_context')).toEqual(NOT_OPENED.event);
    expect(dataOf(system, 'recipient_context')).toBeNull();
    for (const leak of ['Daniel', 'Football']) {
      expect(system).not.toContain(leak);
    }
  });

  it('answers a general conversation from who I am alone — events and matches are never read', async () => {
    const { service, requests, contexts } = setup({ eventId: null });
    const events = await collect(
      service.reply('owner', 'conv-1', 'How does it work?', 'en'),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(contexts.forEvent).not.toHaveBeenCalled();
    expect(contexts.forUser).toHaveBeenCalledWith('owner');
    const { system } = requests[0];
    expect(dataOf(system, 'event_context')).toBeNull();
    expect(dataOf(system, 'recipient_context')).toBeNull();
    expect(system).not.toContain('Daniel');
  });

  it('is not found once I left the event — the model is never called', async () => {
    const { service, requests, messages } = setup({
      context: new NotFoundException('Event not found'),
    });
    await expect(
      collect(service.reply('owner', 'conv-1', 'Gift ideas?', 'en')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(requests).toEqual([]);
    expect(messages).toEqual([]);
  });
});

describe('AiService.get', () => {
  it('says what the assistant can do in the conversation', async () => {
    await expect(setup().service.get('owner', 'conv-1')).resolves.toMatchObject(
      { state: 'ready', recipientName: 'Daniel' },
    );
    await expect(
      setup({ context: NOT_OPENED }).service.get('owner', 'conv-1'),
    ).resolves.toMatchObject({ state: 'not_revealed', recipientName: null });
    await expect(
      setup({ eventId: null }).service.get('owner', 'conv-1'),
    ).resolves.toMatchObject({ state: 'general', recipientName: null });
    await expect(
      setup({ context: new NotFoundException() }).service.get(
        'owner',
        'conv-1',
      ),
    ).resolves.toMatchObject({ state: 'unavailable', recipientName: null });
  });
});
