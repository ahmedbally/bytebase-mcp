/**
 * Session lifecycle: keep a valid OAuth access token available on demand.
 *
 * There is no background daemon and no browser automation. The MCP server
 * calls `reauthenticate()` when a request returns 401, which drives the
 * locked OAuth refresh in oauthtoken.ts (the MCP SDK's refresh path). When
 * the grant itself is dead (refresh token rejected/expired) the error tells
 * you to re-run the login.
 *
 * Everything here logs to STDERR: the MCP server owns stdout as its transport.
 */

export const log = (msg: string): void => {
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
};

let reauthInFlight: { promise: Promise<void>; stale?: string } | null = null;

/**
 * The 401 hook the MCP client calls. Forces a locked token refresh (the stale
 * token is presented so the lock holder can tell whether another process
 * already fixed it), then returns. Concurrent 401s share one run. Throws when
 * the grant is dead, so the original request surfaces a clear error.
 */
export function reauthenticate(staleToken?: string): Promise<void> {
  // A run that already knows about an equally-old token satisfies this caller.
  if (reauthInFlight && reauthInFlight.stale === staleToken) {
    return reauthInFlight.promise;
  }
  const entry = {
    stale: staleToken,
    promise: doReauthenticate(staleToken).finally(() => {
      if (reauthInFlight === entry) reauthInFlight = null;
    }),
  };
  reauthInFlight = entry;
  return entry.promise;
}

async function doReauthenticate(staleToken?: string): Promise<void> {
  const { getAccessToken, OAuthError } = await import('./oauthtoken.js');
  try {
    // Passing the stale token forces a refresh unless another process already
    // replaced it while we waited for the lock.
    await getAccessToken(staleToken);
    log('token refreshed');
  } catch (err) {
    if (err instanceof OAuthError && err.needsLogin) {
      log('OAuth grant is dead - re-run the login to repair it');
    } else {
      log(`reauth failed: ${(err as Error).message}`);
    }
    throw err;
  }
}
