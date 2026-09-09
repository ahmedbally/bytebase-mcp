# bytebase-mcp

MCP server for [Bytebase](https://bytebase.io) — SQL Editor, schema catalog, query history, and the full change-plan workflow over the Connect-RPC API. Authentication is the **standard MCP OAuth 2.1 flow** (PKCE public client, dynamic registration) — the same flow MCP clients like Claude Code and opencode run against remote MCP servers.

No browser automation. No static tokens. No background daemon. No bundled certificates — everything resolves from environment variables.

## Authentication model

Implements the MCP SDK's `OAuthClientProvider` + `auth()`:

- **RFC 9728 protected-resource discovery** → authorization-server metadata → **RFC 7591 dynamic client registration** → **PKCE (S256)** authorization-code flow
- **One token file per instance** (`~/.config/bytebase-mcp/<host>.json`, mode 600) is the only credential store
- **Refresh under an atomic `mkdir` lock** — the one filesystem operation that is atomic on both Windows and POSIX — and the file is **re-read after taking the lock**, so a process that loses the race picks up the winner's tokens. This matters: Bytebase's refresh token is **single-use with no reuse grace**, and MCP clients spawn one process per session, all sharing one grant
- **Single-flight within a process**: concurrent 401s share one refresh
- **Access tokens re-mint on demand**; the 1-hour expiry never surfaces
- **401 self-heal**: the client passes the stale token to the refresh path, so cross-process rotation is detected, never double-burned

## Setup

```bash
npm install
cp .env.example .env        # set BYTEBASE_URL
npm run build

npm run auth                # standard MCP OAuth 2.1 login (prints the approval URL)
npm run auth:status         # grant health, no secrets
npm run probe               # preflight: TLS, grant, identity, projects
```

The login prints a URL; open it in any browser, approve, and the loopback listener captures the redirect. Re-login is needed roughly every 30 days.

## MCP configuration

```json
{
  "mcpServers": {
    "bytebase": {
      "command": "node",
      "args": ["C:/path/to/bytebase-mcp/dist/index.js"],
      "env": { "BYTEBASE_URL": "https://bytebase.example.com" }
    }
  }
}
```

## Tools (14)

| Tool | Description |
|------|-------------|
| `bytebase_whoami` | Identity, server version, token life, visible projects — run first when debugging auth |
| `bytebase_list_projects` | Projects the identity can see |
| `bytebase_list_databases` | Databases with instance/engine/environment (the `ref` feeds other tools) |
| `bytebase_search_tables` | Find tables by name/column (~1000-table prod DBs) |
| `bytebase_describe_table` | Columns, indexes, foreign keys |
| `bytebase_query` | SQL through the SQL Editor — read-only by default (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN), routed to the read-only replica when one exists; write SQL requires `BYTEBASE_ALLOW_WRITE=true` |
| `bytebase_query_history` | Recent queries recorded by Bytebase |
| `bytebase_list_issues` | Schema/data change issues with approval status |
| `bytebase_create_plan` | Draft a SQL change plan (Sheet + Plan) — **no SQL runs** until a human approves |
| `bytebase_get_plan` | Plan details incl. decoded SQL |
| `bytebase_update_plan` | Edit title/description/SQL of a draft or in-review plan |
| `bytebase_list_issue_labels` | Labels a project requires on review issues |
| `bytebase_submit_plan_for_review` | Open the review Issue — starts the approval workflow |
| `bytebase_close_plan` | Cancel a draft or its open review issue (refuses after rollout starts) |

**Write safety:** `bytebase_query` blocks writes by default; the plan workflow is the write route — it creates a reviewable proposal that only executes after human approval in the Bytebase UI.

## Environment variables

All configuration is environment-driven — nothing site-specific is bundled.

| Variable | Default | Purpose |
|---|---|---|
| `BYTEBASE_URL` | — | Instance base URL (required) |
| `BYTEBASE_MCP_HOME` | `~/.config/bytebase-mcp` | Token file location |
| `BYTEBASE_CALLBACK_PORT` | `51789` | Loopback OAuth redirect port |
| `BYTEBASE_ALLOW_WRITE` | unset | Allow write SQL in `bytebase_query` |
| `BYTEBASE_DEFAULT_LIMIT` / `BYTEBASE_MAX_LIMIT` | 200 / 5000 | Row caps |
| `BYTEBASE_PROXY` / `HTTPS_PROXY` | — | Outbound proxy |
| `BYTEBASE_CA_FILE` / `NODE_EXTRA_CA_CERTS` | — | Extra CA for servers with an incomplete cert chain |

## Development

```bash
npm run typecheck && npm run build && npm test
npm run probe                                    # live preflight against .env
node test/mcp-e2e.mjs                            # full stdio protocol test (needs auth)
```

## Releasing

CI runs on every push and PR (typecheck → build → tests). Publishing is **GitHub-Release-driven** and uses **npm Trusted Publishers** (OIDC — no token secret in CI):

```bash
# 1. Bump "version" in package.json, commit and push to main
# 2. Create a GitHub Release (web UI, or):
gh release create v0.2.1 --generate-notes --repo ahmedbally/bytebase-mcp
```

On publish, the workflow verifies the release tag matches `package.json`, runs the full verification, publishes to npm with a provenance attestation, and appends the published version to the release notes.

**One-time setup** (repo owner): on npmjs.com → `bytebase-mcp` → Settings → *Trusted Publisher*, add `ahmedbally/bytebase-mcp` with workflow `publish.yml` (no environment). Until that's configured, release publishing will fail with 403.

## License

MIT
