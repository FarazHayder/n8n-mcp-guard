# n8n-mcp-guard

[![npm version](https://img.shields.io/npm/v/n8n-mcp-guard.svg)](https://www.npmjs.com/package/n8n-mcp-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

**The n8n MCP server that can't silently break production.**

A [Model Context Protocol](https://modelcontextprotocol.io/) server for n8n
where every write is gated. No mutation can happen without a private write
token, and with a token set every write still needs per-call approval, must
match the exact workflow version it was planned against, must have a verified
backup on disk, and is read back and compared before anything is published.

Set it up once. Use it from any MCP-capable agent, in every repository, with
your n8n credentials living outside all of them.

## Quick start

**1. Install**

```bash
npm install -g n8n-mcp-guard
```

**2. Configure once, for every project**

Create one file and every repository is covered:

- Windows: `%APPDATA%\n8n-mcp-guard\.env`
- macOS / Linux: `~/.config/n8n-mcp-guard/.env`

```dotenv
N8N_BASE_URL=https://your-instance.example.com
N8N_API_KEY=your-api-key

# Optional. Omit for a read-only server; set it to enable the write tools.
MCP_WRITE_AUTH_TOKEN=
```

Create the API key in n8n under **Settings → n8n API**. Leave
`MCP_WRITE_AUTH_TOKEN` empty until you actually want the mutating tools: with
no token they are not registered at all.

**3. Register with your agent, once**

```bash
# Claude Code
claude mcp add --transport stdio --scope user n8n-guard -- n8n-mcp-guard

# Codex
codex mcp add n8n-guard -- n8n-mcp-guard
```

That's it. Both register at user scope, so the server is available in every
repository without adding anything to any project. Nothing goes in your
project's `package.json` — an MCP server is a process your agent launches, not
a dependency you install per repo.

## What makes this different

The excellent [`n8n-mcp`](https://www.npmjs.com/package/n8n-mcp) gives agents
deep *knowledge* of n8n's node catalog so they can author workflows. This
project solves the opposite problem: you already have a workflow running in
production, and you want an agent to change it **without the change going
wrong silently.**

The guarantees it is built around:

- **Two-phase commit for every update.** `plan` reads the live workflow, backs
  it up, and records a fingerprint of exactly the state your change was
  designed against. `apply` refuses unless the workflow is *still* that state,
  byte for byte. A concurrent edit aborts the write instead of silently
  clobbering it, including the case where someone changed the graph but the
  version ID did not move.
- **A backup gate that is actually enforced.** Not advice in a markdown file:
  `apply` looks for a checksum-verified backup of the exact version being
  modified and refuses to write without one. Tampered backups do not count.
- **Readback verification.** After saving, the graph is re-fetched and
  fingerprinted. If n8n stored something other than what was asked for, the
  tool fails loudly instead of reporting success.
- **The write token is the opt-in.** With no `MCP_WRITE_AUTH_TOKEN` set, the
  mutating tools are not merely unused, they are never registered with the
  client at all. Setting a long random token is the deliberate act that turns
  writes on; `ENABLE_N8N_WORKFLOW_WRITE_TOOLS=false` force-disables them again.
- **Per-call approval.** Even with a token, every mutating call needs both the
  token and an explicit `approved: true` argument.
- **Disposable test clones, safe by construction.** A clone has every trigger
  and every outbound node (HTTP, email, Slack, Telegram, shell) disabled unless
  you name an exception, and the deleter refuses to touch any workflow whose
  name does not start with the temporary-test prefix.

The operating procedure ships with the code, as `CLAUDE.md`, `AGENTS.md`, and a
reusable agent skill, so your agent follows the same rules the server enforces.

> [!NOTE]
> **Scope, stated plainly.** Every tool the server registers by default is
> generic and works against any workflow on any n8n instance. Two further
> reference tools for one specific topology exist in the source but stay
> unregistered unless you opt in with `ENABLE_EXAMPLE_TOOLS=true`.

## Tools

Read-only tools, always available:

| Tool | Description |
| --- | --- |
| `n8n_get_workflow` | Compact workflow summary, or the full updateable definition. Never returns credential secrets. |
| `n8n_diff_workflow` | Structured diff of a proposed definition against the live one. Stores nothing. |
| `n8n_plan_workflow_update` | Phase 1 of a guarded update: backs up, diffs, and returns a `plan_id` to review. Changes nothing in n8n. |
| `n8n_backup_workflow` | Writes a checksum-verified local backup. Reads n8n only. |
| `n8n_list_test_clones` | Finds leftover temporary clones so nothing is left running. |

Write tools, registered whenever `MCP_WRITE_AUTH_TOKEN` is set:

| Tool | Scope | Description |
| --- | --- | --- |
| `n8n_apply_workflow_update` | Generic | Phase 2: commits a plan only if the live workflow still matches the plan and a verified backup of that version exists, then confirms by readback. |
| `n8n_create_test_clone` | Generic | Inactive clone with every trigger and outbound node disabled unless explicitly allowed. |
| `n8n_delete_test_clone` | Generic | Deactivates, deletes, and verifies removal. Refuses any workflow not named as a temporary test clone. |
| `n8n_restore_workflow_backup` | Generic | Restores from a backup file as a normal plan, so it still shows a diff and needs an explicit apply. |

Every write tool additionally requires `approved: true` and the write token on
each call, so an agent cannot mutate anything by accident even when the tools
are registered. To keep the server strictly read-only even with a token
present, set `ENABLE_N8N_WORKFLOW_WRITE_TOOLS=false`.

Two further tools, `n8n_test_supplier_email_action_routing` and
`n8n_configure_supplier_email_action_routing`, are **reference
implementations** for one exact Shopify-triggered order-email topology. They
are not registered unless you also set `ENABLE_EXAMPLE_TOOLS=true`, because
they fail closed on any other workflow shape. Read
`src/n8n/emailActionRouting.ts` and `src/n8n/emailActionTestClone.ts` to see
how a topology-specific guarded tool is built on top of the generic layer.

### A guarded change, end to end

```text
n8n_plan_workflow_update   -> review the diff, keep the plan_id
n8n_create_test_clone      -> rehearse with no triggers and no outbound calls
n8n_delete_test_clone      -> clean up, verified gone
n8n_apply_workflow_update  -> commits only if nothing moved, verifies by readback
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `N8N_BASE_URL` | Yes | — | Instance root URL, or an explicit `/api/v1` URL. |
| `N8N_API_KEY` | Yes | — | Created under Settings → n8n API. |
| `ENABLE_N8N_WORKFLOW_TOOLS` | No | `true` | Registers the read-only tools. |
| `MCP_WRITE_AUTH_TOKEN` | For writes | — | Long random value. **Setting it is what enables the write tools**; with it empty they are never registered. |
| `ENABLE_N8N_WORKFLOW_WRITE_TOOLS` | No | `true` | Set `false` to force writes off even when a token is configured. |
| `ENABLE_EXAMPLE_TOOLS` | No | `false` | Registers the two topology-specific reference tools. |
| `N8N_MCP_BACKUP_DIR` | No | `<user config>/backups` | Where verified workflow backups are written. |

Resolved in this order, first match wins:

1. **The process environment** — whatever your client passes in its `env` block.
2. **`N8N_MCP_ENV_FILE`** — an explicit path to a dotenv file.
3. **A `.env` beside the package** — how a cloned checkout is normally set up.
4. **A user-level `.env`** — `%APPDATA%\n8n-mcp-guard\.env` on Windows,
   `~/.config/n8n-mcp-guard/.env` on macOS and Linux.

Option 4 is recommended: your API key never appears in a client config file or
a project repository. On startup the server reports which source it used on
stderr, and warns about any missing required value.

> Never commit a real `.env`. It is git-ignored here and excluded from the
> published npm package.

## Client setup

Any client that speaks MCP over stdio works. If you installed from source,
replace `n8n-mcp-guard` with `node "C:\absolute\path\to\dist\index.js"`.

### Cursor, Windsurf, Claude Desktop, and most other clients

These use the widely adopted `mcpServers` shape — check your client's docs for
the config file location:

```json
{
  "mcpServers": {
    "n8n-guard": {
      "command": "npx",
      "args": ["-y", "n8n-mcp-guard"]
    }
  }
}
```

With a user-level `.env` in place, no `env` block is needed at all. If you
prefer inline config, add one:

```json
"env": {
  "N8N_BASE_URL": "https://your-instance.example.com",
  "N8N_API_KEY": "your-api-key"
}
```

### VS Code

VS Code uses the same entry shape under a `servers` key instead of
`mcpServers`. Add it via **MCP: Add Server** in the Command Palette, or put the
equivalent block in your `mcp.json`.

## Safety model

Read-only inspection works without registering a single write tool: leave
`MCP_WRITE_AUTH_TOKEN` empty and the server has no mutating capability at all.
Once a token is set, every mutating call still requires that token and
`approved: true`.
The write path validates the expected nodes, checks the workflow version
optimistically, and verifies the saved graph after mutation — refusing to
publish when the readback does not match the request.

`CLAUDE.md` and `AGENTS.md` add stricter agent-facing rules: local backups,
isolated test clones, controlled delivery to test destinations only, mandatory
cleanup, and production readback.
`.claude/skills/n8n-safe-change/SKILL.md` packages the same procedure as a
reusable skill for Claude Code.

> [!IMPORTANT]
> **What is and is not enforced.** The backup gate, the version and content
> match, the readback check, and the clone delete guard are enforced in code and
> covered by tests. The *controlled real-delivery test* - actually sending one
> message to a test destination and confirming receipt - is not machine-verified;
> the server cannot prove a human checked an inbox. That step still relies on the
> agent instructions in `CLAUDE.md` and `AGENTS.md`. Keep write tools disabled
> unless you can supervise the change.
>
> **Verification status.** 56 unit tests cover the logic, including every abort
> path. The read-only half of the generic layer has also been validated against
> a live instance: workflow fingerprinting, diffing, clone construction and the
> backup gate were run across 99 real production workflows spanning 40 distinct
> node types, neutralizing 114 triggers and 304 outbound nodes with no failures.
> The *write* paths (apply, create clone, delete clone) are covered by unit
> tests against a fake n8n, not yet by an integration suite against a real one.

## Install from source

```bash
git clone https://github.com/FarazHayder/n8n-mcp-guard.git
cd n8n-mcp-guard
npm ci          # also builds, via the prepare script
npm run check   # typecheck, tests, build, MCP handshake smoke test
```

Then point your client at the absolute path to `dist/index.js`.

## Development

```bash
npm run dev        # run from TypeScript source
npm run typecheck
npm test
npm run build
npm run smoke      # MCP handshake against the built server
npm run check      # all of the above
```

Run `npm run check` before opening a pull request.

## Roadmap

Shipped: generic guarded updates, an enforced backup gate, generic test clones,
and structured diffs.

- An integration suite against a disposable n8n instance in CI.
- Machine-verifiable evidence for the controlled-delivery step.
- Generic execution rehearsal: drive a clone with synthetic input and assert
  which nodes ran, without topology-specific code.

## Contributing

Contributions are welcome — bug fixes, documentation, tests, safety hardening,
and new *generic* n8n tools are all in scope. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first.

Never include API keys, `.env` files, production workflow exports, customer
data, or anything from `n8n-workflow-backups/` in an issue or pull request.

## Security

See [SECURITY.md](SECURITY.md). Report suspected vulnerabilities privately
through GitHub's private vulnerability reporting, not a public issue.

## License

[MIT](LICENSE) © Faraz Hayder
