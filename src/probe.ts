#!/usr/bin/env node
/**
 * Preflight diagnostic: `npm run probe`.
 *
 * Checks, in order, the things that actually break in practice:
 *   1. TLS  — this Bytebase serves an incomplete chain (leaf only), so Node
 *             needs the issuing CA even though browsers and curl are fine.
 *   2. Proxy— Node's fetch ignores HTTPS_PROXY unless a dispatcher is wired.
 *   3. Grant— a usable OAuth grant must exist; refresh happens on demand.
 *   4. Scope— a project-scoped identity sees only some projects/databases.
 */

import { existsSync } from 'node:fs';

import { BytebaseClient, BytebaseError } from './client.js';
import { Catalog } from './catalog.js';
import { loadDotEnv } from './env.js';
import { getAccessToken, hasGrant } from './oauthtoken.js';

loadDotEnv();

const BASE_URL = process.env.BYTEBASE_URL ?? '';

function line(status: 'ok' | 'fail' | 'warn', label: string, detail: string) {
  const mark = status === 'ok' ? '[ ok ]' : status === 'warn' ? '[warn]' : '[FAIL]';
  console.log(`${mark} ${label.padEnd(22)} ${detail}`);
}

async function main() {
  console.log(`\nbytebase-mcp preflight\n${'-'.repeat(60)}`);

  if (!BASE_URL) {
    line('fail', 'BYTEBASE_URL', 'not set');
    process.exit(1);
  }
  line('ok', 'BYTEBASE_URL', BASE_URL);

  const proxy = process.env.BYTEBASE_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  line(proxy ? 'ok' : 'warn', 'proxy', proxy ?? 'none set (fine on a direct network)');
  const caPath = process.env.BYTEBASE_CA_FILE ?? process.env.NODE_EXTRA_CA_CERTS;
  const caInUse = caPath && existsSync(caPath) ? caPath : undefined;
  line(caInUse ? 'ok' : 'warn', 'extra CA', caInUse ?? 'none set — fine for publicly-trusted certs');

  if (!hasGrant()) {
    line('fail', 'OAuth grant', 'no stored credentials — run `npm run auth` to complete the PKCE login');
    process.exit(1);
  }
  line('ok', 'OAuth grant', 'present');

  const client = new BytebaseClient({ baseUrl: BASE_URL, token: () => getAccessToken() });

  try {
    const info = await client.actuatorInfo();
    line('ok', 'TLS + reachability', `Bytebase ${info.version ?? '?'}`);
  } catch (err) {
    const msg = (err as Error).message;
    line('fail', 'TLS + reachability', msg);
    if (/certificate/i.test(msg)) {
      console.log('\n  → The server likely serves an incomplete cert chain. Point BYTEBASE_CA_FILE');
      console.log('    at the missing intermediate/root PEM (or set NODE_EXTRA_CA_CERTS).');
    }
    process.exit(1);
  }

  let token = '';
  try {
    token = await getAccessToken();
    line('ok', 'access token', `usable (${token.slice(0, 12)}…)`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    line('fail', 'access token', msg.split('\n')[0] ?? msg);
    if (/grant is dead|refresh token was rejected/i.test(msg)) {
      console.log('\n  → The refresh token was consumed or expired. Re-run `npm run auth`.');
    }
    process.exit(1);
  }

  let identity = '';
  try {
    const me = await client.currentUser();
    identity = me.email ?? me.name ?? 'unknown';
    line('ok', 'identity', identity);
  } catch (err) {
    const e = err as BytebaseError;
    line('fail', 'identity', `HTTP ${e.httpStatus} ${e.code ?? ''} — ${e.message.split('\n')[0]}`);
    process.exit(1);
  }

  const catalog = new Catalog(client);
  try {
    const projects = await catalog.listProjects();
    line('ok', 'visible projects', `${projects.length}: ${projects.map((p) => p.title).join(', ')}`);
    const dbs = await catalog.listDatabases();
    line('ok', 'visible databases', String(dbs.length));
    const sample = dbs.slice(0, 8).map((d) => `${d.environment}/${d.instanceTitle}/${d.databaseName}`);
    if (sample.length) console.log(`       e.g. ${sample.join(', ')}`);
    if (dbs.length === 0) {
      line('warn', 'scope', 'identity can see no databases — it needs a project role such as sqlEditorUser');
    }
  } catch (err) {
    line('fail', 'catalog', (err as Error).message.split('\n')[0] ?? 'unknown error');
    process.exit(1);
  }

  console.log(`${'-'.repeat(60)}\nAll checks passed.\n`);
}

main().catch((err) => {
  console.error(`probe crashed: ${(err as Error).message}`);
  process.exit(1);
});
