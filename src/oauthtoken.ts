/**
 * File-backed OAuthClientProvider implementing the MCP SDK's standard auth
 * interface — the same OAuth 2.1 flow every MCP client (Claude Code,
 * opencode, Cursor) uses against remote MCP servers. No custom CLI login:
 * the MCP client itself, or any tool that speaks the SDK's auth() flow,
 * drives authorization.
 *
 * Why the SDK flow instead of our own: the SDK handles RFC 9728 protected-
 * resource discovery, RFC 7591 dynamic registration, PKCE (S256), refresh
 * with proper error taxonomy, and credential invalidation/retry. We only own
 * storage — one JSON file per host under ~/.config/bytebase-mcp/, shared by
 * every process on this machine, written atomically.
 *
 * Why storage still matters here: Bytebase's refresh token is SINGLE-USE with
 * no reuse grace. Multiple MCP processes sharing one file must not both
 * present it. The SDK serializes a flow within one process; the mkdir lock
 * below serializes the file across processes, and the token getter re-reads
 * after taking the lock so a loser picks up the winner's tokens instead of
 * burning the refresh token again.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';

import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { fetchWithProxy } from './http.js';

/** The OAuth "server URL" the SDK expects: the resource we are authorizing to. */
export function resourceUrl(): string {
  return (process.env.BYTEBASE_URL ?? '').replace(/\/+$/, '');
}

const CONFIG_DIR = resolve(
  process.env.BYTEBASE_MCP_HOME ?? join(homedir(), '.config', 'bytebase-mcp'),
);
const LOCK_DIR = join(CONFIG_DIR, 'token.lock.dir');
/** Stale-lock age after which a crashed holder's lock is broken (ms). */
const LOCK_STALE_MS = 60_000;
const CALLBACK_PORT = Number(process.env.BYTEBASE_CALLBACK_PORT ?? 51789);
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const CALLBACK_TIMEOUT_MS = Number(process.env.BYTEBASE_LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);

/** Provider state persisted per authorization server. */
interface StoredState {
  client_information?: OAuthClientInformationMixed;
  tokens?: OAuthTokens & { expires_at?: number };
  code_verifier?: string;
  /** authorization URL from the last REDIRECT result, for resume flows. */
  pending_authorization_url?: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly needsLogin: boolean,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

// ------------------------------------------------------------------ storage

function statePath(authorizationServerUrl: string): string {
  // One file per issuer, hashed so any URL shape is filesystem-safe.
  const slug = authorizationServerUrl
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9.-]+/g, '_');
  return join(CONFIG_DIR, `${slug}.json`);
}

function readState(authorizationServerUrl: string): StoredState {
  const p = statePath(authorizationServerUrl);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StoredState;
  } catch {
    return {};
  }
}

/** Atomic replace, owner-only perms (best effort on Windows). */
function writeState(authorizationServerUrl: string, state: StoredState): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const p = statePath(authorizationServerUrl);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * Cross-process exclusive lock via mkdir — atomic on Windows (NTFS) and
 * POSIX. A stale lock (holder crashed) is broken after LOCK_STALE_MS.
 */
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let acquired = false;
  for (let attempt = 0; !acquired; attempt++) {
    try {
      mkdirSync(LOCK_DIR);
      acquired = true;
    } catch {
      try {
        const st = statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Raced with the holder releasing; retry.
      }
      if (attempt > 600) throw new OAuthError('oauth lock contention timeout', false);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      // Best effort; stale-breaking covers the rest.
    }
  }
}

/** Derive the access-token expiry instant (ms). */
function tokenExpiry(tokens: OAuthTokens): number {
  return Date.now() + Number(tokens.expires_in ?? 3600) * 1000;
}

function isFresh(tokens: StoredState['tokens']): boolean {
  if (!tokens?.access_token) return false;
  const exp = tokens.expires_at ?? 0;
  // Re-mint with 120s skew so a slow request can't straddle the boundary.
  return Date.now() < exp - 120_000;
}

// ---------------------------------------------------------------- provider

/**
 * The SDK-facing provider. `authorizationServerUrl` is discovered by the SDK
 * (RFC 9728 or /.well-known/oauth-authorization-server); a CLI or MCP client
 * calls runAuthFlow() which drives auth() and handles the REDIRECT result.
 */
