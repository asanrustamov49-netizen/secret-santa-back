import request from 'supertest';
import { createTestApp, uniqueEmail, type TestApp } from './support';

// Regression: the global ValidationPipe converts payloads implicitly, so a JSON
// number 12345678 used to reach register/login as the password "12345678" (and
// `true` as "true"). A password must arrive as a string — nothing else is coerced.
// Accounts are e2e-authval-…@example.com, deleted before and after.

const PREFIX = 'e2e-authval';
// Digits only on purpose: the string an implicit conversion would have produced
const DIGITS_PASSWORD = '12345678';

describe('Register / login: password must be a string (e2e)', () => {
  let t: TestApp;
  const server = () => t.app.getHttpServer();

  beforeAll(async () => {
    t = await createTestApp(PREFIX);
  });

  afterAll(async () => {
    await t.cleanup();
    await t.app.close();
  });

  const register = (body: Record<string, unknown>) =>
    request(server()).post('/api/auth/register').send(body);
  const login = (body: Record<string, unknown>) =>
    request(server()).post('/api/auth/login').send(body);

  const accountExists = async (email: string) =>
    (await t.db.query(`select 1 from users where email = $1`, [email])).length >
    0;

  it.each([
    ['a number', 12345678],
    ['a boolean', true],
  ])('register refuses %s as the password', async (_label, password) => {
    const email = uniqueEmail(PREFIX);

    const res = await register({ name: 'Typed', email, password }).expect(400);

    expect(JSON.stringify(res.body.message)).toMatch(/password/i);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await accountExists(email)).toBe(false);
  });

  it.each([
    ['a number', 12345678],
    ['a boolean', true],
  ])('login refuses %s as the password', async (_label, password) => {
    // The string form would be the right password for this account
    const email = uniqueEmail(PREFIX);
    await register({ name: 'Typed', email, password: DIGITS_PASSWORD }).expect(
      201,
    );

    const res = await login({ email, password }).expect(400);

    expect(JSON.stringify(res.body.message)).toMatch(/password/i);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('still registers and logs in with a string password', async () => {
    const email = uniqueEmail(PREFIX);

    const created = await register({
      name: 'Typed',
      email,
      password: DIGITS_PASSWORD,
    }).expect(201);
    expect(created.body.user).toMatchObject({ email, hasPassword: true });

    const signedIn = await login({ email, password: DIGITS_PASSWORD }).expect(
      200,
    );
    expect(signedIn.body.user).toMatchObject({ email });
    expect(signedIn.headers['set-cookie']).toBeDefined();

    // Wrong string password: still the usual 401, not a validation error
    await login({ email, password: 'wrong-password' }).expect(401);
  });
});
