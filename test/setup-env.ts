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
