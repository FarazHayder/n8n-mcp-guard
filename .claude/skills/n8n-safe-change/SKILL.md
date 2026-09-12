---
name: n8n-safe-change
description: Safety procedure for reading, testing, and changing n8n workflows through the n8n-mcp-guard MCP server. Use whenever a task involves inspecting, cloning, testing, updating, activating, deactivating, publishing, or deleting an n8n workflow, or when an n8n workflow ID or any n8n_* tool comes up.
---

# Safe n8n workflow changes

Treat every n8n workflow as production infrastructure. Reading and diagnosis
are always allowed. Mutation is gated.

## The happy path

For any production change, run these in order. Each one is a real tool; do not
hand-roll an equivalent.

```text
1. n8n_get_workflow            read it, understand it
2. n8n_plan_workflow_update    backs up + returns a diff and a plan_id
3.   -> show the diff to the user and get agreement
4. n8n_create_test_clone       rehearse: triggers and outbound nodes disabled
5. n8n_delete_test_clone       always, pass or fail
6. n8n_apply_workflow_update   commit the plan_id
```

Steps 2 and 6 are a two-phase commit. The plan records the exact live state
your change was designed against; the apply refuses if anything moved. Do not
try to bypass this by writing a definition directly.

## What the server enforces for you

You do not need to re-implement these, and you must not work around them:

- **Backup before write.** `n8n_plan_workflow_update` writes a
  checksum-verified backup, and `n8n_apply_workflow_update` refuses to run
  unless a valid backup for that exact version still exists.
- **No silent clobbering.** Apply aborts if the version ID moved, or if the
  content changed while the version ID did not.
- **Readback proof.** After saving, the graph is re-read and compared. A
  mismatch is an error, not a success.
- **Clone deletion safety.** `n8n_delete_test_clone` refuses any workflow whose
  name does not mark it as a temporary test clone.

If a tool refuses, that is the safety system working. Report the refusal and
the evidence; do not route around it.

## What you must still do yourself

The server cannot verify these. They are your responsibility.

### Isolated delivery testing

If a change affects delivery, the clone must send exactly one real message,
with synthetic data, to a dedicated internal test inbox or test chat. Prefix
the subject or body with `TEST — DO NOT ACTION`.

Pass the one node under test to `allow_node_names` so it stays enabled, and
override the destination. Never send to a real customer, a production
recipient, or a production group. If no isolated test destination exists, or
the destination or payload is uncertain, send nothing — stop and ask.

### Verifying receipt

Confirm the execution succeeded, only the expected outbound node ran, exactly
one message was accepted, and the content is correct. An n8n `success` status
alone is not proof of receipt when delivery evidence is available.

### Cleanup

Always delete the clone, pass or fail. Use `n8n_list_test_clones` to confirm
nothing was left behind. Leave no test workflows, triggers, schedules,
webhooks, or executions running.

## Backups are sensitive

Backups may contain production configuration or inline secrets. Never commit,
upload, paste, or share them. If a repository keeps them locally, that
directory must stay git-ignored.

## Fail closed

If any gate fails — backup, isolation, delivery, cleanup, version match, or
readback — or if any uncertainty remains, do not modify production. Stop and
present the evidence and the decision to the user.

Authorization is always scoped to the one workflow and the one behavior
requested. It never extends to unrelated production changes, customer-facing
test messages, bulk sends, or skipping a gate.

## Topology-specific tools

`n8n_test_supplier_email_action_routing` and
`n8n_configure_supplier_email_action_routing` are reference implementations for
one specific workflow shape. They fail closed elsewhere. Prefer the generic
tools above unless you are working on exactly that topology.
