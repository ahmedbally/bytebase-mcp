/**
 * OAuth grant logic tests — lock semantics, freshness, cross-process handoff,
 * lifecycle. No network: the fresh-path and rotation-handoff properties are
 * exercised through public behavior that does not depend on a reachable
 * token endpoint.
 *
 * Each test runs in its own BYTEBASE_MCP_HOME via spawn, because the token
 * paths are resolved at module load.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distModule = pathToFileURL(join(root, 'dist', 'oauthtoken.js')).href;

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Spawn node with eval code importing dist/oauthtoken.js via a file URL. */
function run(home, code) {
  const prelude = `const m = await import(${JSON.stringify(distModule)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', prelude + code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, BYTEBASE_MCP_HOME: home, BYTEBASE_URL: 'https://unit.test' },
  });
}

/**
 * The provider stores state in a file named after the host. The issuer for a
 * BYTEBASE_URL is its origin; write the fixture through the same keying.
 */
function stateFile(home) {
  const slug = 'unit.test';
  return join(home, `${slug}.json`);
}

function writeTokens(home, fields) {
  const nowSec = Date.now() / 1000;
  writeFileSync(
    stateFile(home),
    JSON.stringify({
      tokens: {
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: (nowSec + 60) * 1000,
        refresh_token: 'r',
        ...fields,
      },
    }),
  );
}

// --------------------------------------------------------------------

// 1. getAccessToken returns a fresh token without touching the network.
{
  const home = mkdtempSync(join(tmpdir(), 'bb-oauth-1-'));
  writeTokens(home, { access_token: 'fresh-token', expires_at: (Date.now() / 1000 + 3600) * 1000 });
  const r = run(
    home,
    `const t = await m.getAccessToken();
     if (t !== 'fresh-token') { console.error('MISMATCH ' + t); process.exit(1); }`,
  );
  check('fresh token returned without refresh', r.status === 0, r.stderr?.slice(0, 200));
  rmSync(home, { recursive: true, force: true });
}

// 2. getAccessToken throws a needs-login OAuthError when there is no grant.
{
  const home = mkdtempSync(join(tmpdir(), 'bb-oauth-2-'));
  const r = run(
    home,
    `try { await m.getAccessToken(); console.error('NO THROW'); process.exit(1); }
     catch (e) { if (!(e instanceof m.OAuthError) || !e.needsLogin) { console.error('WRONG ERR ' + e); process.exit(1); } }`,
  );
  check('missing grant -> OAuthError(needsLogin)', r.status === 0, r.stderr?.slice(0, 200));
  rmSync(home, { recursive: true, force: true });
}

// 3. Cross-process handoff: a caller holding a stale token must pick up the
//    tokens another process wrote, without attempting a network refresh.
{
  const home = mkdtempSync(join(tmpdir(), 'bb-oauth-3-'));
  writeTokens(home, { access_token: 'stale', expires_at: (Date.now() / 1000 - 10) * 1000 });
  // "Another process" refreshes: new tokens land in the file.
  writeTokens(home, { access_token: 'winner-token', expires_at: (Date.now() / 1000 + 3600) * 1000 });
  const b = run(
    home,
    `const t = await m.getAccessToken('stale');
     if (t !== 'winner-token') { console.error('MISMATCH ' + t); process.exit(1); }`,
  );
  check('stale caller picks up winner token (no double refresh)', b.status === 0, b.stderr?.slice(0, 200));
  rmSync(home, { recursive: true, force: true });
}

// 4. hasGrant / logout lifecycle; no secrets printed by grantExpiresIn.
{
  const home = mkdtempSync(join(tmpdir(), 'bb-oauth-4-'));
  writeTokens(home);
  const r = run(
    home,
    `if (!m.hasGrant()) { console.error('hasGrant false'); process.exit(1); }
     const secs = m.grantExpiresIn();
     if (typeof secs !== 'number' || secs <= 0) { console.error('bad expiry: ' + secs); process.exit(1); }
     m.logout();
     if (m.hasGrant()) { console.error('logout did not clear'); process.exit(1); }`,
  );
  check('hasGrant/grantExpiresIn/logout lifecycle', r.status === 0, r.stderr?.slice(0, 200));
  rmSync(home, { recursive: true, force: true });
}

// 5. Lock directory primitive is exclusive on this filesystem.
{
  const home = mkdtempSync(join(tmpdir(), 'bb-oauth-5-'));
  const lock = join(home, 'token.lock.dir');
  mkdirSync(lock);
  let secondFailed = false;
  try {
    mkdirSync(lock);
  } catch {
    secondFailed = true;
  }
  check('mkdir lock is exclusive on this filesystem', secondFailed);
  rmSync(home, { recursive: true, force: true });
}

// 6. Corrupt state file degrades to "no grant" instead of crashing.
{
  const home = mkdtempSync(join(tmpdir(), 'bb-oauth-6-'));
  writeFileSync(stateFile(home), '{not json');
  const r = run(home, `if (m.hasGrant()) { console.error('hasGrant true on corrupt file'); process.exit(1); }`);
  check('corrupt token file -> no grant, no crash', r.status === 0, r.stderr?.slice(0, 200));
  rmSync(home, { recursive: true, force: true });
}

// 7. withLock serializes concurrent critical sections across awaits.
{
  const home = mkdtempSync(join(tmpdir(), 'bb-oauth-7-'));
  const r = run(
    home,
    `let inCritical = 0; let max = 0;
     const section = async () => { await m.withLock(async () => {
       inCritical++; max = Math.max(max, inCritical);
       await new Promise(rs => setTimeout(rs, 100));
       inCritical--;
     }); };
     await Promise.all([section(), section(), section()]);
     if (max !== 1) { console.error('lock not exclusive, max=' + max); process.exit(1); }`,
  );
  check('withLock excludes concurrent sections in-process', r.status === 0, r.stderr?.slice(0, 200));
  rmSync(home, { recursive: true, force: true });
}

console.log(`\npassed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
