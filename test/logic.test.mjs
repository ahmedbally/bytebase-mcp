/**
 * Pure-logic tests — no network, no token.
 * Run: npm test   (after npm run build)
 */
import { assertReadOnly } from '../dist/sql.js';
import { flattenValue, flattenResult } from '../dist/values.js';

let pass = 0;
const failures = [];
const t = (name, cond) => (cond ? pass++ : failures.push(name));

// --- read-only guard: must ALLOW -------------------------------------------
const allowed = [
  'SELECT * FROM orders',
  'select 1',
  'WITH c AS (SELECT 1) SELECT * FROM c',
  'SHOW TABLES',
  'EXPLAIN SELECT 1',
  'DESCRIBE users',
  "SELECT * FROM t WHERE status = 'DELETE'", // keyword inside a literal
  'SELECT created_at, updated_at FROM t', // keyword as identifier prefix
  'SELECT * FROM t LIMIT 10 OFFSET 5', // OFFSET contains SET
  'SELECT * FROM calls', // CALLS contains CALL
  'SELECT * FROM t -- trailing comment',
  'SELECT 1;', // single trailing semicolon
];
for (const s of allowed) t(`allow: ${s}`, assertReadOnly(s).ok === true);

// --- read-only guard: must BLOCK -------------------------------------------
const blocked = [
  'DELETE FROM orders',
  'UPDATE t SET x = 1',
  'DROP TABLE t',
  'INSERT INTO t VALUES (1)',
  'SELECT 1; DROP TABLE t',
  'TRUNCATE t',
  'SELECT * FROM t FOR UPDATE', // takes locks
  'ALTER TABLE t ADD c INT',
  'SET @@x = 1',
  '-- harmless\nDELETE FROM t', // write hidden behind a comment
  '/* x */ DELETE FROM t',
  'WITH c AS (SELECT 1) DELETE FROM t', // MySQL 8 CTE + DML
  '',
];
for (const s of blocked) t(`block: ${JSON.stringify(s)}`, assertReadOnly(s).ok === false);

// --- protobuf value flattening ---------------------------------------------
t('int64 -> number', flattenValue({ int64Value: '42' }) === 42);
t('int64 beyond MAX_SAFE stays string', flattenValue({ int64Value: '9223372036854775807' }) === '9223372036854775807');
t('nullValue -> null', flattenValue({ nullValue: null }) === null);
t('stringValue', flattenValue({ stringValue: 'hi' }) === 'hi');
t('boolValue false preserved', flattenValue({ boolValue: false }) === false);
t('doubleValue', flattenValue({ doubleValue: 1.5 }) === 1.5);
t('undefined -> null', flattenValue(undefined) === null);
t('bytes marked', JSON.stringify(flattenValue({ bytesValue: 'YWI=' })) === JSON.stringify({ $bytesBase64: 'YWI=' }));

// --- result shaping ---------------------------------------------------------
const r = flattenResult(
  {
    columnNames: ['ok', 'name'],
    columnTypeNames: ['BIGINT', 'VARCHAR'],
    rows: [{ values: [{ int64Value: '1' }, { stringValue: 'a' }] }],
    masked: [{}, {}],
  },
  10,
);
t('row shape', JSON.stringify(r.rows) === JSON.stringify([{ ok: 1, name: 'a' }]));
t('not truncated below limit', r.truncated === false);
t('no masked columns when all empty', r.maskedColumns.length === 0);

const masked = flattenResult(
  { columnNames: ['a', 'secret'], rows: [], masked: [{}, { maskingLevel: 'FULL' }] },
  10,
);
t('masked column detected', JSON.stringify(masked.maskedColumns) === JSON.stringify(['secret']));

const full = flattenResult(
  { columnNames: ['a'], rows: [{ values: [{ int64Value: '1' }] }, { values: [{ int64Value: '2' }] }] },
  2,
);
t('truncation flagged at limit', full.truncated === true);

// --- report -----------------------------------------------------------------
console.log(`passed=${pass} failed=${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
