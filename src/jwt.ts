/**
 * JWT inspection.
 *
 * Read-only and signature-unaware on purpose: this exists to answer "how much
 * life is left in the token we hold", which is a scheduling question. The server
 * is the only thing that validates the signature.
 */

/** The `exp` claim in unix seconds, or undefined if the token is not a decodable JWT. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** Minutes until expiry — negative once expired, undefined if not a JWT. */
export function minutesUntilExpiry(token: string): number | undefined {
  const exp = jwtExpiry(token);
  return exp === undefined ? undefined : Math.round((exp * 1000 - Date.now()) / 60000);
}

/** Human phrasing of a token's remaining life, e.g. "valid ~42 min". */
export function describeExpiry(token: string): string {
  const m = minutesUntilExpiry(token);
  if (m === undefined) return 'expiry unknown';
  return m > 0 ? `valid ~${m} min` : `EXPIRED ${-m} min ago`;
}
