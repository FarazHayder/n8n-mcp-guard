### n8n workflow safety

Reading and diagnosis are always allowed. What follows applies to changes, and
the level of ceremony scales with what is actually at risk.

#### Building something new

Creating a workflow is not a production change. There is no previous version to
lose, and `n8n_create_workflow` always creates it inactive, so nothing runs.

- Build it, read it back, iterate freely.
- Do not activate a workflow without asking the user first. Activation is the
  moment it becomes real.
- Once it is live, it is covered by the section below.

Do not impose backup, clone or delivery ceremony on a workflow that has never
run. It slows the user down and protects nothing.

#### Changing a workflow that already exists

1. **Plan first.** Use `n8n_plan_workflow_update`. It backs the workflow up and
   returns a diff. Show the user the diff and get agreement before applying.
2. **Rehearse when the change is non-obvious.** `n8n_create_test_clone` gives
   an inactive copy with every trigger and outbound node disabled. Use it for
   anything involving routing, conditionals, or nodes that contact the outside
   world. Skip it for a trivial, obvious edit.
3. **Test real delivery only when delivery is what changed.** If the change
   affects an email, message or webhook that reaches someone, send exactly one
   message with synthetic data to a dedicated test inbox or test chat, prefixed
   `TEST — DO NOT ACTION`. Pass that one node to `allow_node_names` and override
   the destination. Never send to a real customer, production recipient or
   production group. If no isolated test destination exists, or the destination
   or payload is uncertain, send nothing and ask.
4. **Clean up.** Delete every clone with `n8n_delete_test_clone`, pass or fail.
   Confirm with `n8n_list_test_clones` that nothing is left running.
5. **Apply.** `n8n_apply_workflow_update` refuses if the workflow moved since
   planning or if its backup is missing, and verifies the result by readback.
6. **Report honestly.** If a tool refuses, that is the safety system working.
   Report the refusal and the evidence; do not route around it.

#### What the server already enforces

Do not reimplement these by hand:

- A checksum-verified backup must exist for the exact version being changed.
- An update aborts if the version moved, or if content changed while the
  version ID did not.
- Saved graphs are read back and compared; a mismatch is an error.
- Clone deletion refuses any workflow that is not one of its own test clones.

#### Backups are sensitive

Backups may contain production configuration or inline secrets. Never commit,
upload, paste or share them, and keep their directory git-ignored.

#### Fail closed

If a gate fails, or uncertainty remains about a change to a live workflow, stop
and put the evidence to the user. Authorization is scoped to the workflow and
behaviour actually requested; it never extends to unrelated changes,
customer-facing test messages, or bulk sends.
