# n8n-mcp-guard

[![npm version](https://img.shields.io/npm/v/n8n-mcp-guard.svg)](https://www.npmjs.com/package/n8n-mcp-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/FarazHayder/n8n-mcp-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/FarazHayder/n8n-mcp-guard/actions/workflows/ci.yml)

**Let an AI agent build and change your n8n workflows — with a guaranteed way back.**

Agents are good at writing workflow logic and bad at knowing when they have
broken something. `n8n-mcp-guard` sits in between. Every change is backed up
before it happens, checked against the exact version it was designed for, and
verified against the live instance after saving. If anything does not line up,
the write is refused rather than attempted and hoped for.

Set it up once, use it from any MCP-capable agent, in every repository.

## Who it's for

**You're building something new.** Describe the automation you want, let the
agent write it, and create it as an inactive workflow you can inspect before
anything runs. Iterate with a reviewable diff at every step. You never have to
read raw JSON to know what changed, and you can always get back to the last
version that worked.

**You have something already running.** The workflow that quietly emails your
customers or syncs your orders is the one you least want an agent improvising
on. Here, a change to it is a two-phase commit: plan it, review the diff,
rehearse it on a disposable clone with every trigger and outbound call
disabled, then commit — and only if nothing moved underneath you in the
meantime.

## Why you can trust it

- **67 tests**, covering every path where a write is supposed to be refused.
- **Validated against a real instance**: workflow fingerprinting, diffing,
  clone construction and the backup gate were run across **99 real production
  workflows** spanning **40 distinct node types**, correctly neutralizing
  **114 triggers** and **304 outbound nodes** — zero failures.
- **Nothing can write until you say so.** With no write token configured, the
  mutating tools are not merely unused, they are never registered at all.
- **CI on Node 22 and 24.** MIT licensed. No telemetry, no network calls except
  to your own n8n instance.

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

# Set this to enable the write tools. Leave empty for a read-only server.
MCP_WRITE_AUTH_TOKEN=a-long-random-value
```

Create the API key in n8n under **Settings → n8n API**.

**3. Register with your agent, once**

```bash
# Claude Code
claude mcp add --transport stdio --scope user n8n-guard -- n8n-mcp-guard

# Codex
codex mcp add n8n-guard -- n8n-mcp-guard
```

Both register at user scope, so the server is available in every repository
without adding anything to any project. Nothing goes in your project's
`package.json` — an MCP server is a process your agent launches, not a
dependency you install per repo.

## How a change actually works

```text
n8n_plan_workflow_update    backs up, diffs, hands you a plan_id
      ↓                     you read the diff and agree to it
n8n_create_test_clone       rehearse: no triggers, no outbound calls
n8n_delete_test_clone       cleaned up, verified gone
      ↓
n8n_apply_workflow_update   commits only if nothing moved; verifies by readback
```

What that buys you, concretely:

- **Plan and apply are separate.** The plan records a fingerprint of the exact
  live state your change was designed against. If a colleague edits the
  workflow in the n8n UI while you are reviewing the diff, the apply aborts —
  including the case where the content changed but the version ID did not.
- **A backup must exist to write.** Not advice in a document: the apply step
  looks for a checksum-verified backup of that exact version and refuses
  without one. Tampered backups do not count.
- **The result is proven, not assumed.** After saving, the graph is re-fetched
  and fingerprinted. An instance that stores something other than what it was
  sent fails loudly instead of reporting success.
- **Rehearsals cannot reach the outside world.** A test clone has every trigger
  and every outbound node — HTTP, email, Slack, Telegram, shell — disabled
  unless you name an exception. The deleter refuses to touch any workflow that
  isn't one of these clones.

## Tools

Read-only, always available:

| Tool | Description |
| --- | --- |
| `n8n_get_workflow` | Workflow summary, or the full updateable definition. Never returns credential secrets. |
| `n8n_diff_workflow` | Structured diff of a proposed definition against the live one. Stores nothing. |
| `n8n_plan_workflow_update` | Phase 1: backs up, diffs, returns a `plan_id`. Changes nothing in n8n. |
| `n8n_backup_workflow` | Writes a checksum-verified local backup. |
| `n8n_list_test_clones` | Finds leftover rehearsal clones so nothing is left running. |

Write tools, registered whenever `MCP_WRITE_AUTH_TOKEN` is set:

| Tool | Description |
| --- | --- |
| `n8n_create_workflow` | Creates a new workflow from an agent-authored definition. Always inactive, read back and verified, backed up immediately. |
| `n8n_apply_workflow_update` | Phase 2: commits a plan only if the live workflow still matches it and a verified backup exists, then confirms by readback. |
| `n8n_create_test_clone` | Inactive clone with every trigger and outbound node disabled unless explicitly allowed. |
| `n8n_delete_test_clone` | Deactivates, deletes, verifies removal. Refuses anything that isn't a rehearsal clone. |
| `n8n_restore_workflow_backup` | Restores from a backup as a normal plan, so it still shows a diff and needs an explicit apply. |

Every write additionally requires `approved: true` and the token on each call,
so an agent cannot mutate anything by accident. To keep the server strictly
read-only even with a token present, set
`ENABLE_N8N_WORKFLOW_WRITE_TOOLS=false`.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `N8N_BASE_URL` | Yes | — | Instance root URL, or an explicit `/api/v1` URL. |
| `N8N_API_KEY` | Yes | — | Created under Settings → n8n API. |
| `MCP_WRITE_AUTH_TOKEN` | For writes | — | Long random value. **Setting it is what enables the write tools.** |
| `ENABLE_N8N_WORKFLOW_TOOLS` | No | `true` | Registers the read-only tools. |
| `ENABLE_N8N_WORKFLOW_WRITE_TOOLS` | No | `true` | Set `false` to force writes off even with a token configured. |
| `N8N_MCP_BACKUP_DIR` | No | `<user config>/backups` | Where verified backups are written. |
| `ENABLE_EXAMPLE_TOOLS` | No | `false` | Registers two topology-specific reference tools (see below). |

Values resolve in this order, first match wins:

1. **The process environment** — what your client passes in its `env` block.
2. **`N8N_MCP_ENV_FILE`** — an explicit path to a dotenv file.
3. **A `.env` beside the package** — how a cloned checkout is set up.
4. **A user-level `.env`** — the path from the quick start above.

Option 4 is recommended: your API key never appears in a client config file or
a project repository. On startup the server reports which source it used, on
stderr.

> Never commit a real `.env`. It is git-ignored here and excluded from the
> published npm package.

## Client setup

Any client that speaks MCP over stdio works. Cursor, Windsurf, Claude Desktop
and most others use this shape — check your client's docs for the file
location:

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

With a user-level `.env` in place, no `env` block is needed. VS Code uses the
same entry shape under a `servers` key instead of `mcpServers`; add it through
**MCP: Add Server** in the Command Palette.

## Where the guarantees stop

Being precise about this is the point of the project, so here is the honest
boundary.

**Confirming a message looked right is yours.** If a change affects delivery,
someone still has to look at the test inbox. No server can prove a human read
an email, and this one does not pretend to. What it guarantees is that you can
always get back to the version that worked. `CLAUDE.md`, `AGENTS.md` and the
bundled agent skill encode the review procedure so your agent follows it.

**The write paths are unit-tested, not integration-tested.** Every refusal path
is covered against a fake n8n, and the read-only layer has been exercised
against 99 real workflows. An integration suite against a disposable live
instance is on the roadmap.

**Two tools are examples, not products.** `n8n_test_supplier_email_action_routing`
and `n8n_configure_supplier_email_action_routing` target one exact
Shopify-triggered order-email topology and fail closed on anything else. They
stay unregistered unless you set `ENABLE_EXAMPLE_TOOLS=true`. Read
`src/n8n/emailActionRouting.ts` and `src/n8n/emailActionTestClone.ts` to see
how a workflow-specific guarded tool is built on the generic layer.

## Install from source

```bash
git clone https://github.com/FarazHayder/n8n-mcp-guard.git
cd n8n-mcp-guard
npm ci          # also builds, via the prepare script
npm run check   # typecheck, tests, build, MCP handshake
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

- An integration suite against a disposable n8n instance in CI.
- Generic execution rehearsal: drive a clone with synthetic input and assert
  which nodes ran, without workflow-specific code.
- Richer diffs, including expression-level changes inside Code nodes.

## Contributing

Bug fixes, documentation, tests, safety hardening, and new *generic* n8n tools
are all welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

Never include API keys, `.env` files, production workflow exports, customer
data, or anything from `n8n-workflow-backups/` in an issue or pull request.

## Security

See [SECURITY.md](SECURITY.md). Report suspected vulnerabilities privately
through GitHub's private vulnerability reporting, not a public issue.

## License

[MIT](LICENSE) © Faraz Hayder
