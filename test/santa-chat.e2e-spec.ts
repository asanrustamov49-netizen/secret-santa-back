import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { SantaChatRealtimeEvent } from './../src/realtime/realtime.events';
import { type Agent, createTestApp, signUp, type TestApp } from './support';

// The anonymous Secret Santa chat against the real app and database, with real
// Socket.IO clients. Needs db/migrations/005_secret_santa_chat.sql.
//
// Test data (all deleted in afterAll, and before the suite in case a run was interrupted):
// 4 accounts santa-chat-e2e-<uuid>@example.com — three in one event, one outsider —
// the event, its participants, matches, chats and messages. cleanup() deletes the
// accounts by that email pattern; the rest cascades.

const PREFIX = 'santa-chat-e2e';

interface User {
  agent: Agent;
  email: string;
  id: string;
  name: string;
}

interface Message {
  id: string;
  content: string;
  createdAt: string;
  isMine: boolean;
}

interface ChatView {
  chatId: string | null;
  role: 'sender' | 'recipient';
  event: { id: string; name: string; status: string };
  messages: Message[];
  hasMore: boolean;
  unread: number;
  recipient?: { name: string; avatarUrl: string | null; interests: string[] };
}

describe('Secret Santa chat (e2e)', () => {
  let t: TestApp;
  let url: string;
  let users: User[];
  let outsider: User;
  let eventId: string;
  /** santa → the person they give to, worked out from each reveal */
  const giftsTo = new Map<User, User>();
  /** The one chat the suite writes in */
  let chatId: string;
  const sockets: Socket[] = [];

  const chatOf = (id: string, role: string, rest = '') =>
    `/api/events/${id}/santa-chat/${role}${rest}`;

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

  /** Nothing in this value can point at the user: id, email or name */
  const expectNoTraceOf = (value: unknown, user: User) => {
    const text = JSON.stringify(value);
    expect(text).not.toContain(user.id);
    expect(text).not.toContain(user.email);
    expect(text).not.toContain(user.name);
  };

  beforeAll(async () => {
    t = await createTestApp(PREFIX);
    await t.app.listen(0);
    const server = t.app.getHttpServer() as unknown as Server;
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;

    const names = ['Alpha Gifter', 'Bravo Gifter', 'Charlie Gifter'];
    const accounts = await Promise.all(
      [0, 1, 2, 3].map(() => signUp(t.app, PREFIX)),
    );
    users = await Promise.all(
      accounts.slice(0, 3).map(async (account, i) => {
        await account.agent
          .patch('/api/profile')
          .send({ name: names[i] })
          .expect(200);
        return { ...account, name: names[i] };
      }),
    );
    outsider = { ...accounts[3], name: 'E2E User' };

    const created = await users[0].agent
      .post('/api/events')
      .send({ name: 'Santa chat e2e event' })
      .expect(201);
    const event = (
      created.body as { event: { id: string; inviteCode: string } }
    ).event;
    eventId = event.id;
    for (const user of users.slice(1)) {
      await user.agent
        .post(`/api/invites/${event.inviteCode}/join`)
        .expect(200);
    }
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await t.cleanup();
    await t.app.close();
  });

  it('does not exist before the draw, nor for anyone outside the event', async () => {
    const [a] = users;
    await a.agent.get(chatOf(eventId, 'sender')).expect(409);
    await a.agent.get(chatOf(eventId, 'recipient')).expect(409);
    await a.agent
      .post(chatOf(eventId, 'sender', '/messages'))
      .send({ content: 'Too early' })
      .expect(409);

    await outsider.agent.get(chatOf(eventId, 'recipient')).expect(404);
    await a.agent.get(chatOf(randomUUID(), 'sender')).expect(404);
    await a.agent.get(chatOf('not-a-uuid', 'sender')).expect(400);
    await a.agent.get(chatOf(eventId, 'admin')).expect(400);
  });

  it('lets a Santa write only after opening their match', async () => {
    await users[0].agent.post(`/api/events/${eventId}/draw`).expect(200);
    await users[0].agent.get(chatOf(eventId, 'sender')).expect(409);

    // Everyone opens their match: that tells the test who gives to whom
    for (const user of users) {
      const res = await user.agent
        .post(`/api/events/${eventId}/match/reveal`)
        .expect(200);
      const { name } = (res.body as { recipient: { name: string } }).recipient;
      giftsTo.set(
        user,
        users.find((u) => u.name === name)!,
      );
    }

    await outsider.agent.get(chatOf(eventId, 'sender')).expect(404);
  });

  it('shows the Santa their recipient, and the recipient nobody', async () => {
    const [a] = users;
    const receiver = giftsTo.get(a)!;

    const santaView = (await a.agent.get(chatOf(eventId, 'sender')).expect(200))
      .body as ChatView;
    expect(santaView).toMatchObject({
      chatId: null,
      role: 'sender',
      messages: [],
      unread: 0,
      recipient: { name: receiver.name, avatarUrl: null, interests: [] },
    });

    const receiverView = (
      await receiver.agent.get(chatOf(eventId, 'recipient')).expect(200)
    ).body as ChatView;
    expect(Object.keys(receiverView).sort()).toEqual(
      ['chatId', 'event', 'hasMore', 'messages', 'role', 'unread'].sort(),
    );
    expect(receiverView.chatId).toBeNull();

    // Nothing to answer yet
    await receiver.agent
      .post(chatOf(eventId, 'recipient', '/messages'))
      .send({ content: 'Hello?' })
      .expect(409);
  });

  it('delivers a question at once — to the recipient without the Santa in it', async () => {
    const [a] = users;
    const receiver = giftsTo.get(a)!;
    const third = users.find((u) => u !== a && u !== receiver)!;

    const socketA = await connect(a);
    const socketR = await connect(receiver);
    const socketThird = await connect(third);
    const thirdReceived: unknown[] = [];
    socketThird.onAny((_event: string, payload: unknown) =>
      thirdReceived.push(payload),
    );

    const toReceiver = next(socketR, SantaChatRealtimeEvent.message);
    const toSanta = next(socketA, SantaChatRealtimeEvent.message);
    const res = await a.agent
      .post(chatOf(eventId, 'sender', '/messages'))
      .send({ content: '  Blue or black T-shirt?  ' })
      .expect(201);
    const sent = res.body as { chatId: string; message: Message };
    chatId = sent.chatId;
    const { message } = sent;

    expect(message.content).toBe('Blue or black T-shirt?');
    expect(message.isMine).toBe(true);
    expect(Object.keys(message).sort()).toEqual(
      ['content', 'createdAt', 'id', 'isMine'].sort(),
    );

    const received = await toReceiver;
    expect(received).toEqual({
      chatId,
      eventId,
      role: 'recipient',
      message: { ...message, isMine: false },
    });
    expectNoTraceOf(received, a);

    expect(await toSanta).toEqual({
      chatId,
      eventId,
      role: 'sender',
      message,
    });

    await settle();
    expect(thirdReceived).toEqual([]);
  });

  it('gives the recipient the history and an unread count — never the Santa', async () => {
    const [a] = users;
    const receiver = giftsTo.get(a)!;

    const res = await receiver.agent
      .get(chatOf(eventId, 'recipient'))
      .expect(200);
    const view = res.body as ChatView;
    expect(view.messages).toEqual([
      expect.objectContaining({
        content: 'Blue or black T-shirt?',
        isMine: false,
      }),
    ]);
    expect(view.unread).toBe(1);
    expect(view).not.toHaveProperty('recipient');
    expectNoTraceOf(res.body, a);

    const list = await receiver.agent.get('/api/santa-chats').expect(200);
    expect((list.body as { chats: unknown[] }).chats).toEqual([
      expect.objectContaining({ eventId, role: 'recipient', unread: 1 }),
    ]);
    expectNoTraceOf(list.body, a);
  });

  it("routes the recipient's answer to their own Santa — and only to them", async () => {
    const [a] = users;
    const receiver = giftsTo.get(a)!;
    const socketA = await connect(a);

    const toSanta = next(socketA, SantaChatRealtimeEvent.message);
    await receiver.agent
      .post(chatOf(eventId, 'recipient', '/messages'))
      .send({ content: 'Black, rather' })
      .expect(201);
    const payload = (await toSanta) as {
      role: string;
      message: Message;
    };
    expect(payload.role).toBe('sender');
    expect(payload.message).toMatchObject({
      content: 'Black, rather',
      isMine: false,
    });

    const santaView = (await a.agent.get(chatOf(eventId, 'sender')).expect(200))
      .body as ChatView;
    expect(santaView.messages.map((m) => [m.content, m.isMine])).toEqual([
      ['Blue or black T-shirt?', true],
      ['Black, rather', false],
    ]);
    expect(santaView.unread).toBe(1);
  });

  it('marks messages read for the reader only', async () => {
    const [a] = users;
    const receiver = giftsTo.get(a)!;
    const socketR = await connect(receiver);

    const readElsewhere = next(socketR, SantaChatRealtimeEvent.read);
    const res = await receiver.agent
      .post(chatOf(eventId, 'recipient', '/read'))
      .expect(200);
    expect(res.body).toEqual({ read: 1 });
    expect(await readElsewhere).toEqual({ eventId, role: 'recipient' });

    const view = (
      await receiver.agent.get(chatOf(eventId, 'recipient')).expect(200)
    ).body as ChatView;
    expect(view.unread).toBe(0);
    // The Santa's own unread (the answer) is untouched
    const santaView = (await a.agent.get(chatOf(eventId, 'sender')).expect(200))
      .body as ChatView;
    expect(santaView.unread).toBe(1);
  });

  it("keeps everyone else's pair out of reach", async () => {
    const [a] = users;
    const receiver = giftsTo.get(a)!;
    const third = users.find((u) => u !== a && u !== receiver)!;

    // The third person's own chats: none written yet — not the a → receiver one
    const asRecipient = (
      await third.agent.get(chatOf(eventId, 'recipient')).expect(200)
    ).body as ChatView;
    expect(asRecipient.chatId).toBeNull();
    expect(asRecipient.messages).toEqual([]);
    expect(
      (
        (await third.agent.get('/api/santa-chats').expect(200)).body as {
          chats: unknown[];
        }
      ).chats,
    ).toEqual([]);

    // A message id from someone else's chat as the cursor: an empty page, not their history
    const { messages } = (
      await a.agent.get(chatOf(eventId, 'sender')).expect(200)
    ).body as ChatView;
    const asSender = (
      await third.agent
        .get(chatOf(eventId, 'sender', `?before=${messages[1].id}`))
        .expect(200)
    ).body as ChatView;
    expect(asSender.messages).toEqual([]);

    // Ids from the client never choose the pair
    await third.agent
      .post(chatOf(eventId, 'sender', '/messages'))
      .send({ content: 'hi', recipientId: a.id })
      .expect(400);
  });

  it('validates messages', async () => {
    const [a] = users;
    for (const content of ['', '   ', 'x'.repeat(1001), { text: 'hi' }, 42]) {
      await a.agent
        .post(chatOf(eventId, 'sender', '/messages'))
        .send({ content })
        .expect(400);
    }
  });

  it('stays readable but closes for new messages once the event is finished', async () => {
    const [a] = users;
    await a.agent.post(`/api/events/${eventId}/complete`).expect(200);
    await a.agent.get(chatOf(eventId, 'sender')).expect(200);
    await a.agent
      .post(chatOf(eventId, 'sender', '/messages'))
      .send({ content: 'Too late' })
      .expect(409);
  });

  it('goes with the event when it is deleted', async () => {
    await users[0].agent.delete(`/api/events/${eventId}`).expect(204);
    const [left] = await t.db.query<{ count: number }>(
      `select (select count(*)::int from secret_santa_chats where id = $1)
         + (select count(*)::int from secret_santa_messages where chat_id = $1) as count`,
      [chatId],
    );
    expect(left.count).toBe(0);
  });
});
