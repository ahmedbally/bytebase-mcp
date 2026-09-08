/**
 * End-to-end test over the real MCP stdio protocol.
 * Spawns dist/index.js, performs the MCP handshake, then calls each tool.
 * Requires a valid token (run `npm run auth` first).
 *
 * Run: node test/mcp-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn('node', [resolve(root, 'dist/index.js')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let buf = '';
const pending = new Map();
let nextId = 1;

server.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res } = pending.get(msg.id);
      pending.delete(msg.id);
      res(msg);
    }
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out`)); } }, 90_000);
  });
}

function notify(method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const text = (r) => r.result?.content?.[0]?.text ?? '';
const isErr = (r) => r.result?.isError === true;

let pass = 0;
const fails = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

try {
  // --- handshake ---
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  });
  check('initialize', init.result?.serverInfo?.name === 'bytebase-mcp', JSON.stringify(init.result?.serverInfo));
  notify('notifications/initialized');

  // --- tool discovery ---
  const list = await rpc('tools/list');
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  console.log(`\n  tools: ${names.join(', ')}\n`);
  check('tools/list returns 8 tools', names.length === 8, `got ${names.length}`);

  // --- whoami ---
  const who = await rpc('tools/call', { name: 'bytebase_whoami', arguments: {} });
  const whoData = JSON.parse(text(who));
  check('whoami identity', whoData.identity === 'ahmed.bally@salla.sa', whoData.identity);
  check('whoami read-only', whoData.readOnlyMode === true);
  check('whoami sees 7 projects', whoData.visibleProjects?.length === 7, `${whoData.visibleProjects?.length}`);
  console.log(`       token valid for: ${whoData.tokenValidFor}`);

  // --- databases ---
  const dbs = await rpc('tools/call', { name: 'bytebase_list_databases', arguments: { search: 'salla' } });
  const dbData = JSON.parse(text(dbs));
  check('list_databases finds salla', dbData.databases?.some((d) => d.ref.endsWith('/salla')), JSON.stringify(dbData.databases?.slice(0,3)));

  // --- table search (964-table db) ---
  const tbl = await rpc('tools/call', { name: 'bytebase_search_tables', arguments: { database: 'prod/aurora-prod/salla', pattern: 'coupon', limit: 5 } });
  const tblData = JSON.parse(text(tbl));
  check('search_tables total is ~964', tblData.tablesInDatabase > 900, `${tblData.tablesInDatabase}`);
  check('search_tables matches coupon', tblData.tables?.length > 0, `${tblData.matched} matched`);
  console.log(`       e.g. ${tblData.tables?.slice(0,3).map(t=>`${t.name}(${t.rowCount} rows)`).join(', ')}`);

  // --- describe ---
  const desc = await rpc('tools/call', { name: 'bytebase_describe_table', arguments: { database: 'prod/aurora-prod/salla', table: 'salla_coupons' } });
  const descData = JSON.parse(text(desc));
  check('describe_table has columns', descData.columns?.length > 0, `${descData.columns?.length} cols`);
  check('describe_table has indexes', Array.isArray(descData.indexes));

  // --- query (read-only, real) ---
  const q = await rpc('tools/call', { name: 'bytebase_query', arguments: { database: 'prod/aurora-prod/salla', statement: 'SELECT 1 AS ok, NOW() AS ts', limit: 5 } });
  const qData = JSON.parse(text(q));
  check('query returns flattened rows', qData.rows?.[0]?.ok === 1, JSON.stringify(qData.rows?.[0]));
  check('query int64 is a number not {int64Value}', typeof qData.rows?.[0]?.ok === 'number');
  console.log(`       row: ${JSON.stringify(qData.rows?.[0])}  latency=${qData.latency}`);

  // --- read-only guard blocks a write ---
  const bad = await rpc('tools/call', { name: 'bytebase_query', arguments: { database: 'prod/aurora-prod/salla', statement: 'DELETE FROM salla_coupons WHERE id = 1' } });
  check('guard blocks DELETE', isErr(bad) && /read-only guard/i.test(text(bad)), text(bad).slice(0, 90));

  // --- ambiguity is surfaced, not guessed ---
  const amb = await rpc('tools/call', { name: 'bytebase_query', arguments: { database: 'backup', statement: 'SELECT 1' } });
  check('ambiguous db name errors clearly', isErr(amb) && /ambiguous/i.test(text(amb)), text(amb).slice(0, 90));

  // --- query history ---
  const hist = await rpc('tools/call', { name: 'bytebase_query_history', arguments: { limit: 3 } });
  const histData = JSON.parse(text(hist));
  check('query_history returns entries', Array.isArray(histData.history));

  // --- issues ---
  const iss = await rpc('tools/call', { name: 'bytebase_list_issues', arguments: { project: 'Salla-prod', limit: 3 } });
  const issData = JSON.parse(text(iss));
  check('list_issues returns issues', Array.isArray(issData.issues), JSON.stringify(issData).slice(0,80));
  if (issData.issues?.[0]) console.log(`       latest: "${issData.issues[0].title}" [${issData.issues[0].status}]`);

} catch (err) {
  console.log(`\nEXCEPTION: ${err.message}`);
  fails.push(err.message);
} finally {
  server.kill();
}

console.log(`\npassed=${pass} failed=${fails.length}`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