export function createProvider(): {
  provider: OAuthClientProviderLike;
  authorizationServerUrl: string;
} & OAuthClientProviderLike {
  // The authorization server URL is only known after discovery; but for a
  // Bytebase instance the issuer IS the instance base URL, so files are keyed
  // by it. Discovery may redirect elsewhere; keys stay stable.
  const issuer = resourceUrl();

  const provider: OAuthClientProviderLike = {
    get redirectUrl(): string {
      return REDIRECT_URI;
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'bytebase-mcp',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none', // public client (PKCE)
      };
    },

    state(): string {
      return randomBytes(16).toString('base64url');
    },

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
      return readState(issuer).client_information;
    },

    async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
      const s = readState(issuer);
      s.client_information = info;
      writeState(issuer, s);
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      return readState(issuer).tokens;
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      const s = readState(issuer);
      s.tokens = { ...tokens, expires_at: tokenExpiry(tokens) };
      delete s.pending_authorization_url;
      writeState(issuer, s);
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      const s = readState(issuer);
      s.pending_authorization_url = authorizationUrl.toString();
      writeState(issuer, s);
      onRedirect?.(authorizationUrl);
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      const s = readState(issuer);
      s.code_verifier = codeVerifier;
      writeState(issuer, s);
    },

    async codeVerifier(): Promise<string> {
      return (await readState(issuer).code_verifier) ?? '';
    },

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
      const s = readState(issuer);
      if (scope === 'all' || scope === 'client') delete s.client_information;
      if (scope === 'all' || scope === 'tokens') delete s.tokens;
      if (scope === 'all' || scope === 'verifier') delete s.code_verifier;
      writeState(issuer, s);
    },
  };

  return Object.assign(provider, {
    provider,
    authorizationServerUrl: issuer,
  });
}

/** Hook the login runner uses to capture the authorization URL. */
let onRedirect: ((url: URL) => void) | undefined;
export function setRedirectHandler(fn: ((url: URL) => void) | undefined): void {
  onRedirect = fn;
}

/** Subset of the SDK's OAuthClientProvider our provider implements. */
export interface OAuthClientProviderLike {
  get redirectUrl(): string | URL | undefined;
  get clientMetadata(): OAuthClientMetadata;
  state?(): string | Promise<string>;
  clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
  saveClientInformation?(clientInformation: OAuthClientInformationMixed): void | Promise<void>;
  tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): void | Promise<void>;
  redirectToAuthorization(authorizationUrl: URL): void | Promise<void>;
  saveCodeVerifier(codeVerifier: string): void | Promise<void>;
  codeVerifier(): string | Promise<string>;
  invalidateCredentials?(scope: 'all' | 'client' | 'tokens' | 'verifier'): void | Promise<void>;
}

// ------------------------------------------------------------ token access

/**
 * Return a usable access token for API calls. Refreshes under the cross-
 * process lock when stale; concurrent callers (processes) share safely: the
 * loser of the lock re-reads and picks up the winner's fresh tokens.
 *
 * Uses the SDK's refreshAuthorization directly — one code path for refresh,
 * whether driven by auth() or by a 401 here.
 */
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';

async function discoverAuthorizationServerUrl(): Promise<string> {
  // RFC 9728 against the resource; fall back to the classic well-known path.
  const base = resourceUrl();
  if (!base) throw new OAuthError('BYTEBASE_URL is not set', false);
  try {
    const res = await fetchWithProxy(`${base}/.well-known/oauth-authorization-server`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const meta = (await res.json()) as { authorization_endpoint: string };
      if (meta.authorization_endpoint && /^https:\/\//i.test(meta.authorization_endpoint)) {
        return base;
      }
    }
  } catch {
    // fall through — the SDK's auth() will run its own discovery on login.
  }
  return base;
}

