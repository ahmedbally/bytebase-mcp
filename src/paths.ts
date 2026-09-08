/**
 * Filesystem anchors.
 *
 * Everything resolves against the package, never process.cwd(): the MCP server
 * is spawned by its client with an arbitrary working directory, so cwd-relative
 * paths silently point at the wrong place.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root - one level above the compiled dist/ that contains this file. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
