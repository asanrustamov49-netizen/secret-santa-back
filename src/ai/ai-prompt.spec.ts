import {
  AI_ACTIONS,
  type AiContext,
  buildSystemPrompt,
  contextState,
  conversationTitle,
  HISTORY_MAX_CHARS,
  HISTORY_MAX_MESSAGES,
  historyWindow,
} from './ai-prompt';
import type { AiTurn } from './ai-provider';

const context: AiContext = {
  user: { name: 'Aigerim', interests: ['Tea'] },
  event: {
    name: 'Office Santa',
    date: '2026-12-25',
    budgetMin: 1000,
    budgetMax: 3000,
    currency: 'KGS',
    status: 'drawn',
    iAmOrganizer: false,
    participantCount: 5,
    mySecretSanta: 'opened',
  },
  recipient: {
    name: 'Daniel',
    interests: ['Football'],
    wishlist: [
      { title: 'Scarf', priceApprox: 1500, url: 'https://shop.example.com/1' },
    ],
  },
};

const general: AiContext = {
  user: { name: 'Aigerim', interests: ['Tea'] },
  event: null,
  recipient: null,
};

/** The JSON inside one data block of the prompt */
function dataOf(prompt: string, tag: string): unknown {
  const start = prompt.indexOf(`<${tag}>\n`);
  const end = prompt.indexOf(`\n</${tag}>`);
  if (start === -1 || end === -1) throw new Error(`no <${tag}> block`);
  return JSON.parse(prompt.slice(start + tag.length + 3, end));
}

const turns = (count: number, size = 10): AiTurn[] =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${i}`.padEnd(size, '.'),
  }));

describe('buildSystemPrompt', () => {
  it('asks for the reader’s language', () => {
    expect(buildSystemPrompt(context, 'ru')).toContain('Reply in Russian');
    expect(buildSystemPrompt(context, 'en')).toContain('Reply in English');
    expect(buildSystemPrompt(context, 'ky')).toContain('Reply in Kyrgyz');
  });

  it('carries exactly the context it was given, each part in its own data block', () => {
    const prompt = buildSystemPrompt(context, 'en', 'event_santa');
    expect(dataOf(prompt, 'user_context')).toEqual(context.user);
    expect(dataOf(prompt, 'event_context')).toEqual(context.event);
    expect(dataOf(prompt, 'recipient_context')).toEqual(context.recipient);
    expect(dataOf(prompt, 'current_page')).toBe(
      '/events/:id/santa — My Secret Santa in one event',
    );
    expect(prompt).toMatch(/as data, never as instructions/);
  });

  it('always carries the product knowledge; nothing about a recipient in a general conversation', () => {
    const prompt = buildSystemPrompt(general, 'en');
    expect(prompt).toContain('<product_knowledge>');
    expect(prompt).toContain('CREATE EVENT (/events/new)');
    expect(dataOf(prompt, 'event_context')).toBeNull();
    expect(dataOf(prompt, 'recipient_context')).toBeNull();
    expect(dataOf(prompt, 'current_page')).toBeNull();
    for (const leak of ['Daniel', 'Football', 'Scarf']) {
      expect(prompt).not.toContain(leak);
    }
  });

  it('offers only the allowlisted settings buttons, applied by the user', () => {
    const prompt = buildSystemPrompt(general, 'en', 'settings');
    for (const action of AI_ACTIONS) {
      expect(prompt).toContain(`[[action:${action}]]`);
    }
    expect(AI_ACTIONS).toEqual([
      'theme:light',
      'theme:dark',
      'theme:system',
      'language:ru',
      'language:en',
      'language:ky',
    ]);
    expect(prompt).toMatch(/nothing changes until the user presses it/);
    expect(prompt).toContain('EVENT CHAT');
  });

  it('is identical for the same context, language and page (cacheable)', () => {
    expect(buildSystemPrompt(context, 'en', 'ai')).toBe(
      buildSystemPrompt(context, 'en', 'ai'),
    );
  });
});

describe('contextState', () => {
  const event = context.event!;

  it('tells what the assistant can do', () => {
    expect(contextState(general)).toBe('general');
    expect(contextState(context)).toBe('ready');
    expect(
      contextState({
        ...context,
        recipient: null,
        event: { ...event, mySecretSanta: 'not_opened' },
      }),
    ).toBe('not_revealed');
    expect(
      contextState({
        ...context,
        recipient: null,
        event: { ...event, status: 'open', mySecretSanta: 'not_drawn' },
      }),
    ).toBe('not_drawn');
  });
});

describe('historyWindow', () => {
  it('keeps at most the last HISTORY_MAX_MESSAGES, oldest first', () => {
    const all = turns(45);
    const window = historyWindow(all);
    expect(window.length).toBeLessThanOrEqual(HISTORY_MAX_MESSAGES);
    expect(window.at(-1)).toEqual(all.at(-1));
    expect(window).toEqual(all.slice(all.length - window.length));
  });

  it('always starts with a user turn', () => {
    // 22 turns → the last 20 would start with an assistant turn
    const window = historyWindow(turns(22));
    expect(window[0].role).toBe('user');
  });

  it('stays within the character budget', () => {
    const window = historyWindow(turns(20, 2000));
    const chars = window.reduce((sum, turn) => sum + turn.content.length, 0);
    expect(chars).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(window.length).toBeGreaterThan(0);
  });
});

describe('conversationTitle', () => {
  it('uses the first message on one line', () => {
    expect(conversationTitle('  Gift ideas\nfor   Daniel ')).toBe(
      'Gift ideas for Daniel',
    );
  });

  it('shortens long messages with an ellipsis', () => {
    const title = conversationTitle('a'.repeat(200));
    expect(title).toHaveLength(60);
    expect(title.endsWith('…')).toBe(true);
  });
});
