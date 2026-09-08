/**
 * Resolves the bearer token the client sends — OAuth only, via the MCP SDK's
 * standard 2.1 flow (PKCE public client, dynamic registration, rotating
 * refresh token under a cross-process lock).
 */

import { minutesUntilExpiry } from './jwt.js';
import { getAccessToken, hasGrant } from './oauthtoken.js';

export interface TokenSource {
  get(): Promise<string>;
  describe(): string;
  /** Minutes until the JWT expires; undefined if not a decodable JWT. */
  minutesLeft(): Promise<number | undefined>;
}

export function makeTokenSource(): TokenSource {
  return {
    get: () => getAccessToken(),
    describe: () =>
      hasGrant() ? 'OAuth grant (MCP 2.1, shared)' : 'no OAuth grant — run the login',
    minutesLeft: async () => minutesUntilExpiry(await getAccessToken()),
  };
}
