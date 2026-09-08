/**
 * Shared outbound HTTP setup.
 *
 * Node's global fetch ignores HTTPS_PROXY — it needs an explicit dispatcher.
 * Extra CAs are strictly user-supplied via environment: BYTEBASE_CA_FILE or
 * NODE_EXTRA_CA_CERTS (the latter is read once at process start by Node itself,
 * so the env form is read here for .env-driven config). Nothing corporate or
 * site-specific is bundled.
 */

import { existsSync, readFileSync } from 'node:fs';
import { Agent, ProxyAgent } from 'undici';

function extraCa(): Buffer | undefined {
  const candidates = [process.env.BYTEBASE_CA_FILE, process.env.NODE_EXTRA_CA_CERTS].filter(
    (p): p is string => Boolean(p),
  );

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path);
    } catch {
      process.stderr.write(`bytebase-mcp: cannot read CA file "${path}"\n`);
    }
  }
  return undefined;
}

function build(): unknown | undefined {
  const url =
    process.env.BYTEBASE_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;

  const ca = extraCa();
  const tls = ca ? { ca } : undefined;

  if (!url) return tls ? new Agent({ connect: tls }) : undefined;

  try {
    return new ProxyAgent({ uri: url, ...(tls ? { requestTls: tls } : {}) });
  } catch {
    process.stderr.write(`bytebase-mcp: ignoring unparseable proxy URL "${url}"\n`);
    return tls ? new Agent({ connect: tls }) : undefined;
  }
}

/** Resolved lazily: ESM hoists imports, so .env must be applied first. */
let resolved = false;
let dispatcher: unknown | undefined;

function getDispatcher(): unknown | undefined {
  if (!resolved) {
    dispatcher = build();
    resolved = true;
  }
  return dispatcher;
}

/** fetch() with the proxy dispatcher and user-supplied CA applied. */
export function fetchWithProxy(url: string, init: RequestInit = {}): Promise<Response> {
  const d = getDispatcher();
  return fetch(url, { ...init, ...(d ? { dispatcher: d } : {}) } as RequestInit);
}