async function fetchMetadataForRefresh(authorizationServerUrl: string) {
  const res = await fetchWithProxy(
    `${authorizationServerUrl.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw new OAuthError(`OAuth discovery failed (HTTP ${res.status})`, false);
  const meta = (await res.json()) as {
    token_endpoint: string;
    grant_types_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
  };
  if (!meta.token_endpoint || !/^https:\/\//i.test(meta.token_endpoint)) {
    throw new OAuthError('OAuth metadata has no valid token_endpoint', false);
  }
  return meta;
}

// Single-flight: concurrent callers within THIS process share one refresh.
let inflight: Promise<string> | null = null;

export function getAccessToken(stale?: string): Promise<string> {
  const issuer = resourceUrl();
  const tokens = readState(issuer).tokens;
  if (stale === undefined && isFresh(tokens)) return Promise.resolve(tokens!.access_token!);

  if (!inflight) {
    inflight = (async () =>
      withLock(async () => {
        const issuer2 = resourceUrl();
        const current = readState(issuer2).tokens;
        // Someone else refreshed while we blocked on the lock: their tokens
        // are the live ones; ours are not just stale but already consumed.
        if (isFresh(current) && current?.access_token !== stale) return current!.access_token!;
        if (!current?.refresh_token) {
          throw new OAuthError(
            `no stored OAuth credentials at ${statePath(issuer2)}. Run the login first.`,
            true,
          );
        }
        const client = (await createProvider().clientInformation())!;
        const asUrl = await discoverAuthorizationServerUrl();
        const meta = await fetchMetadataForRefresh(asUrl);
        try {
          const newTokens = await refreshAuthorization(asUrl, {
            metadata: meta as never,
            clientInformation: client,
            refreshToken: current.refresh_token,
            fetchFn: fetchWithProxy as never,
          });
          const state = readState(issuer2);
          state.tokens = { ...newTokens, expires_at: tokenExpiry(newTokens) };
          writeState(issuer2, state);
          return newTokens.access_token!;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const dead = /invalid_grant|invalid refresh/i.test(msg);
          throw new OAuthError(
            dead
              ? `the Bytebase refresh token was rejected. This grant is dead; re-run the login.`
              : `refresh failed: ${msg}`,
            dead,
          );
        }
      }))().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Whether a usable grant exists (fresh or refreshable). */
export function hasGrant(): boolean {
  const t = readState(resourceUrl()).tokens;
  return Boolean(t?.access_token || t?.refresh_token);
}

/** The stored access token's expiry-driven validity, or undefined. */
export function grantExpiresIn(): number | undefined {
  const t = readState(resourceUrl()).tokens;
  if (!t?.expires_at) return undefined;
  return Math.round((t.expires_at - Date.now()) / 1000);
}

/** The pending authorization URL after a REDIRECT result, if any. */
export function pendingAuthorizationUrl(): string | undefined {
  return readState(resourceUrl()).pending_authorization_url;
}

/** Delete stored tokens (never the client registration). */
export function logout(): void {
  const issuer = resourceUrl();
  const s = readState(issuer);
  delete s.tokens;
  delete s.code_verifier;
  delete s.pending_authorization_url;
  writeState(issuer, s);
}

// ------------------------------------------------------------- login flow

/**
 * Drive the SDK's standard auth() flow: discovery → dynamic registration →
 * PKCE authorization (returning the URL to open) → code exchange.
 *
 * Returns 'AUTHORIZED' when tokens are ready, or the authorization URL the
 * caller must open in a browser. After the browser redirects to the loopback
 * callback, call completeLogin(code) to finish the exchange — or pass
 * waitForCallback: true and this function runs the loopback listener itself.
 */
export async function runLogin(options: {
  waitForCallback?: boolean;
  print?: (s: string) => void;
}): Promise<'AUTHORIZED' | string> {
  const print = options.print ?? (() => {});
  const { provider } = createProvider();

  let result: 'AUTHORIZED' | 'REDIRECT' | string;
  if (options.waitForCallback) {
    const listener = listenForCallback();
    result = await mcpAuth(provider, { serverUrl: resourceUrl(), fetchFn: fetchWithProxy as never });
    if (result === 'REDIRECT') {
      const url = pendingAuthorizationUrl();
      print(`Open this URL, approve, and the flow will complete:\n\n${url}\n`);
      const code = await listener.result;
      if (code.error) throw new OAuthError(code.error, false);
      result = await mcpAuth(provider, {
        serverUrl: resourceUrl(),
        authorizationCode: code.code,
        fetchFn: fetchWithProxy as never,
      });
    }
    listener.close();
  } else {
    result = await mcpAuth(provider, { serverUrl: resourceUrl(), fetchFn: fetchWithProxy as never });
  }

  if (result === 'AUTHORIZED') return 'AUTHORIZED';
  return pendingAuthorizationUrl() ?? 'REDIRECT';
}

interface CallbackResult {
  code?: string;
  error?: string;
}

/** One-shot loopback server that captures the authorization redirect. */
function listenForCallback(): { result: Promise<CallbackResult>; close: () => void } {
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  const result = new Promise<CallbackResult>((resolvePromise) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(url.searchParams) as CallbackResult;
      const ok = 'code' in params;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        ok
          ? '<h2>Bytebase connected. You can close this tab.</h2>'
          : '<h2>Authorization failed. Check the terminal.</h2>',
      );
      resolvePromise(params);
      server?.close();
      if (timer) clearTimeout(timer);
    });
    server.on('error', (err) => resolvePromise({ error: err.message }));
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      /* listening */
    });
    timer = setTimeout(() => {
      resolvePromise({ error: `timed out after ${CALLBACK_TIMEOUT_MS / 1000}s` });
      server?.close();
    }, CALLBACK_TIMEOUT_MS);
  });
  return { result, close: () => server?.close() };
}
