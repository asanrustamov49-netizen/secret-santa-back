import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { CHAT_PAGE_SIZE } from './../src/chat/chat.service';
import { ChatRealtimeEvent } from './../src/realtime/realtime.events';
import { type Agent, createTestApp, signUp, type TestApp } from './support';

// Event chat against the real app and database, with real Socket.IO clients.
// Needs db/migrations/004_event_chat.sql.
//
// Test data (all deleted in afterAll, and before the suite in case a run was interrupted):
// 4 accounts chat-e2e-<uuid>@example.com — A (organizer), B, C (participants), D (outsider) —
// A's event, its participants, matches and messages. cleanup() deletes the accounts by
// that email pattern; the rest cascades.

const PREFIX = 'chat-e2e';

interface User {
  agent: Agent;
  email: string;
  id: string;
}

interface Message {
  id: string;
  eventId: string;
  content: string;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
}

describe('Event chat (e2e)', () => {
  let t: TestApp;
  let url: string;
  let a: User, b: User, c: User, d: User;
  let eventId: string;
  let inviteCode: string;
  const sockets: Socket[] = [];

  const messagesOf = (id: string, query = '') =>
    `/api/events/${id}/messages${query}`;

  const connect = async (user: User) => {
    const { ticket } = (
      await user.agent.get('/api/realtime/ticket').expect(200)
    ).body as { ticket: string };
    return new Promise<Socket>((resolve, reject) => {
      const socket = io(url, {
        auth: { ticket },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  };

  const join = (socket: Socket, id: string) =>
    socket.emitWithAck('event:join', { eventId: id }) as Promise<{
      ok: boolean;
    }>;

  const next = (socket: Socket, event: string, ms = 5000) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${event} within ${ms}ms`)),
        ms,
      );
      socket.once(event, (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

  beforeAll(async () => {
    t = await createTestApp(PREFIX);
    await t.app.listen(0);
    const server = t.app.getHttpServer() as unknown as Server;
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;

    [a, b, c, d] = await Promise.all(
      [1, 2, 3, 4].map(() => signUp(t.app, PREFIX)),
    );
    await b.agent
      .patch('/api/profile')
      .send({ name: 'Bravo Chat' })
      .expect(200);

    const created = await a.agent
      .post('/api/events')
      .send({ name: 'Chat e2e event' })
      .expect(201);
    ({ id: eventId, inviteCode } = (
      created.body as { event: { id: string; inviteCode: string } }
    ).event);
    for (const user of [b, c]) {
      await user.agent.post(`/api/invites/${inviteCode}/join`).expect(200);
    }
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await t.cleanup();
    await t.app.close();
  });

  it('is closed until names are drawn', async () => {
    await b.agent.get(messagesOf(eventId)).expect(409);
    await b.agent
      .post(messagesOf(eventId))
      .send({ content: 'Too early' })
      .expect(409);
  });

  it('is not there for anyone outside the event — whatever id they send', async () => {
    await d.agent.get(messagesOf(eventId)).expect(404);
    await d.agent
      .post(messagesOf(eventId))
      .send({ content: 'Let me in' })
      .expect(404);
    await b.agent.get(messagesOf(randomUUID())).expect(404);
    await b.agent.get(messagesOf('not-a-uuid')).expect(400);
  });

  it('opens after the draw and delivers a message to the room at once — no pair in it', async () => {
    await a.agent.post(`/api/events/${eventId}/draw`).expect(200);

    const socketA = await connect(a);
    const socketD = await connect(d);
    expect(await join(socketA, eventId)).toEqual({ ok: true });
    expect(await join(socketD, eventId)).toEqual({ ok: false });
    const dReceived: string[] = [];
    socketD.onAny((event: string) => dReceived.push(event));

    const arrived = next(socketA, ChatRealtimeEvent.message);
    const res = await b.agent
      .post(messagesOf(eventId))
      .send({ content: '  When do we exchange gifts?  ' })
      .expect(201);
    const { message } = res.body as { message: Message };

    expect(message.content).toBe('When do we exchange gifts?');
    expect(message.eventId).toBe(eventId);
    expect(message.author).toEqual({
      id: b.id,
      name: 'Bravo Chat',
      avatarUrl: null,
    });
    // Exactly these fields: nothing about the draw can ride along
    expect(Object.keys(message).sort()).toEqual(
      ['author', 'content', 'createdAt', 'eventId', 'id'].sort(),
    );

    expect(await arrived).toEqual({ eventId, message });
    await settle();
    expect(dReceived).not.toContain(ChatRealtimeEvent.message);

    // Nobody's match is in it: the pairs stay where they were
    const [pairs] = await t.db.query<{ count: number }>(
      `select count(*)::int as count from matches where event_id = $1`,
      [eventId],
    );
    expect(pairs.count).toBe(3);
  });

  it('keeps the history for every participant, oldest first', async () => {
    await c.agent
      .post(messagesOf(eventId))
      .send({ content: 'Friday after class' })
      .expect(201);
    const res = await a.agent.get(messagesOf(eventId)).expect(200);
    const { messages, hasMore } = res.body as {
      messages: Message[];
      hasMore: boolean;
    };
    expect(messages.map((m) => m.content)).toEqual([
      'When do we exchange gifts?',
      'Friday after class',
    ]);
    expect(messages[1].author.id).toBe(c.id);
    expect(hasMore).toBe(false);
  });

  it('pages back through older messages', async () => {
    // Straight into the table: enough rows for a second page, without the rate limit
    await t.db.query(
      `insert into event_messages (event_id, user_id, content, created_at)
       select $1, $2, 'old ' || n, now() - interval '1 hour' + n * interval '1 second'
       from generate_series(1, $3::int) n`,
      [eventId, a.id, CHAT_PAGE_SIZE],
    );
    const first = (await b.agent.get(messagesOf(eventId)).expect(200)).body as {
      messages: Message[];
      hasMore: boolean;
    };
    expect(first.messages).toHaveLength(CHAT_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(first.messages.at(-1)?.content).toBe('Friday after class');

    const older = (
      await b.agent
        .get(messagesOf(eventId, `?before=${first.messages[0].id}`))
        .expect(200)
    ).body as { messages: Message[]; hasMore: boolean };
    expect(older.messages.map((m) => m.content)).toEqual(['old 1', 'old 2']);
    expect(older.hasMore).toBe(false);

    await b.agent.get(messagesOf(eventId, '?before=nope')).expect(400);
    await b.agent.get(messagesOf(eventId, '?limit=5')).expect(400);
  });

  it('validates messages', async () => {
    for (const content of ['', '   ', 'x'.repeat(1001), { text: 'hi' }, 42]) {
      await b.agent.post(messagesOf(eventId)).send({ content }).expect(400);
    }
    await b.agent
      .post(messagesOf(eventId))
      .send({ content: 'hi', userId: d.id })
      .expect(400);
  });

  it('goes with the event when it is deleted', async () => {
    await a.agent.delete(`/api/events/${eventId}`).expect(204);
    const [left] = await t.db.query<{ count: number }>(
      `select count(*)::int as count from event_messages where event_id = $1`,
      [eventId],
    );
    expect(left.count).toBe(0);
  });
});
