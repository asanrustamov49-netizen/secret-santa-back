// Unit tests (npm test) never touch a database or a paid API. src/config/env.ts insists
// on these variables, so they get placeholders — overriding any real ones from the
// shell, so a unit test can't reach the real database even by mistake.
// Services under test receive stand-ins for DatabaseService and the AI provider.
process.env.DATABASE_URL = 'postgres://unit-tests@127.0.0.1:1/never-connects';
process.env.DATABASE_SSL = 'false';
process.env.JWT_ACCESS_SECRET = 'unit-test-secret-not-used-for-real-tokens';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.AI_PROVIDER;
