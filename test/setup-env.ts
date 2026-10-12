import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Jest runs each test file in a sandbox with its own copy of process.env, so the
// app's process.loadEnvFile('.env') (src/config/env.ts) never reaches it. Load the
// same file here, inside the sandbox. Variables already set in the shell win.
if (existsSync('.env')) {
  const fromFile = parseEnv(readFileSync('.env', 'utf8'));
  for (const [key, value] of Object.entries(fromFile)) {
    process.env[key] ??= value;
  }
}

// Every suite signs up and logs in many accounts from one address, all in the shared
// "unverified" bucket: generous limits here, unless the shell sets its own.
process.env.AUTH_LOGIN_LIMIT ??= '100000';
process.env.AUTH_REGISTER_LIMIT ??= '100000';
process.env.AUTH_UNVERIFIED_LOGIN_LIMIT ??= '100000';
process.env.AUTH_UNVERIFIED_REGISTER_LIMIT ??= '100000';
