/**
 * Project/database catalog with name resolution.
 *
 * Bytebase resource ids do not match what humans see: the instance shown as
 * "aurora-prod" in the UI is `instances/ins-stalla-prod-w8ra`. Every tool here
 * therefore accepts a friendly reference ("salla", "aurora-prod/salla",
 * "prod/aurora-prod/salla") and resolves it against a cached catalog.
 */

import { BytebaseClient } from './client.js';

export interface ProjectInfo {
  name: string; // projects/<id>
  id: string;
  title: string;
}

export interface DatabaseInfo {
  name: string; // instances/<inst>/databases/<db>
  databaseName: string;
  project: string;
  projectTitle: string;
  instanceName: string; // instances/<inst>
  instanceTitle: string; // e.g. "aurora-prod"
  engine: string;
  engineVersion?: string;
  environment: string; // e.g. "prod"
  /** Preferred data source for SELECTs, when the instance exposes a replica. */
  readOnlyDataSourceId?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class Catalog {
  private projects?: ProjectInfo[];
  private projectsAt = 0;
  private databases?: DatabaseInfo[];
  private databasesAt = 0;

  constructor(private readonly client: BytebaseClient) {}

  async listProjects(force = false): Promise<ProjectInfo[]> {
    if (!force && this.projects && Date.now() - this.projectsAt < CACHE_TTL_MS) {
      return this.projects;
    }
    // SearchProjects (not ListProjects): returns exactly the projects the caller
    // can see. ListProjects needs workspace-wide bb.projects.list, which normal
    // project members do not have.
    const res = await this.client.rpc<{ projects?: any[] }>('ProjectService/SearchProjects', {
      pageSize: 1000,
    });
    this.projects = (res.projects ?? []).map((p) => ({
      name: p.name,
      id: String(p.name).replace('projects/', ''),
      title: p.title ?? String(p.name).replace('projects/', ''),
    }));
    this.projectsAt = Date.now();
    return this.projects;
  }

  async listDatabases(force = false): Promise<DatabaseInfo[]> {
    if (!force && this.databases && Date.now() - this.databasesAt < CACHE_TTL_MS) {
      return this.databases;
    }
    const projects = await this.listProjects(force);
    const out: DatabaseInfo[] = [];

    for (const project of projects) {
      let res: { databases?: any[] };
      try {
        res = await this.client.rpc('DatabaseService/ListDatabases', {
          parent: project.name,
          pageSize: 1000,
        });
      } catch {
        // A project we can see but whose databases we cannot list is not fatal.
        continue;
      }
      for (const db of res.databases ?? []) {
        const inst = db.instanceResource ?? {};
        const dataSources: any[] = inst.dataSources ?? [];
        const ro = dataSources.find((d) => d.type === 'READ_ONLY');
        out.push({
          name: db.name,
          databaseName: String(db.name).split('/databases/')[1] ?? db.name,
          project: project.name,
          projectTitle: project.title,
          instanceName: inst.name ?? String(db.name).split('/databases/')[0],
          instanceTitle: inst.title ?? '',
          engine: inst.engine ?? 'UNKNOWN',
          engineVersion: inst.engineVersion,
          environment: String(db.effectiveEnvironment ?? inst.environment ?? '').replace(
            'environments/',
            '',
          ),
          readOnlyDataSourceId: ro?.id,
        });
      }
    }

    this.databases = out;
    this.databasesAt = Date.now();
    return out;
  }

  /**
   * Resolve a friendly database reference. Accepts, in order of specificity:
   *   instances/ins-x/databases/salla   (full resource name — used verbatim)
   *   prod/aurora-prod/salla            (environment/instance/database)
   *   aurora-prod/salla                 (instance/database)
   *   salla                             (database only — must be unambiguous)
   * Ambiguity is an error listing the candidates, never a silent pick.
   */
  async resolveDatabase(ref: string): Promise<DatabaseInfo> {
    const trimmed = ref.trim();
    const all = await this.listDatabases();

    if (trimmed.startsWith('instances/') && trimmed.includes('/databases/')) {
      const exact = all.find((d) => d.name === trimmed);
      if (exact) return exact;
      // Unknown to the catalog but well-formed — let Bytebase arbitrate.
      const [instanceName, databaseName] = trimmed.split('/databases/');
      return {
        name: trimmed,
        databaseName: databaseName ?? trimmed,
        project: '',
        projectTitle: '',
        instanceName: instanceName ?? '',
        instanceTitle: '',
        engine: 'UNKNOWN',
        environment: '',
      };
    }

    const parts = trimmed.split('/').filter(Boolean);
    const dbPart = parts[parts.length - 1]!;
    const instPart = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    const envPart = parts.length >= 3 ? parts[parts.length - 3] : undefined;

    const eq = (a: string, b?: string) => !!b && a.toLowerCase() === b.toLowerCase();

    let candidates = all.filter((d) => eq(d.databaseName, dbPart));
    if (instPart) {
      candidates = candidates.filter(
        (d) => eq(d.instanceTitle, instPart) || eq(d.instanceName.replace('instances/', ''), instPart),
      );
    }
    if (envPart) candidates = candidates.filter((d) => eq(d.environment, envPart));

    if (candidates.length === 1) return candidates[0]!;

    if (candidates.length === 0) {
      const near = all
        .filter((d) => d.databaseName.toLowerCase().includes(dbPart.toLowerCase()))
        .slice(0, 10)
        .map((d) => `${d.environment}/${d.instanceTitle}/${d.databaseName}`);
      throw new Error(
        `No database matches "${ref}".` +
          (near.length ? ` Did you mean: ${near.join(', ')}?` : ' Run bytebase_list_databases to see what is available.'),
      );
    }

    const listed = candidates
      .map((d) => `${d.environment}/${d.instanceTitle}/${d.databaseName}  (project: ${d.projectTitle})`)
      .join('\n  ');
    throw new Error(
      `"${ref}" is ambiguous — ${candidates.length} databases match:\n  ${listed}\n` +
        `Qualify it as <environment>/<instance>/<database>.`,
    );
  }

  async resolveProject(ref: string): Promise<ProjectInfo> {
    const projects = await this.listProjects();
    const t = ref.trim().toLowerCase();
    const hit =
      projects.find((p) => p.name.toLowerCase() === t) ??
      projects.find((p) => p.id.toLowerCase() === t) ??
      projects.find((p) => p.title.toLowerCase() === t);
    if (hit) return hit;
    throw new Error(
      `No project matches "${ref}". Available: ${projects.map((p) => p.title).join(', ')}`,
    );
  }
}
