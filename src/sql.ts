/**
 * Client-side read-only guard.
 *
 * Bytebase already enforces authorisation server-side (sqlEditorUser role, and
 * per-environment DML/DDL policy). This guard is defence in depth: it stops an
 * LLM from *attempting* a write against production, which would otherwise show
 * up as a denied-but-audited event on the user's own account.
 *
 * Set BYTEBASE_ALLOW_WRITE=true to disable it.
 */

const READ_ONLY_LEADERS = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'ANALYZE',
]);

/** Statements that must never appear, even inside a CTE (MySQL 8 allows WITH ... DELETE). */
const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT',
  'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'RENAME',
  'GRANT', 'REVOKE', 'SET', 'LOCK', 'UNLOCK',
  'CALL', 'DO', 'HANDLER', 'LOAD', 'IMPORT', 'INTO OUTFILE', 'INTO DUMPFILE',
  'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'START TRANSACTION', 'BEGIN',
  'KILL', 'SHUTDOWN', 'FLUSH', 'RESET', 'OPTIMIZE', 'REPAIR', 'INSTALL', 'UNINSTALL',
];

/** Remove comments and string/identifier literals so keyword scanning can't be fooled. */
function scrub(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    // /* block comment */
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    // -- line comment  (requires whitespace after in MySQL, but be strict)
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      out += ' ';
      continue;
    }
    // # line comment (MySQL)
    if (c === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      out += ' ';
      continue;
    }
    // quoted literal / identifier — replace whole span with a placeholder
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; } // escaped by doubling
          i++;
          break;
        }
        i++;
      }
      out += ' ? ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function splitStatements(sql: string): string[] {
  return scrub(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function assertReadOnly(sql: string): GuardResult {
  const statements = splitStatements(sql);

  if (statements.length === 0) {
    return { ok: false, reason: 'Statement is empty.' };
  }
  if (statements.length > 1) {
    return {
      ok: false,
      reason: `Multiple statements (${statements.length}) are not allowed in read-only mode. Send one query at a time.`,
    };
  }

  const stmt = statements[0]!;
  const upper = stmt.toUpperCase();
  const leader = upper.match(/^[A-Z_]+/)?.[0] ?? '';

  if (!READ_ONLY_LEADERS.has(leader)) {
    return {
      ok: false,
      reason:
        `Statement starts with "${leader || stmt.slice(0, 20)}", which is not read-only. ` +
        `Allowed: ${[...READ_ONLY_LEADERS].join(', ')}. ` +
        `Set BYTEBASE_ALLOW_WRITE=true to permit writes, or raise a Bytebase change issue instead.`,
    };
  }

  for (const kw of FORBIDDEN) {
    // \b on both sides so DELETED_AT / UPDATED_AT style identifiers do not trip it
    const re = new RegExp(`\\b${kw.replace(/ /g, '\\s+')}\\b`);
    if (re.test(upper)) {
      return {
        ok: false,
        reason: `Statement contains "${kw}", which is not permitted in read-only mode.`,
      };
    }
  }

  return { ok: true };
}
