#!/usr/bin/env node
/**
 * bytebase-mcp — MCP server over the Bytebase Connect-RPC API.
 *
 * stdout is the MCP transport. Never console.log here; diagnostics go to stderr.
 */

import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { BytebaseClient, BytebaseError } from './client.js';
import { Catalog } from './catalog.js';
import { loadDotEnv } from './env.js';
import { SchemaCache } from './schema.js';
import { reauthenticate } from './session.js';
import { assertReadOnly } from './sql.js';
import { makeTokenSource } from './token.js';
import { hasGrant } from './oauthtoken.js';
import { flattenResult, type QueryResultRaw } from './values.js';

loadDotEnv();

const BASE_URL = process.env.BYTEBASE_URL ?? '';
const ALLOW_WRITE = /^(1|true|yes)$/i.test(process.env.BYTEBASE_ALLOW_WRITE ?? '');
const DEFAULT_LIMIT = Number(process.env.BYTEBASE_DEFAULT_LIMIT ?? 200);
const MAX_LIMIT = Number(process.env.BYTEBASE_MAX_LIMIT ?? 5000);

const tokenSource = makeTokenSource();

if (!BASE_URL) {
  process.stderr.write(
    'bytebase-mcp: BYTEBASE_URL is not set.\n' +
      '  BYTEBASE_URL=https://bytebase.example.com\n',
  );
  process.exit(1);
}
if (!hasGrant()) {
  // Not fatal: surfaced clearly on first use. No sign-in is attempted from
  // inside the MCP server — the login is an explicit, user-run command.
  process.stderr.write(
    `bytebase-mcp: no OAuth grant yet (${tokenSource.describe()}). Run the login command first.\n`,
  );
}

// On 401 the client calls reauthenticate() — a locked OAuth refresh, then a
// single retry. The session extends while you work; nothing runs in the
// background.
const client = new BytebaseClient({
  baseUrl: BASE_URL,
  token: () => tokenSource.get(),
  reauthorize: reauthenticate,
});
const catalog = new Catalog(client);
const schemas = new SchemaCache(client);

const server = new McpServer({ name: 'bytebase-mcp', version: '0.2.2' });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

const fail = (err: unknown): ToolResult => {
  const msg = err instanceof BytebaseError || err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
};

/** Every handler funnels through here so a thrown error becomes a tool error, not a crash. */
function tool<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

// ---------------------------------------------------------------- identity

server.registerTool(
  'bytebase_whoami',
  {
    title: 'Bytebase: identity & connectivity check',
    description:
      'Verify the configured Bytebase token: returns the server version, the identity it maps to, and how long the token remains valid. Run this first when anything returns 401/403.',
    inputSchema: {},
  },
  tool(async () => {
    const [info, user] = await Promise.all([
      client.actuatorInfo().catch(() => ({}) as { version?: string }),
      client.currentUser(),
    ]);
    const projects = await catalog.listProjects();
    const mins = await tokenSource.minutesLeft();
    return ok({
      bytebaseUrl: BASE_URL,
      serverVersion: info.version ?? 'unknown',
      identity: user.email ?? user.name ?? 'unknown',
      readOnlyMode: !ALLOW_WRITE,
      auth: tokenSource.describe(),
      tokenValidFor: mins === undefined ? 'unknown' : `${mins} min`,
      visibleProjects: projects.map((p) => `${p.title} (${p.id})`),
    });
  }),
);

// ---------------------------------------------------------------- catalog

server.registerTool(
  'bytebase_list_projects',
  {
    title: 'Bytebase: list projects',
    description: 'List every Bytebase project the configured identity can see.',
    inputSchema: {
      refresh: z.boolean().optional().describe('Bypass the 5-minute cache.'),
    },
  },
  tool(async ({ refresh }: { refresh?: boolean }) => {
    const projects = await catalog.listProjects(refresh ?? false);
    return ok({ count: projects.length, projects });
  }),
);

