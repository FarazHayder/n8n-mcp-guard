# Contributing

Thank you for helping improve n8n-mcp-guard. Bug reports, documentation
improvements, tests, safety hardening, and reusable n8n tools are welcome.

## Before you start

- Open an issue before a large behavioral change so its scope can be discussed.
- Never share n8n API keys, write tokens, customer data, credential metadata,
  production workflow exports, or files from `n8n-workflow-backups/`.
- Keep generic tools independent from workflow- or organization-specific node
  names and IDs.
- New mutation tools must fail closed and document their safety boundaries.

## Local development

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm ci`.
3. Make the smallest change that solves the issue.
4. Add or update tests for behavior changes.
5. Run `npm run check`.
6. Open a pull request explaining the problem, approach, safety impact, and
   verification performed.

## Pull request checklist

- [ ] The change is focused and documented.
- [ ] Tests cover new or changed behavior.
- [ ] `npm run check` passes.
- [ ] No secrets, private workflow definitions, or customer data are included.
- [ ] New write behavior is opt-in, narrowly scoped, and verified after mutation.
- [ ] `CLAUDE.md` and `AGENTS.md` remain aligned when agent guidance changes.

