/**
 * Schema catalog.
 *
 * GetDatabaseMetadata returns the *entire* database in one response — `salla` on
 * aurora-prod has 964 tables, which is far too large to hand to a model. So the
 * metadata is fetched once, cached, and then only ever exposed through search
 * (names + row counts) and describe (one table at a time).
 */

import { BytebaseClient } from './client.js';

export interface ColumnMeta {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string;
  comment?: string;
  position?: number;
}

export interface IndexMeta {
  name: string;
  expressions?: string[];
  primary?: boolean;
  unique?: boolean;
  type?: string;
}

export interface ForeignKeyMeta {
  name: string;
  columns?: string[];
  referencedSchema?: string;
  referencedTable?: string;
  referencedColumns?: string[];
}

export interface TableMeta {
  name: string;
  schema: string;
  rowCount?: number;
  engine?: string;
  collation?: string;
  comment?: string;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  foreignKeys: ForeignKeyMeta[];
}

export interface DatabaseMeta {
  database: string;
  characterSet?: string;
  collation?: string;
  tables: TableMeta[];
  views: { name: string; schema: string }[];
}

const TTL_MS = 5 * 60 * 1000;

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export class SchemaCache {
  private cache = new Map<string, { at: number; meta: DatabaseMeta }>();

  constructor(private readonly client: BytebaseClient) {}

  async get(databaseResourceName: string, force = false): Promise<DatabaseMeta> {
    const hit = this.cache.get(databaseResourceName);
    if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.meta;

    const raw = await this.client.rpc<any>('DatabaseService/GetDatabaseMetadata', {
      name: `${databaseResourceName}/metadata`,
    });

    const tables: TableMeta[] = [];
    const views: { name: string; schema: string }[] = [];

    for (const schema of raw.schemas ?? []) {
      const schemaName: string = schema.name ?? '';
      for (const t of schema.tables ?? []) {
        tables.push({
          name: t.name,
          schema: schemaName,
          rowCount: toNumber(t.rowCount),
          engine: t.engine,
          collation: t.collation,
          comment: t.userComment || t.comment || undefined,
          columns: (t.columns ?? []).map((c: any, i: number) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable ?? false,
            default: c.default ?? c.defaultExpression ?? undefined,
            comment: c.userComment || c.comment || undefined,
            position: i + 1,
          })),
          indexes: (t.indexes ?? []).map((idx: any) => ({
            name: idx.name,
            expressions: idx.expressions,
            primary: idx.primary ?? false,
            unique: idx.unique ?? false,
            type: idx.type,
          })),
          foreignKeys: (t.foreignKeys ?? []).map((fk: any) => ({
            name: fk.name,
            columns: fk.columns,
            referencedSchema: fk.referencedSchema,
            referencedTable: fk.referencedTable,
            referencedColumns: fk.referencedColumns,
          })),
        });
      }
      for (const v of schema.views ?? []) {
        views.push({ name: v.name, schema: schemaName });
      }
    }

    const meta: DatabaseMeta = {
      database: databaseResourceName,
      characterSet: raw.characterSet,
      collation: raw.collation,
      tables,
      views,
    };
    this.cache.set(databaseResourceName, { at: Date.now(), meta });
    return meta;
  }

  /** Rank matches so an exact/prefix hit never gets buried under substring noise. */
  async searchTables(
    databaseResourceName: string,
    pattern: string | undefined,
    limit: number,
  ): Promise<{ total: number; matched: number; tables: TableMeta[] }> {
    const meta = await this.get(databaseResourceName);
    if (!pattern) {
      const sorted = [...meta.tables].sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
      return { total: meta.tables.length, matched: meta.tables.length, tables: sorted.slice(0, limit) };
    }

    const p = pattern.toLowerCase();
    const scored = meta.tables
      .map((t) => {
        const n = t.name.toLowerCase();
        let score = -1;
        if (n === p) score = 0;
        else if (n.startsWith(p)) score = 1;
        else if (n.includes(p)) score = 2;
        else if (t.columns.some((c) => c.name.toLowerCase().includes(p))) score = 3;
        return { t, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || (b.t.rowCount ?? 0) - (a.t.rowCount ?? 0));

    return {
      total: meta.tables.length,
      matched: scored.length,
      tables: scored.slice(0, limit).map((x) => x.t),
    };
  }

  async describeTable(databaseResourceName: string, table: string): Promise<TableMeta> {
    const meta = await this.get(databaseResourceName);
    const t = table.toLowerCase();
    const exact = meta.tables.find((x) => x.name.toLowerCase() === t);
    if (exact) return exact;

    const near = meta.tables
      .filter((x) => x.name.toLowerCase().includes(t))
      .slice(0, 10)
      .map((x) => x.name);
    throw new Error(
      `Table "${table}" not found in ${databaseResourceName}.` +
        (near.length ? ` Closest: ${near.join(', ')}` : ' Use bytebase_search_tables to find it.'),
    );
  }
}
