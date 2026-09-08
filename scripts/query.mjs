#!/usr/bin/env node
/**
 * Ad-hoc read-only query helper — the MCP tools without an MCP client.
 *
 *   node scripts/query.mjs <database-ref> "<sql>" [limit]
 *   node scripts/query.mjs --tables <database-ref> [pattern]
 *
 * Uses the same credentials, guard and value-flattening as the MCP server.
 */
import { loadDotEnv } from '../dist/env.js';
loadDotEnv();

import { BytebaseClient } from '../dist/client.js';
import { Catalog } from '../dist/catalog.js';
import { SchemaCache } from '../dist/schema.js';
import { assertReadOnly } from '../dist/sql.js';
import { makeTokenSource } from '../dist/token.js';
import { flattenResult } from '../dist/values.js';

const argv = process.argv.slice(2);
const baseUrl = (process.env.BYTEBASE_URL ?? '').replace(/\/+$/, '');
if (!baseUrl) { console.error('BYTEBASE_URL not set'); process.exit(1); }

const tokenSource = makeTokenSource();
const client = new BytebaseClient({ baseUrl, token: () => tokenSource.get() });
const catalog = new Catalog(client);

try {
  if (argv[0] === '--tables') {
    const db = await catalog.resolveDatabase(argv[1]);
    const res = await new SchemaCache(client).searchTables(db.name, argv[2], 40);
    console.log(`${res.matched} of ${res.total} tables match${argv[2] ? ` "${argv[2]}"` : ''}:`);
    for (const t of res.tables) {
      console.log(`  ${t.name.padEnd(44)} rows=${t.rowCount ?? '?'}  cols=${t.columns.length}`);
    }
    process.exit(0);
  }

  const [ref, sql, limitArg] = argv;
  if (!ref || !sql) { console.error('usage: query.mjs <database-ref> "<sql>" [limit]'); process.exit(1); }

  const guard = assertReadOnly(sql);
  if (!guard.ok) { console.error(`blocked by read-only guard: ${guard.reason}`); process.exit(1); }

  const db = await catalog.resolveDatabase(ref);
  const limit = Number(limitArg ?? 50);
  const body = { name: db.name, statement: sql, limit };
  if (db.readOnlyDataSourceId) body.dataSourceId = db.readOnlyDataSourceId;

  const res = await client.rpc('SQLService/Query', body);
  const flat = flattenResult((res.results ?? [])[0] ?? {}, limit);
  if (flat.error) { console.error(`SQL error: ${flat.error}`); process.exit(1); }

  console.log(JSON.stringify({
    database: `${db.environment}/${db.instanceTitle}/${db.databaseName}`,
    rowCount: flat.rowCount,
    ...(flat.maskedColumns.length ? { maskedColumns: flat.maskedColumns } : {}),
    rows: flat.rows,
  }, null, 2));
} catch (err) {
  console.error(String(err.message ?? err).split('\n')[0]);
  process.exit(1);
}