server.registerTool(
  'bytebase_list_databases',
  {
    title: 'Bytebase: list databases',
    description:
      'List databases with their instance, engine and environment. Use this to discover the reference string to pass to bytebase_query (format: <environment>/<instance>/<database>).',
    inputSchema: {
      project: z.string().optional().describe('Project id or title, e.g. "Salla-prod".'),
      environment: z.string().optional().describe('Filter by environment, e.g. "prod".'),
      search: z.string().optional().describe('Case-insensitive substring on the database name.'),
      refresh: z.boolean().optional(),
    },
  },
  tool(
    async ({
      project,
      environment,
      search,
      refresh,
    }: {
      project?: string;
      environment?: string;
      search?: string;
      refresh?: boolean;
    }) => {
      let dbs = await catalog.listDatabases(refresh ?? false);
      if (project) {
        const p = await catalog.resolveProject(project);
        dbs = dbs.filter((d) => d.project === p.name);
      }
      if (environment) {
        dbs = dbs.filter((d) => d.environment.toLowerCase() === environment.toLowerCase());
      }
      if (search) {
        dbs = dbs.filter((d) => d.databaseName.toLowerCase().includes(search.toLowerCase()));
      }
      return ok({
        count: dbs.length,
        databases: dbs.map((d) => ({
          ref: `${d.environment}/${d.instanceTitle}/${d.databaseName}`,
          resourceName: d.name,
          project: d.projectTitle,
          engine: `${d.engine}${d.engineVersion ? ' ' + d.engineVersion : ''}`,
          hasReadOnlyReplica: Boolean(d.readOnlyDataSourceId),
        })),
      });
    },
  ),
);

// ---------------------------------------------------------------- schema

server.registerTool(
  'bytebase_search_tables',
  {
    title: 'Bytebase: search tables',
    description:
      'Find tables in a database by name or column name. Prefer this over dumping a schema — a production database here can hold ~1000 tables. Returns names and row counts only; use bytebase_describe_table for columns.',
    inputSchema: {
      database: z.string().describe('Database reference, e.g. "prod/aurora-prod/salla" or "salla".'),
      pattern: z.string().optional().describe('Substring to match on table name, then column names.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max tables to return (default 50).'),
    },
  },
  tool(
    async ({ database, pattern, limit }: { database: string; pattern?: string; limit?: number }) => {
      const db = await catalog.resolveDatabase(database);
      const res = await schemas.searchTables(db.name, pattern, limit ?? 50);
      return ok({
        database: `${db.environment}/${db.instanceTitle}/${db.databaseName}`,
        tablesInDatabase: res.total,
        matched: res.matched,
        returned: res.tables.length,
        tables: res.tables.map((t) => ({
          name: t.name,
          rowCount: t.rowCount,
          columns: t.columns.length,
          comment: t.comment,
        })),
      });
    },
  ),
);

server.registerTool(
  'bytebase_describe_table',
  {
    title: 'Bytebase: describe table',
    description:
      'Full definition of one table: columns with types and nullability, indexes, and foreign keys.',
    inputSchema: {
      database: z.string().describe('Database reference, e.g. "prod/aurora-prod/salla".'),
      table: z.string().describe('Exact table name.'),
    },
  },
  tool(async ({ database, table }: { database: string; table: string }) => {
    const db = await catalog.resolveDatabase(database);
    const t = await schemas.describeTable(db.name, table);
    return ok({
      database: `${db.environment}/${db.instanceTitle}/${db.databaseName}`,
      table: t.name,
      engine: t.engine,
      rowCount: t.rowCount,
      comment: t.comment,
      columns: t.columns,
      indexes: t.indexes,
      foreignKeys: t.foreignKeys,
    });
  }),
);

// ---------------------------------------------------------------- query

