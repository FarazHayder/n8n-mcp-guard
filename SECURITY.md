# Security Policy

`n8n-mcp-guard` holds an n8n API key and can change workflows, so security
reports are taken seriously and handled promptly.

## Reporting a vulnerability

Please don't open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting on this repository. Include a clear
description, the affected version or commit, reproduction steps, impact, and
any suggested mitigation. Don't include real credentials or customer data.

## How the server protects you

- Write tools are not registered at all until `MCP_WRITE_AUTH_TOKEN` is set,
  and every write call must also carry that token and `approved: true`.
- Every update is planned against a fingerprint of the live workflow and
  refused if anything changed underneath it.
- A checksum-verified backup of the exact version being modified must exist on
  disk before a write is allowed.
- Saved results are read back and compared, so a silent divergence is an error
  rather than a success.
- Clone deletion refuses any workflow that isn't one of its own test clones.
- Workflow definitions are returned without credential secrets.

## Hardening your setup

- Use a dedicated n8n API key with the least privilege your instance allows.
- Treat `MCP_WRITE_AUTH_TOKEN` like a password: long, random, and stored in a
  user-level `.env` rather than a client config file your editor may sync.
- Keep `.env` and any workflow backups local and untracked. Backups can contain
  production configuration.
- Read the diff a plan returns before applying it. Two-phase commit exists so
  that review is possible.
- Rotate credentials immediately if they may have been exposed.
- Prefer HTTPS for remote instances; limit plain HTTP to local development.

## Supported versions

Security fixes are released on the latest published version.
