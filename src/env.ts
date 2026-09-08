/**
 * Minimal .env loader — no dependency, no-op when the file is absent.
 * Node 20 has --env-file but it hard-errors on a missing file, which makes it
 * awkward for an MCP server launched by a client that sets env vars directly.
 * Real environment variables always win over .env.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { packageRoot } from './paths.js';

export function loadDotEnv(): void {
  const own = resolve(packageRoot(), '.env');
  const fromCwd = resolve(process.cwd(), '.env');
  const candidates = fromCwd === own ? [own] : [fromCwd, own];

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    // MCP clients spawn us with cwd = their project: ignore an unrelated
    // project's .env so it can't shadow ours.
    if (path !== own && !/^\s*BYTEBASE_/m.test(raw)) continue;

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      if (!key || key in process.env) continue; // real env wins

      let value = line.slice(eq + 1).trim();
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length >= 2) value = value.slice(1, -1);

      process.env[key] = value;
    }
    return; // first file found wins
  }
}