server.registerTool(
  'bytebase_query',
  {
    title: 'Bytebase: run SQL query',
    description:
      `Execute SQL through the Bytebase SQL Editor and return rows as JSON. ${
        ALLOW_WRITE
          ? 'WRITES ARE ENABLED on this server instance.'
          : 'Read-only: only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN are accepted.'
      } Queries run under the configured Bytebase identity and are subject to its access policies, data masking and audit log.`,
    inputSchema: {
      database: z.string().describe('Database reference, e.g. "prod/aurora-prod/salla".'),
      statement: z.string().describe('A single SQL statement.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Max rows (default ${DEFAULT_LIMIT}).`),
      dataSource: z
        .enum(['readonly', 'admin'])
        .optional()
        .describe('Which data source to use. Defaults to the read-only replica when the instance has one.'),
    },
  },
  tool(
    async ({
      database,
      statement,
      limit,
      dataSource,
    }: {
      database: string;
      statement: string;
      limit?: number;
      dataSource?: 'readonly' | 'admin';
    }) => {
      if (!ALLOW_WRITE) {
        const guard = assertReadOnly(statement);
        if (!guard.ok) return fail(new Error(`Blocked by read-only guard. ${guard.reason}`));
      }

      const db = await catalog.resolveDatabase(database);
      const rowLimit = limit ?? DEFAULT_LIMIT;

      const body: Record<string, unknown> = {
        name: db.name,
        statement,
        limit: rowLimit,
      };
      // Route reads to the replica when one exists, unless explicitly overridden.
      if (dataSource !== 'admin' && db.readOnlyDataSourceId) {
        body.dataSourceId = db.readOnlyDataSourceId;
      }

      const res = await client.rpc<{ results?: QueryResultRaw[] }>('SQLService/Query', body);
      const results = res.results ?? [];
      if (results.length === 0) return ok({ rows: [], rowCount: 0, note: 'No result set returned.' });

      const flat = results.map((r) => flattenResult(r, rowLimit));
      const first = flat[0]!;

      if (first.error) {
        return fail(new Error(`SQL error: ${first.error}`));
      }

      return ok({
        database: `${db.environment}/${db.instanceTitle}/${db.databaseName}`,
        executedStatement: first.executedStatement,
        latency: first.latency,
        rowCount: first.rowCount,
        truncated: first.truncated
          ? `Result hit the ${rowLimit}-row limit; there may be more rows.`
          : false,
        ...(first.maskedColumns.length
          ? { maskedColumns: first.maskedColumns, maskingNote: 'These columns are redacted by Bytebase masking policy — the values shown are not the real data.' }
          : {}),
        columns: first.columns,
        columnTypes: first.columnTypes,
        rows: first.rows,
        ...(flat.length > 1 ? { additionalResultSets: flat.slice(1) } : {}),
      });
    },
  ),
);

server.registerTool(
  'bytebase_query_history',
  {
    title: 'Bytebase: recent query history',
    description:
      'Recent SQL Editor queries recorded by Bytebase. Useful for recovering a query you ran earlier or seeing how a table is normally joined.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      database: z.string().optional().describe('Filter to one database reference.'),
    },
  },
  tool(async ({ limit, database }: { limit?: number; database?: string }) => {
    const pageSize = limit ?? 20;
    const res = await client.rpc<{ queryHistories?: any[] }>('SQLService/SearchQueryHistories', {
      pageSize,
    });
    let items = res.queryHistories ?? [];
    if (database) {
      const db = await catalog.resolveDatabase(database);
      items = items.filter((h) => h.database === db.name);
    }
    return ok({
      count: items.length,
      history: items.map((h) => ({
        database: h.database,
        creator: h.creator,
        at: h.createTime,
        duration: h.duration,
        type: h.type,
        error: h.error,
        statement: h.statement,
      })),
    });
  }),
);

// ---------------------------------------------------------------- changes

