import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { GoogleProfile } from './../src/auth/google.strategy';
import { RATE_LIMITS } from './../src/common/throttle/rate-limit';
import {
  activeSessions,
  cookieHeader,
  cookiesSet,
  createTestApp,
  logIn,
  PASSWORD,
  signUp,
  uniqueEmail,
  type TestApp,
} from './support';

// Password change (POST /account/password) and a first password for Google-only
// accounts (POST /account/password/set after a fresh Google re-authentication),
// against the real app and database. Google itself is stubbed at its guard.
// Accounts are e2e-password-…@example.com, deleted before and after.

const PREFIX = 'e2e-password';
const NEW_PASSWORD = 'a-brand-new-winter-password';
const CALLBACK = '/api/auth/google/callback';

describe('Password (e2e)', () => {
  let t: TestApp;
  const server = () => t.app.getHttpServer();

  beforeAll(async () => {
    t = await createTestApp(PREFIX);
  });

  afterAll(async () => {
    await t.cleanup();
    await t.app.close();
  });

  const change = (
    agent: ReturnType<typeof request.agent>,
    body: Record<string, unknown>,
  ) => agent.post('/api/account/password').send(body);

  const canLogIn = async (email: string, password: string) =>
    (await request(server()).post('/api/auth/login').send({ email, password }))
      .status === 200;

  describe('POST /api/account/password', () => {
    it('changes the password: this session stays, the others end', async () => {
      const { agent: phone, email, id } = await signUp(t.app, PREFIX);
      const laptop = await logIn(t.app, email);
      const other = await signUp(t.app, PREFIX);
      expect(await activeSessions(t.db, id)).toBe(2);

      await change(phone, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);

      // The current device keeps working and can still renew its session
      await phone.get('/api/auth/me').expect(200);
      await phone.post('/api/auth/refresh').expect(200);
      // The other device's refresh session was revoked
      await laptop.post('/api/auth/refresh').expect(401);
      expect(await activeSessions(t.db, id)).toBe(1);
      // Another user is untouched
      expect(await activeSessions(t.db, other.id)).toBe(1);
      expect(await canLogIn(other.email, PASSWORD)).toBe(true);
      // Old password no longer works, the new one does
      expect(await canLogIn(email, PASSWORD)).toBe(false);
      expect(await canLogIn(email, NEW_PASSWORD)).toBe(true);
    });

    it('refuses a wrong current password with 403 and changes nothing', async () => {
      const { agent, email, id } = await signUp(t.app, PREFIX);
      const laptop = await logIn(t.app, email);

      const res = await change(agent, {
        currentPassword: 'not-my-password',
        newPassword: NEW_PASSWORD,
      }).expect(403);

      expect(res.body.message).toBe('Current password is incorrect');
      expect(await canLogIn(email, PASSWORD)).toBe(true);
      expect(await canLogIn(email, NEW_PASSWORD)).toBe(false);
      await laptop.post('/api/auth/refresh').expect(200); // nobody signed out
      expect(await activeSessions(t.db, id)).toBeGreaterThanOrEqual(2);
    });

    it('refuses a new password equal to the current one', async () => {
      const { agent, email } = await signUp(t.app, PREFIX);

      const res = await change(agent, {
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      }).expect(400);

      expect(res.body.message).toMatch(/different/i);
      expect(await canLogIn(email, PASSWORD)).toBe(true);
    });

    it.each([
      ['too short', { currentPassword: PASSWORD, newPassword: 'short' }],
      ['too long', { currentPassword: PASSWORD, newPassword: 'x'.repeat(129) }],
      ['not a string', { currentPassword: PASSWORD, newPassword: 12345678 }],
      ['missing current', { newPassword: NEW_PASSWORD }],
      ['empty current', { currentPassword: '', newPassword: NEW_PASSWORD }],
      [
        'an unknown field',
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: 'x' },
      ],
    ])('rejects an invalid body (%s)', async (_label, body) => {
      const { agent, email } = await signUp(t.app, PREFIX);

      await change(agent, body).expect(400);

      expect(await canLogIn(email, PASSWORD)).toBe(true);
    });

    it('requires sign-in', async () => {
      await request(server())
        .post('/api/account/password')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);
    });

    it(`is rate limited per user (${RATE_LIMITS.sensitive.limit} per 15 min)`, async () => {
      const { agent } = await signUp(t.app, PREFIX);
      const guess = () =>
        change(agent, { currentPassword: 'guess', newPassword: NEW_PASSWORD });

      for (let i = 0; i < RATE_LIMITS.sensitive.limit; i++) {
        await guess().expect(403);
      }
      // Even the right password is refused now — guessing is capped
      await change(agent, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(429);

      // Someone else is not affected
      const other = await signUp(t.app, PREFIX);
      await change(other.agent, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);
    });
  });

  describe('Google-only accounts', () => {
    /** A Google-only account signed in through the (stubbed) Google callback */
    async function signInWithGoogle(googleId = `google-${randomUUID()}`) {
      const email = uniqueEmail(PREFIX);
      const profile: GoogleProfile = {
        googleId,
        email,
        emailVerified: true,
        name: 'Google Only',
        picture: undefined,
      };
      t.setGoogleProfile(profile);
      const res = await request(server()).get(CALLBACK).expect(302);
      expect(res.headers.location).toContain('/auth/callback');
      return { email, googleId, profile, cookies: cookiesSet(res) };
    }

    /** The ?intent=reauth round trip, arriving with the given refresh cookie */
    function reauth(profile: GoogleProfile, refreshToken?: string) {
      t.setGoogleProfile(profile);
      return request(server())
        .get(CALLBACK)
        .set(
          'Cookie',
          cookieHeader({
            google_oauth_intent: 'reauth',
            refresh_token: refreshToken,
          }),
        )
        .expect(302);
    }

    const setPassword = (
      cookies: Record<string, string | undefined>,
      body: Record<string, unknown> = { newPassword: NEW_PASSWORD },
    ) =>
      request(server())
        .post('/api/account/password/set')
        .set('Cookie', cookieHeader(cookies))
        .send(body);

    it('is a Google-only account: no password yet', async () => {
      const { cookies } = await signInWithGoogle();
      const res = await request(server())
        .get('/api/auth/me')
        .set('Cookie', cookieHeader({ access_token: cookies.access_token }))
        .expect(200);
      expect(res.body.user).toMatchObject({
        hasPassword: false,
        hasGoogle: true,
      });
    });

    it('cannot use the change-password endpoint', async () => {
      const { cookies } = await signInWithGoogle();

      const res = await request(server())
        .post('/api/account/password')
        .set('Cookie', cookieHeader({ access_token: cookies.access_token }))
        .send({ currentPassword: 'anything', newPassword: NEW_PASSWORD })
        .expect(409);
      expect(res.body.message).toMatch(/set one/i);
    });

    it('cannot set a password without a fresh Google re-authentication', async () => {
      const { cookies } = await signInWithGoogle();

      await setPassword({ access_token: cookies.access_token }).expect(403);
      await setPassword({
        access_token: cookies.access_token,
        reauth_grant: 'forged.grant.value',
      }).expect(403);
    });

    it('sets a password after re-authenticating with Google', async () => {
      const google = await signInWithGoogle();
      const [{ id: userId }] = await t.db.query<{ id: string }>(
        `select id from users where email = $1`,
        [google.email],
      );
      // A second device signs in with the same Google account
      t.setGoogleProfile(google.profile);
      const second = cookiesSet(
        await request(server()).get(CALLBACK).expect(302),
      );
      expect(await activeSessions(t.db, userId)).toBe(2);

      const back = await reauth(google.profile, google.cookies.refresh_token);

      // Back to Settings with a grant — and nobody was signed in by it
      expect(back.headers.location).toMatch(/\/settings\?reauth=ok$/);
      const got = cookiesSet(back);
      expect(Object.keys(got)).toEqual(['reauth_grant']);
      expect(await activeSessions(t.db, userId)).toBe(2);

      const res = await setPassword({
        access_token: google.cookies.access_token,
        reauth_grant: got.reauth_grant,
      }).expect(200);

      expect(res.body.user).toMatchObject({
        hasPassword: true,
        hasGoogle: true,
      });
      // The grant is spent
      const cleared = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(cleared.some((c) => c.startsWith('reauth_grant=;'))).toBe(true);
      // This device stays; the other Google session was ended
      await request(server())
        .post('/api/auth/refresh')
        .set(
          'Cookie',
          cookieHeader({ refresh_token: google.cookies.refresh_token }),
        )
        .expect(200);
      await request(server())
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader({ refresh_token: second.refresh_token }))
        .expect(401);
      // Email + the new password now work
      expect(await canLogIn(google.email, NEW_PASSWORD)).toBe(true);
      // And it can't be "set" twice — from now on it's a password change
      await setPassword({
        access_token: google.cookies.access_token,
        reauth_grant: got.reauth_grant,
      }).expect(409);
    });

    it('refuses to confirm with a different Google account', async () => {
      const google = await signInWithGoogle();
      const stranger = {
        ...google.profile,
        googleId: `google-${randomUUID()}`,
      };

      const back = await reauth(stranger, google.cookies.refresh_token);

      expect(back.headers.location).toMatch(
        /\/settings\?reauth=reauth_wrong_account$/,
      );
      expect(cookiesSet(back)).toEqual({});
    });

    it('refuses to confirm without a signed-in session', async () => {
      const google = await signInWithGoogle();

      const back = await reauth(google.profile, undefined);

      expect(back.headers.location).toMatch(
        /\/settings\?reauth=reauth_no_session$/,
      );
      expect(cookiesSet(back)).toEqual({});
    });

    it("won't accept another user's grant", async () => {
      const alice = await signInWithGoogle();
      const bob = await signInWithGoogle();
      const aliceGrant = cookiesSet(
        await reauth(alice.profile, alice.cookies.refresh_token),
      ).reauth_grant;

      await setPassword({
        access_token: bob.cookies.access_token,
        reauth_grant: aliceGrant,
      }).expect(403);
    });

    it('validates the new password like everywhere else', async () => {
      const google = await signInWithGoogle();
      const grant = cookiesSet(
        await reauth(google.profile, google.cookies.refresh_token),
      ).reauth_grant;
      const cookies = {
        access_token: google.cookies.access_token,
        reauth_grant: grant,
      };

      await setPassword(cookies, { newPassword: 'short' }).expect(400);
      await setPassword(cookies, {
        newPassword: NEW_PASSWORD,
        currentPassword: 'x',
      }).expect(400);
    });
  });
});
