#!/usr/bin/env node
/**
 * `npm run auth` — drive the standard MCP OAuth 2.1 flow.
 *
 *   (no flags)   discovery → dynamic registration → PKCE authorization with
 *                a loopback listener waiting for the browser redirect
 *   --print-url  print the authorization URL and exit without waiting
 *   --status     grant health, no secrets
 *   --logout     delete stored tokens (keeps the client registration)
 *
 * Uses the MCP SDK's auth() — the same OAuth 2.1 flow MCP clients run
 * against remote MCP servers. No browser automation: the approval page is
 * opened in whatever browser you point at the printed URL.
 */

import { getAccessToken, grantExpiresIn, hasGrant, logout, runLogin } from './oauthtoken.js';
import { loadDotEnv } from './env.js';

loadDotEnv();

const argv = process.argv.slice(2);

async function status(): Promise<number> {
  if (!hasGrant()) {
    console.log('no stored OAuth tokens - run: npm run auth');
    return 1;
  }
  const secs = grantExpiresIn();
  console.log(
    secs === undefined
      ? 'tokens present (expiry unknown)'
      : `access token expires in ${Math.max(0, Math.round(secs / 60))} min`,
  );
  try {
    const token = await getAccessToken();
    console.log(`access token : usable (${token.slice(0, 12)}…)`);
    return 0;
  } catch (err) {
    console.log(`access token : NOT usable (${(err as Error).message})`);
    return 1;
  }
}

async function main(): Promise<void> {
  if (!process.env.BYTEBASE_URL) {
    console.error('auth: BYTEBASE_URL is not set (check .env).');
    process.exit(1);
  }

  if (argv.includes('--status')) process.exit(await status());
  if (argv.includes('--logout')) {
    logout();
    console.log('Stored OAuth tokens removed.');
    process.exit(0);
  }

  const printUrlOnly = argv.includes('--print-url');
  try {
    const result = await runLogin({
      waitForCallback: !printUrlOnly,
      print: console.log,
    });
    if (result === 'AUTHORIZED') {
      console.log('Bytebase authenticated. The refresh token rolls for 30 days.');
      process.exit(0);
    }
    // --print-url path: URL already printed by the callback.
    process.exit(0);
  } catch (err) {
    console.error(`auth failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

process.on('SIGINT', () => process.exit(0));

main().catch((err) => {
  console.error(`auth failed: ${(err as Error).message}`);
  process.exit(1);
});
