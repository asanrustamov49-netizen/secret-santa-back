import request from 'supertest';
import { RATE_LIMITS } from './../src/common/throttle/rate-limit';
import {
  activeSessions as activeSessionsOf,
  createTestApp,
  logIn,
  signUp as signUpIn,
  type Agent,
  type TestApp,
} from './support';

// Account foundation: the extended /auth/me, PATCH /account/preferences and
// POST /auth/logout-all — against the real app and database. Every account made
// here is e2e-account-…@example.com and is deleted before and after the run
// (cascade takes their sessions with them). Nothing else is touched.

/** Exactly what a user may look like on the wire — nothing more */
const PUBLIC_USER_KEYS = [
  'avatarUrl',
  'createdAt',
  'email',
  'hasGoogle',
  'hasPassword',
  'id',
  'interests',
  'name',
  'notifyEmail',
  'notifyInvites',
  'notifyReminders',
  'themePreference',
];

describe('Account foundation (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp('e2e-account');
  });

  afterAll(async () => {
    await t.cleanup();
    await t.app.close();
  });

  const app = () => t.app;
  const signUp = async () => {
    const account = await signUpIn(t.app, 'e2e-account');
    return { ...account, accessToken: account.cookies.access_token };
  };
  const activeSessions = (userId: string) => activeSessionsOf(t.db, userId);

  const me = async (agent: Agent) =>
    (await agent.get('/api/auth/me').expect(200)).body.user as Record<
      string,
      unknown
    >;

  describe('GET /api/auth/me', () => {
    it('returns the extended public user and never secrets', async () => {
      const { agent, email } = await signUp();
      const user = await me(agent);

      expect(Object.keys(user).sort()).toEqual(PUBLIC_USER_KEYS);
      expect(user).toMatchObject({
        email,
        hasPassword: true,
        hasGoogle: false,
        themePreference: 'system',
        notifyEmail: true,
        notifyReminders: true,
        notifyInvites: true,
      });
      const body = JSON.stringify(user);
      expect(body).not.toMatch(/password_?hash|google_?id|scrypt\$/i);
    });
  });

  describe('PATCH /api/account/preferences', () => {
    it('changes themePreference', async () => {
      const { agent } = await signUp();

      const res = await agent
        .patch('/api/account/preferences')
        .send({ themePreference: 'dark' })
        .expect(200);

      expect(res.body.user).toMatchObject({ themePreference: 'dark' });
      expect(Object.keys(res.body.user).sort()).toEqual(PUBLIC_USER_KEYS);
      expect(await me(agent)).toMatchObject({ themePreference: 'dark' });
    });

    it('changes notification settings', async () => {
      const { agent } = await signUp();

      await agent
        .patch('/api/account/preferences')
        .send({
          notifyEmail: false,
          notifyReminders: false,
          notifyInvites: false,
        })
        .expect(200);

      expect(await me(agent)).toMatchObject({
        notifyEmail: false,
        notifyReminders: false,
        notifyInvites: false,
      });
    });

    it('changes only the one field that was sent', async () => {
      const { agent } = await signUp();
      await agent
        .patch('/api/account/preferences')
        .send({ themePreference: 'light' })
        .expect(200);

      await agent
        .patch('/api/account/preferences')
        .send({ notifyReminders: false })
        .expect(200);

      expect(await me(agent)).toMatchObject({
        themePreference: 'light', // from the earlier call — untouched
        notifyEmail: true,
        notifyReminders: false,
        notifyInvites: true,
      });
    });

    it.each([
      ['an unknown theme', { themePreference: 'purple' }],
      ['a theme in the wrong case', { themePreference: 'DARK' }],
      ['a boolean sent as a string', { notifyEmail: 'false' }],
      ['a boolean sent as a number', { notifyInvites: 1 }],
      ['null', { notifyReminders: null }],
      ['null theme', { themePreference: null }],
    ])('rejects %s and changes nothing', async (_label, body) => {
      const { agent } = await signUp();

      await agent.patch('/api/account/preferences').send(body).expect(400);

      expect(await me(agent)).toMatchObject({
        themePreference: 'system',
        notifyEmail: true,
        notifyReminders: true,
        notifyInvites: true,
      });
    });

    it('rejects an empty body', async () => {
      const { agent } = await signUp();
      await agent.patch('/api/account/preferences').send({}).expect(400);
    });

    it('rejects unknown fields, even next to valid ones', async () => {
      const { agent } = await signUp();

      for (const body of [
        { themePreference: 'dark', isAdmin: true },
        { notifyEmail: false, email: 'someone-else@example.com' },
        { notifyEmail: false, passwordHash: 'x' },
      ]) {
        await agent.patch('/api/account/preferences').send(body).expect(400);
      }
      expect(await me(agent)).toMatchObject({
        themePreference: 'system',
        notifyEmail: true,
      });
    });

    it("cannot reach another user's settings", async () => {
      const alice = await signUp();
      const bob = await signUp();

      // No way to name a target: an id in the body is an unknown field…
      await alice.agent
        .patch('/api/account/preferences')
        .send({ userId: bob.id, notifyEmail: false })
        .expect(400);
      // …and a real change only ever lands on the caller
      await alice.agent
        .patch('/api/account/preferences')
        .send({ themePreference: 'dark', notifyEmail: false })
        .expect(200);

      expect(await me(bob.agent)).toMatchObject({
        themePreference: 'system',
        notifyEmail: true,
      });
    });
  });

  describe('unauthenticated', () => {
    it.each([
      ['GET', '/api/auth/me'],
      ['PATCH', '/api/account/preferences'],
      ['POST', '/api/auth/logout-all'],
    ])('%s %s → 401', async (method, path) => {
      const server = request(app().getHttpServer());
      const call =
        method === 'GET'
          ? server.get(path)
          : method === 'PATCH'
            ? server.patch(path).send({ themePreference: 'dark' })
            : server.post(path);
      await call.expect(401);
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('revokes every other refresh session and keeps this one', async () => {
      // Three devices: the sign-up session and two more logins
      const { agent: phone, email, id } = await signUp();
      const laptop = await logIn(t.app, email);
      const tablet = await logIn(t.app, email);
      // Somebody else's session must survive
      const other = await signUp();
      expect(await activeSessions(id)).toBe(3);

      const res = await phone.post('/api/auth/logout-all').expect(204);

      expect(await activeSessions(id)).toBe(1);
      expect(await activeSessions(other.id)).toBe(1);
      // This device keeps its cookies and its session…
      expect(res.headers['set-cookie']).toBeUndefined();
      await phone.get('/api/auth/me').expect(200);
      await phone.post('/api/auth/refresh').expect(200);
      // …the others can't renew theirs any more
      await laptop.post('/api/auth/refresh').expect(401);
      await tablet.post('/api/auth/refresh').expect(401);
      // The other user is unaffected
      await other.agent.post('/api/auth/refresh').expect(200);
    });

    it(`is rate limited per user (${RATE_LIMITS.sessions.limit} per minute)`, async () => {
      const { accessToken } = await signUp();
      const call = () =>
        request(app().getHttpServer())
          .post('/api/auth/logout-all')
          .set('Authorization', `Bearer ${accessToken}`);

      for (let i = 0; i < RATE_LIMITS.sessions.limit; i++) {
        await call().expect(204);
      }
      await call().expect(429);

      // A different user has their own budget
      const someoneElse = await signUp();
      await someoneElse.agent.post('/api/auth/logout-all').expect(204);
    });
  });
});
