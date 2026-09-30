import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { RealtimeEvent } from './../src/realtime/realtime.events';
import {
  type Agent,
  createTestApp,
  logIn,
  signUp,
  type TestApp,
} from './support';

// Realtime against the real app and database, with real Socket.IO clients.
//
// Test data (all deleted in afterAll, and before the suite in case a run was interrupted):
// 5 accounts rt-e2e-<uuid>@example.com — A (organizer), B, C (participants), E (joins,
// then is removed), D (outsider) — A's event, its participants and matches.
// cleanup() deletes the accounts by that email pattern; the rest cascades.

const PREFIX = 'rt-e2e';

interface User {
  agent: Agent;
  email: string;
  id: string;
}

/** Everything a socket received, in order — to prove what was (not) sent */
type Received = { event: string; payload: unknown }[];

describe('Realtime (e2e)', () => {
  let t: TestApp;
  let url: string;
  let a: User, b: User, c: User, d: User, e: User;
  let eventId: string;
  let inviteCode: string;
  let socketA: Socket, socketD: Socket, socketE: Socket;
  const sockets: Socket[] = [];
  const received = new Map<Socket, Received>();

  const ticketOf = async (agent: Agent) =>
    (
      (await agent.get('/api/realtime/ticket').expect(200)).body as {
        ticket: string;
      }
    ).ticket;

  /** A connected socket — or the connect error */
  const open = (auth: Record<string, unknown>) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(url, {
        auth,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      const log: Received = [];
      received.set(socket, log);
      socket.onAny((event: string, payload: unknown) =>
        log.push({ event, payload }),
      );
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (error) => reject(error));
    });

  const connect = async (user: User) =>
    open({ ticket: await ticketOf(user.agent) });

  const join = (socket: Socket, id: string) =>
    socket.emitWithAck('event:join', { eventId: id }) as Promise<{
      ok: boolean;
    }>;

  /** The next `event` on this socket — fails after a timeout */
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

  /** Give in-flight messages a moment to arrive (for "nothing arrived" checks) */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

  beforeAll(async () => {
    t = await createTestApp(PREFIX);
    await t.app.listen(0);
    const server = t.app.getHttpServer() as unknown as Server;
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;

    [a, b, c, d, e] = await Promise.all(
      [1, 2, 3, 4, 5].map(() => signUp(t.app, PREFIX)),
    );
    await b.agent
      .patch('/api/profile')
      .send({ name: 'Bravo Secret' })
      .expect(200);
    await c.agent
      .patch('/api/profile')
      .send({ name: 'Charlie Secret' })
      .expect(200);

    const created = await a.agent
      .post('/api/events')
      .send({ name: 'Realtime e2e event' })
      .expect(201);
    ({ id: eventId, inviteCode } = (
      created.body as { event: { id: string; inviteCode: string } }
    ).event);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await t.cleanup();
    await t.app.close();
  });

  it('refuses a socket without a ticket, or with a forged one', async () => {
    await expect(open({})).rejects.toThrow('unauthorized');
    await expect(open({ ticket: 'not-a-ticket' })).rejects.toThrow(
      'unauthorized',
    );
  });

  it('gives tickets to signed-in users only', async () => {
    await request(t.app.getHttpServer())
      .get('/api/realtime/ticket')
      .expect(401);
  });

  it('refuses a ticket whose session has ended', async () => {
    const other = await logIn(t.app, a.email);
    const ticket = await ticketOf(other);
    // "Log out of all other devices" from A's first session ends `other`
    await a.agent.post('/api/auth/logout-all').expect(204);
    await expect(open({ ticket })).rejects.toThrow('unauthorized');
  });

  it('lets a participant listen to their event, and nobody else', async () => {
    socketA = await connect(a);
    expect(await join(socketA, eventId)).toEqual({ ok: true });

    socketD = await connect(d);
    expect(await join(socketD, eventId)).toEqual({ ok: false });
    expect(await join(socketD, 'not-a-uuid')).toEqual({ ok: false });
  });

  it('tells the event when someone joins — the event id only', async () => {
    const joined = next(socketA, RealtimeEvent.participantJoined);
    await b.agent.post(`/api/invites/${inviteCode}/join`).expect(200);
    expect(await joined).toEqual({ eventId });

    await c.agent.post(`/api/invites/${inviteCode}/join`).expect(200);
    await e.agent.post(`/api/invites/${inviteCode}/join`).expect(200);
  });

  it('tells the event when a participant changes their profile or wishlist', async () => {
    const updated = next(socketA, RealtimeEvent.participantUpdated);
    await b.agent
      .patch('/api/profile')
      .send({ interests: ['realtime'] })
      .expect(200);
    expect(await updated).toEqual({ eventId });

    const wishlist = next(socketA, RealtimeEvent.wishlistUpdated);
    await b.agent
      .post('/api/profile/wishlist')
      .send({ title: 'bravo-realtime-gift' })
      .expect(201);
    expect(await wishlist).toEqual({ eventId });
  });

  it('tells participants when the organizer edits the event', async () => {
    const socketB = await connect(b);
    expect(await join(socketB, eventId)).toEqual({ ok: true });
    const updated = next(socketB, RealtimeEvent.updated);
    await a.agent
      .patch(`/api/events/${eventId}`)
      .send({ budgetMax: 3000 })
      .expect(200);
    expect(await updated).toEqual({ eventId });
  });

  it('takes a removed participant out of the room and tells them privately', async () => {
    socketE = await connect(e);
    expect(await join(socketE, eventId)).toEqual({ ok: true });

    const details = await a.agent.get(`/api/events/${eventId}`).expect(200);
    const participantE = (
      details.body as { participants: { id: string; userId: string }[] }
    ).participants.find((p) => p.userId === e.id)!;

    const removed = next(socketE, RealtimeEvent.removed);
    await a.agent
      .delete(`/api/events/${eventId}/participants/${participantE.id}`)
      .expect(204);
    expect(await removed).toEqual({ eventId });

    // Out for good: no way back into the room
    expect(await join(socketE, eventId)).toEqual({ ok: false });
  });

  it('announces the draw to participants without any pair in it', async () => {
    const socketB = await connect(b);
    const socketC = await connect(c);
    await join(socketB, eventId);
    await join(socketC, eventId);

    const toB = next(socketB, RealtimeEvent.drawCompleted);
    const toC = next(socketC, RealtimeEvent.drawCompleted);
    await a.agent.post(`/api/events/${eventId}/draw`).expect(200);

    // Exactly the event id — no recipient, no match, no names
    expect(await toB).toEqual({ eventId });
    expect(await toC).toEqual({ eventId });

    // The recipient comes from the REST endpoint only, only one's own, only once opened
    const match = await b.agent.get(`/api/events/${eventId}/match`).expect(200);
    expect(match.body.recipient).toBeNull();
  });

  it('never sends pairs, names or someone else’s event to anyone', async () => {
    await settle();
    const logs = [...received.values()];

    // Every message anyone got is { eventId } and nothing else
    for (const log of logs) {
      for (const { payload } of log) {
        expect(Object.keys(payload as object)).toEqual(['eventId']);
      }
    }
    const everything = JSON.stringify(logs);
    for (const secret of [
      'Bravo Secret',
      'Charlie Secret',
      'bravo-realtime-gift',
      'recipient',
      'receiver',
      'giver',
      '@example.com',
    ]) {
      expect(everything).not.toContain(secret);
    }

    // The outsider heard nothing; the removed participant only that they were removed
    expect(received.get(socketD)).toEqual([]);
    expect(received.get(socketE)!.map((m) => m.event)).toEqual([
      RealtimeEvent.removed,
    ]);
  });

  it('works again after a reconnect: a fresh ticket, the room joined again', async () => {
    const first = await connect(b);
    await join(first, eventId);
    first.disconnect();

    const again = await connect(b);
    expect(await join(again, eventId)).toEqual({ ok: true });
    const completed = next(again, RealtimeEvent.completed);
    await a.agent.post(`/api/events/${eventId}/complete`).expect(200);
    expect(await completed).toEqual({ eventId });
  });
});
