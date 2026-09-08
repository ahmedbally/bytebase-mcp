/**
 * Bytebase returns rows as protobuf `RowValue` oneofs serialised to JSON, e.g.
 *   {"values":[{"int64Value":"1"},{"stringValue":"foo"},{"nullValue":null}]}
 * Flattening these into plain JS is the single most important thing this server
 * does — an LLM handed the raw wrapper objects burns context and misreads types.
 */

export interface QueryResultRaw {
  columnNames?: string[];
  columnTypeNames?: string[];
  rows?: { values?: unknown[] }[];
  rowsCount?: string | number;
  latency?: string;
  statement?: string;
  error?: string;
  masked?: unknown[];
  allowExport?: boolean;
}

/** int64/uint64 arrive as strings to survive JSON. Narrow to number when lossless. */
function narrowInteger(raw: unknown): number | string {
  if (typeof raw === 'number') return raw;
  const s = String(raw);
  if (!/^-?\d+$/.test(s)) return s;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : s;
}

export function flattenValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;

  const o = v as Record<string, unknown>;

  if ('nullValue' in o) return null;
  if ('stringValue' in o) return o.stringValue;
  if ('boolValue' in o) return o.boolValue;
  if ('int32Value' in o) return narrowInteger(o.int32Value);
  if ('uint32Value' in o) return narrowInteger(o.uint32Value);
  if ('int64Value' in o) return narrowInteger(o.int64Value);
  if ('uint64Value' in o) return narrowInteger(o.uint64Value);
  if ('doubleValue' in o) return o.doubleValue;
  if ('floatValue' in o) return o.floatValue;
  // BYTES/BLOB — base64. Keep a marker so the model does not treat it as text.
  if ('bytesValue' in o) return { $bytesBase64: o.bytesValue };
  if ('timestampValue' in o) {
    const t = o.timestampValue as Record<string, unknown> | string;
    return typeof t === 'string' ? t : (t?.googleTimestamp ?? t);
  }
  if ('timestampTzValue' in o) {
    const t = o.timestampTzValue as Record<string, unknown> | string;
    if (typeof t === 'string') return t;
    const ts = t?.googleTimestamp ?? null;
    const zone = t?.zone ?? null;
    return zone ? `${ts} ${zone}` : ts;
  }
  if ('valueValue' in o) return o.valueValue;

  return v;
}

export interface FlatResult {
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  latency?: string;
  executedStatement?: string;
  maskedColumns: string[];
  error?: string;
}

/**
 * Column masking is reported positionally in `masked`. A masked column is NOT an
 * error — it means the policy redacted the value — but the model must be told,
 * otherwise it reports masked output as if it were real data.
 */
function maskedColumnNames(result: QueryResultRaw, columns: string[]): string[] {
  const masked = result.masked ?? [];
  const out: string[] = [];
  masked.forEach((m, i) => {
    if (m && typeof m === 'object' && Object.keys(m as object).length > 0) {
      out.push(columns[i] ?? `col_${i}`);
    }
  });
  return out;
}

export function flattenResult(result: QueryResultRaw, requestedLimit: number): FlatResult {
  const columns = result.columnNames ?? [];
  const rows = (result.rows ?? []).map((r) => {
    const obj: Record<string, unknown> = {};
    const values = r.values ?? [];
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i] ?? `col_${i}`] = flattenValue(values[i]);
    }
    return obj;
  });

  return {
    columns,
    columnTypes: result.columnTypeNames ?? [],
    rows,
    rowCount: rows.length,
    truncated: rows.length >= requestedLimit,
    latency: result.latency,
    executedStatement: result.statement,
    maskedColumns: maskedColumnNames(result, columns),
    ...(result.error ? { error: result.error } : {}),
  };
}
