/**
 * Thin Bytebase Connect-RPC client.
 *
 * Bytebase 3.20 exposes its services over the Connect protocol at
 *   POST /bytebase.v1.<Service>/<Method>
 * with a plain JSON body. The legacy `/v1/...` REST gateway is only partially
 * wired in this version (e.g. ListDatabases has no REST route), so we speak
 * Connect for everything — it is what the web UI itself uses.
 */

import { fetchWithProxy } from './http.js';
import { packageRoot } from './paths.js';

export class BytebaseError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: string,
    readonly method?: string,
  ) {
    super(message);
    this.name = 'BytebaseError';
  }
}

export interface BytebaseClientOptions {
  baseUrl: string;
  /**
   * A static token, or a provider called per-request. The provider may be
   * async — the OAuth token source performs a locked refresh at the expiry
   * boundary. The provider form lets the session layer rotate the token in a
   * file while the MCP keeps running.
   */
  token: string | (() => string | Promise<string>);
  timeoutMs?: number;
  /**
   * Called once when a request returns 401, before a single retry. Receives
   * the token that went stale so a concurrent refresher (another process) is
   * detected instead of burning the single-use refresh token. The hook writes
   * new credentials that the token provider then re-reads. Lets the server
   * self-heal an expired token mid-request instead of failing the call.
   */
  reauthorize?: (staleToken?: string) => Promise<void>;
}

interface RawResponse {
  status: number;
  ok: boolean;
  parsed: any;
  text: string;
  /** The bearer token this request was sent with (for stale detection on 401). */
  staleToken: string;
}

export class BytebaseClient {
  private readonly baseUrl: string;
  private readonly tokenSource: string | (() => string | Promise<string>);
  private readonly timeoutMs: number;
  private readonly reauthorize?: (staleToken?: string) => Promise<void>;

  constructor(opts: BytebaseClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tokenSource = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.reauthorize = opts.reauthorize;
  }

  private get token(): string | Promise<string> {
    return typeof this.tokenSource === 'function' ? this.tokenSource() : this.tokenSource;
  }

  async rpc<T = any>(method: string, body: unknown = {}): Promise<T> {
    let r = await this.send(method, body);

    // Self-heal an expired token: reauthorize once with the stale token (so a
    // concurrent refresher in another process is detected instead of burning
    // the single-use refresh token), then retry with the fresh one.
    if (r.status === 401 && this.reauthorize) {
      const stale = r.staleToken;
      const recovered = await this.reauthorize(stale).then(
        () => true,
        (err) => {
          process.stderr.write(`bytebase-mcp: reauth failed: ${(err as Error).message}\n`);
          return false;
        },
      );
      if (recovered) r = await this.send(method, body);
    }

    if (!r.ok) {
      throw new BytebaseError(
        this.explain(r.status, r.parsed?.message ?? r.text, method),
        r.status,
        r.parsed?.code,
        method,
      );
    }
    return r.parsed as T;
  }

  private async send(method: string, body: unknown): Promise<RawResponse> {
    const url = `${this.baseUrl}/bytebase.v1.${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Captured per-request: the token actually sent, so a 401 can tell the
    // reauthorize hook exactly which token went stale.
    const sentToken = await this.token;

    let res: Response;
    try {
      res = await fetchWithProxy(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          Authorization: `Bearer ${sentToken}`,
        },
        body: JSON.stringify(body ?? {}),
        // The token is a bearer credential; never replay it to a redirect target.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const msg = (err as Error).name === 'AbortError'
        ? `Bytebase request timed out after ${this.timeoutMs}ms`
        : `Cannot reach Bytebase at ${this.baseUrl}: ${(err as Error).message}`;
      throw new BytebaseError(msg, 0, 'unavailable', method);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new BytebaseError(
        `Non-JSON response (HTTP ${res.status}) from ${method}: ${text.slice(0, 200)}`,
        res.status,
        undefined,
        method,
      );
    }
    return { status: res.status, ok: res.ok, parsed, text, staleToken: sentToken };
  }

  /** Turn Bytebase's terse RPC errors into something actionable. */
  private explain(status: number, message: string, method: string): string {
    const base = `${method} failed (HTTP ${status}): ${message}`;
    if (status === 401) {
      return (
        `${base}\n\nThe OAuth access token could not be refreshed. Run, in ${packageRoot()}:\n` +
        `  npm run auth\n` +
        `That starts the PKCE login and stores a fresh 30-day rolling grant.`
      );
    }
    if (status === 403) {
      return `${base}\n\nThe token's identity lacks the required permission. Note that project-scoped members cannot call workspace-wide list APIs (use the *_search variants, which this server already prefers).`;
    }
    return base;
  }

  /** Cheap liveness + version probe. Does not require auth. */
  async actuatorInfo(): Promise<{ version?: string; externalUrl?: string }> {
    const res = await fetchWithProxy(`${this.baseUrl}/v1/actuator/info`, {
      redirect: 'manual',
    });
    if (!res.ok) throw new BytebaseError(`actuator/info HTTP ${res.status}`, res.status);
    return (await res.json()) as { version?: string; externalUrl?: string };
  }

  async currentUser(): Promise<{ name?: string; email?: string }> {
    return this.rpc('UserService/GetCurrentUser', {});
  }
}