server.registerTool(
  'bytebase_list_issues',
  {
    title: 'Bytebase: list change issues',
    description:
      'List schema/data change issues in a project, with review and approval status.',
    inputSchema: {
      project: z.string().describe('Project id or title, e.g. "Salla-prod".'),
      status: z.enum(['OPEN', 'DONE', 'CANCELED']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
    },
  },
  tool(
    async ({ project, status, limit }: { project: string; status?: string; limit?: number }) => {
      const p = await catalog.resolveProject(project);
      const body: Record<string, unknown> = { parent: p.name, pageSize: limit ?? 20 };
      if (status) body.filter = `status = "${status}"`;
      const res = await client.rpc<{ issues?: any[] }>('IssueService/SearchIssues', body);
      const issues = res.issues ?? [];
      return ok({
        project: p.title,
        count: issues.length,
        issues: issues.map((i) => ({
          id: String(i.name).split('/issues/')[1],
          title: i.title,
          type: i.type,
          status: i.status,
          approvalStatus: i.approvalStatus,
          riskLevel: i.riskLevel,
          creator: i.creator,
          createdAt: i.createTime,
        })),
      });
    },
  ),
);

// ---------------------------------------------------------------- plans

server.registerTool(
  'bytebase_create_plan',
  {
    title: 'Bytebase: create a SQL change plan',
    description:
      'Draft a titled SQL change plan against one database: creates a Sheet (the SQL text) and a Plan ' +
      '(the proposal) in Bytebase. This does NOT open an Issue and does NOT run the SQL — a plan only ' +
      'becomes executable after a human opens it in the Bytebase UI, submits it for review, and it is ' +
      'approved, at which point Bytebase creates the rollout automatically. Available even when ' +
      'BYTEBASE_ALLOW_WRITE is unset, since nothing runs until a human approves it — this is the safe ' +
      'route for write SQL that bytebase_query blocks in read-only mode.',
    inputSchema: {
      database: z.string().describe('Database reference, e.g. "prod/aurora-prod/salla".'),
      statement: z.string().min(1).describe('The SQL to run.'),
      title: z.string().min(1).max(200).describe('Plan title, shown in the Bytebase Plans list.'),
      description: z.string().max(10000).optional().describe('Longer explanation of the change.'),
      priorBackup: z
        .boolean()
        .optional()
        .describe('Ask Bytebase to back up affected rows automatically before the change runs (default false).'),
    },
  },
  tool(
    async ({
      database,
      statement,
      title,
      description,
      priorBackup,
    }: {
      database: string;
      statement: string;
      title: string;
      description?: string;
      priorBackup?: boolean;
    }) => {
      const db = await catalog.resolveDatabase(database);
      if (!db.project) {
        return fail(
          new Error(
            `"${database}" resolved to ${db.name}, but its owning project is unknown. Run bytebase_list_databases first so it is in the catalog.`,
          ),
        );
      }

      const sheet = await client.rpc<{ name: string }>('SheetService/CreateSheet', {
        parent: db.project,
        sheet: { content: Buffer.from(statement, 'utf8').toString('base64') },
      });

      const plan = await client.rpc<{ name: string }>('PlanService/CreatePlan', {
        parent: db.project,
        plan: {
          title,
          description: description ?? '',
          specs: [
            {
              id: randomUUID(),
              changeDatabaseConfig: {
                targets: [db.name],
                sheet: sheet.name,
                enablePriorBackup: priorBackup ?? false,
              },
            },
          ],
        },
      });

      const [, projectId, , planId] = plan.name.split('/');
      return ok({
        plan: plan.name,
        title,
        database: `${db.environment}/${db.instanceTitle}/${db.databaseName}`,
        url: `${BASE_URL}/projects/${projectId}/plans/${planId}`,
        note: 'Draft only — no Issue was opened yet. Open the URL above in Bytebase and submit it for review to start the approval/rollout process.',
      });
    },
  ),
);

const PLAN_NAME_RE = /^projects\/[^/]+\/plans\/[^/]+$/;

function requirePlanName(plan: string): string {
  if (!PLAN_NAME_RE.test(plan)) {
    throw new Error(
      `"${plan}" is not a plan resource name. Expected format: projects/{project}/plans/{plan} — this is exactly what bytebase_create_plan returns as "plan".`,
    );
  }
  return plan.split('/plans/')[0]!;
}

server.registerTool(
  'bytebase_get_plan',
  {
    title: 'Bytebase: get a plan',
    description:
      "Fetch a plan's title, description, target database, status, and full SQL statement " +
      '(decoded from its Sheet). Use this before bytebase_update_plan to see the current content.',
    inputSchema: {
      plan: z.string().describe('Plan resource name, e.g. "projects/my-project/plans/123".'),
    },
  },
  tool(async ({ plan }: { plan: string }) => {
    requirePlanName(plan);

    const current = await client.rpc<{
      name: string;
      title?: string;
      description?: string;
      state?: string;
      issue?: string;
      hasRollout?: boolean;
      specs?: { changeDatabaseConfig?: { targets?: string[]; sheet?: string } }[];
    }>('PlanService/GetPlan', { name: plan });

    const specs = current.specs ?? [];
    let statement: string | undefined;
    let targets: string[] | undefined;
    if (specs.length === 1 && specs[0]?.changeDatabaseConfig) {
      const cfg = specs[0].changeDatabaseConfig;
      targets = cfg.targets;
      if (cfg.sheet) {
        const sheet = await client.rpc<{ content?: string }>('SheetService/GetSheet', {
          name: cfg.sheet,
          raw: true,
        });
        statement = sheet.content ? Buffer.from(sheet.content, 'base64').toString('utf8') : '';
      }
    }

    return ok({
      plan: current.name,
      title: current.title,
      description: current.description,
      state: current.state,
      issue: current.issue || undefined,
      hasRollout: current.hasRollout ?? false,
      targets,
      statement,
      note:
        specs.length !== 1
          ? `This plan has ${specs.length} specs — statement omitted (only single-spec plans are decoded).`
          : undefined,
    });
  }),
);

server.registerTool(
  'bytebase_update_plan',
  {
    title: 'Bytebase: update a plan',
    description:
      "Edit a plan's title, description, and/or SQL statement — works both before and after it has been " +
      'submitted for review (title edits go to the review Issue instead of the Plan once one exists, ' +
      "matching Bytebase's own UI). Changing the statement creates a new Sheet (sheets are immutable) and " +
      'repoints the plan at it — refused once the plan has a rollout, since tasks may already reference ' +
      'the old sheet. Only supports single-spec plans — i.e. plans created by bytebase_create_plan.',
    inputSchema: {
      plan: z.string().describe('Plan resource name, e.g. "projects/my-project/plans/123".'),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(10000).optional(),
      statement: z.string().min(1).optional().describe("New SQL to replace the plan's current statement."),
    },
  },
  tool(
    async ({
      plan,
      title,
      description,
      statement,
    }: {
      plan: string;
      title?: string;
      description?: string;
      statement?: string;
    }) => {
      if (title === undefined && description === undefined && statement === undefined) {
        return fail(new Error('Nothing to update — pass at least one of title, description, statement.'));
      }
      const project = requirePlanName(plan);

      const current = await client.rpc<{
        name: string;
        state?: string;
        issue?: string;
        hasRollout?: boolean;
        specs?: { changeDatabaseConfig?: Record<string, unknown> }[];
      }>('PlanService/GetPlan', { name: plan });

      if (current.state === 'DELETED') {
        return fail(new Error('This plan is closed. Reopen it in the Bytebase UI before editing it.'));
      }

      const results: Record<string, unknown> = {};

      // Once a review Issue exists, its title is what's canonical (shown in issue
      // lists) — Bytebase's own UI patches the Issue, not the Plan, in that case.
      if (title !== undefined) {
        if (current.issue) {
          const issue = await client.rpc<{ title?: string }>('IssueService/UpdateIssue', {
            issue: { name: current.issue, title },
            updateMask: 'title',
          });
          results.title = issue.title;
        } else {
          const updated = await client.rpc<{ title?: string }>('PlanService/UpdatePlan', {
            plan: { name: plan, title },
            updateMask: 'title',
          });
          results.title = updated.title;
        }
      }

      // Description always lives on the Plan, review state notwithstanding.
      if (description !== undefined) {
        const updated = await client.rpc<{ description?: string }>('PlanService/UpdatePlan', {
          plan: { name: plan, description },
          updateMask: 'description',
        });
        results.description = updated.description;
      }

      if (statement !== undefined) {
        if (current.hasRollout) {
          return fail(
            new Error('This plan already has a rollout — its SQL can no longer be changed here.'),
          );
        }
        const specs = current.specs ?? [];
        if (specs.length !== 1 || !specs[0]?.changeDatabaseConfig) {
          return fail(
            new Error(
              'bytebase_update_plan only supports single-spec change-database plans (i.e. plans created by bytebase_create_plan).',
            ),
          );
        }
        const sheet = await client.rpc<{ name: string }>('SheetService/CreateSheet', {
          parent: project,
          sheet: { content: Buffer.from(statement, 'utf8').toString('base64') },
        });
        await client.rpc('PlanService/UpdatePlan', {
          plan: {
            name: plan,
            specs: [
              {
                ...specs[0],
                changeDatabaseConfig: { ...specs[0].changeDatabaseConfig, sheet: sheet.name },
              },
            ],
          },
          // Wire-JSON FieldMask is a comma-joined string, not {paths:[...]}.
          updateMask: 'specs',
        });
        results.statement = 'updated';
      }

      return ok({ plan, ...results });
    },
  ),
);

server.registerTool(
  'bytebase_list_issue_labels',
  {
    title: 'Bytebase: list issue labels',
    description:
      'List the issue labels a project has configured. Call this before bytebase_submit_plan_for_review ' +
      'when the project defines any labels, so the caller can offer them as choices rather than guessing ' +
      'label names — "required: true" means Bytebase will reject the issue if none are attached.',
    inputSchema: {
      project: z.string().describe('Project id or title, e.g. "Salla-prod".'),
    },
  },
  tool(async ({ project }: { project: string }) => {
    const p = await catalog.resolveProject(project);
    const res = await client.rpc<{
      issueLabels?: { value?: string; group?: string }[];
      forceIssueLabels?: boolean;
    }>('ProjectService/GetProject', { name: p.name });
    const labels = (res.issueLabels ?? []).map((l) => ({ value: l.value, group: l.group || undefined }));
    return ok({
      project: p.title,
      required: res.forceIssueLabels ?? false,
      count: labels.length,
      labels,
    });
  }),
);

server.registerTool(
  'bytebase_submit_plan_for_review',
  {
    title: 'Bytebase: submit a plan for review',
    description:
      'Open a review Issue for a Plan created with bytebase_create_plan. This is the step that actually ' +
      'starts the approval workflow — once approved and its checks pass, Bytebase creates the rollout and ' +
      'runs the SQL. Do not call this unless the user has confirmed the plan is ready to go out for review. ' +
      'If the project defines issue labels (check with bytebase_list_issue_labels first), ask the user which ' +
      'ones to attach instead of guessing.',
    inputSchema: {
      plan: z.string().describe('Plan resource name, e.g. "projects/my-project/plans/123" (returned by bytebase_create_plan).'),
      labels: z.array(z.string()).optional().describe('Labels to attach to the issue, if the project uses them.'),
    },
  },
  tool(async ({ plan, labels }: { plan: string; labels?: string[] }) => {
    const project = requirePlanName(plan);

    const issue = await client.rpc<{ name: string; status?: string; title?: string }>(
      'IssueService/CreateIssue',
      {
        parent: project,
        issue: {
          plan,
          status: 'OPEN',
          type: 'DATABASE_CHANGE',
          labels: labels ?? [],
        },
      },
    );

    const [, projectId, , issueId] = issue.name.split('/');
    return ok({
      issue: issue.name,
      title: issue.title,
      status: issue.status,
      url: `${BASE_URL}/projects/${projectId}/issues/${issueId}`,
      note: 'Review/approval now proceeds in Bytebase. Bytebase creates the rollout automatically once all checks pass and the issue is approved.',
    });
  }),
);

server.registerTool(
  'bytebase_close_plan',
  {
    title: 'Bytebase: close a plan or its review issue',
    description:
      'Cancel a change before it runs. If the plan was never submitted for review, this deletes the draft ' +
      'plan. If it was submitted (an open review Issue exists), this cancels that issue instead — mirroring ' +
      'the "Close" action in the Bytebase UI. Refuses if the plan already has an active rollout: at that ' +
      'point tasks may be running or done, and canceling them needs the Bytebase UI\'s task-level actions.',
    inputSchema: {
      plan: z.string().describe('Plan resource name, e.g. "projects/my-project/plans/123".'),
    },
  },
  tool(async ({ plan }: { plan: string }) => {
    const project = requirePlanName(plan);

    const current = await client.rpc<{
      name: string;
      issue?: string;
      hasRollout?: boolean;
    }>('PlanService/GetPlan', { name: plan });

    if (current.hasRollout) {
      return fail(
        new Error(
          'This plan already has an active (or completed) rollout — closing it here is not supported. Use the Bytebase UI to cancel individual tasks instead.',
        ),
      );
    }

    if (!current.issue) {
      await client.rpc('PlanService/UpdatePlan', {
        plan: { name: plan, state: 'DELETED' },
        // google.protobuf.FieldMask's wire-JSON form is a comma-joined string of
        // paths, not {paths: [...]} — that's only the in-memory JS shape.
        updateMask: 'state',
      });
      return ok({ plan, closed: 'plan', note: 'Draft plan closed (state: DELETED). It never had a review issue.' });
    }

    const issue = await client.rpc<{ name: string; status?: string }>('IssueService/GetIssue', {
      name: current.issue,
    });
    if (issue.status !== 'OPEN') {
      return fail(new Error(`Issue ${current.issue} is already ${issue.status}, not OPEN — nothing to close.`));
    }

    await client.rpc('IssueService/BatchUpdateIssuesStatus', {
      parent: project,
      issues: [issue.name],
      status: 'CANCELED',
    });
    return ok({ plan, issue: issue.name, closed: 'issue', note: 'Review issue canceled.' });
  }),
);

// ---------------------------------------------------------------- boot

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `bytebase-mcp ready → ${BASE_URL} (${ALLOW_WRITE ? 'WRITES ENABLED' : 'read-only'}, auth: ${tokenSource.describe()})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`bytebase-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
