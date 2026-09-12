# Security Policy

This project connects AI agents to n8n instances and may be given credentials
that can read or modify production workflows. Treat security reports and
configuration mistakes seriously.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting feature for this repository when available. Include a
clear description, affected version or commit, reproduction steps, impact, and
any suggested mitigation. Do not include real credentials or customer data.

## Operational guidance

- Use a dedicated n8n API key with the least privilege available.
- Keep `.env` and `n8n-workflow-backups/` local and untracked.
- Leave `ENABLE_N8N_WORKFLOW_WRITE_TOOLS=false` unless write access is required.
- Review tool arguments and generated workflow changes before approval.
- Revoke and rotate credentials immediately if they may have been exposed.
- Prefer HTTPS for remote n8n instances; plain HTTP should be limited to trusted
  local development environments.

Until tagged releases are published, security fixes are provided on the latest
revision of the default branch.

