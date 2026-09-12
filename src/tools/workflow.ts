import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { env, writeToolsAvailable } from '../env.js';
import { N8nApiError, type N8nClient, type N8nWorkflow } from '../n8n/client.js';
import { readFileSync } from 'node:fs';
import { findBackup, readBackup, writeBackup } from '../n8n/backup.js';
import { diffWorkflows, workflowSignature } from '../n8n/graph.js';
import { prepareNewWorkflow } from '../n8n/create.js';
import {
  assertDeletableClone,
  buildTestClone,
  inspectCloneSafety,
  isTestClone,
} from '../n8n/testClone.js';
import { applyUpdatePlan, createUpdatePlan, getPlan, summarizePlan } from '../n8n/guardedUpdate.js';
import { jsonContent } from './util.js';

/**
 * Generic, topology-independent tools. Unlike the reference implementations
 * in `n8n.ts`, nothing here assumes a particular workflow shape.
 */

type Json = ReturnType<typeof jsonContent>;

function errorResult(error: unknown): Json {
  if (error instanceof N8nApiError) {
    return jsonContent({ error: error.message, statusCode: error.statusCode, details: error.details });
  }
  return jsonContent({ error: error instanceof Error ? error.message : String(error) });
}

const workflowDefinition = z
  .object({
    name: z.string().min(1),
    nodes: z.array(z.record(z.unknown())).min(1),
    connections: z.record(z.unknown()),
    settings: z.record(z.unknown()).optional(),
  })
  .passthrough();

function asWorkflow(value: unknown): N8nWorkflow {
  const workflow = value as N8nWorkflow;
  return { ...workflow, settings: workflow.settings ?? {} };
}

export function registerWorkflowTools(
  server: McpServer,
  client: () => N8nClient,
  writeGuard: (token?: string) => string | null,
): void {
  // --- backup: local-only, so it is available without write tools ---------
  server.tool(
    'n8n_backup_workflow',
    'Save a verified local backup of any n8n workflow. Writes nothing to n8n. The backup is read back and checksum-verified, and n8n_apply_workflow_update refuses to run without one matching the exact version being changed.',
    { workflow_id: z.string().min(1) },
    async ({ workflow_id }) => {
      try {
        const workflow = await client().getWorkflow(workflow_id);
        const evidence = writeBackup(workflow, env.backupDir);
        return jsonContent({ ok: true, backup: evidence, backupDir: env.backupDir });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --- plan: read-only, computes the diff without touching n8n ------------
  server.tool(
    'n8n_plan_workflow_update',
    'Phase 1 of a guarded update. Reads the live workflow, backs it up, diffs it against your proposed definition, and returns a plan_id plus a structured diff to review. Changes nothing in n8n. Pass the plan_id to n8n_apply_workflow_update to commit.',
    {
      workflow_id: z.string().min(1),
      definition: workflowDefinition,
    },
    async ({ workflow_id, definition }) => {
      try {
        const plan = await createUpdatePlan(
          client(),
          workflow_id,
          asWorkflow(definition),
          env.backupDir,
        );
        return jsonContent({ ok: true, plan: summarizePlan(plan) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'n8n_diff_workflow',
    'Compare a proposed workflow definition against the live one and return a structured diff. Read-only, and unlike planning it stores nothing.',
    {
      workflow_id: z.string().min(1),
      definition: workflowDefinition,
    },
    async ({ workflow_id, definition }) => {
      try {
        const current = await client().getWorkflow(workflow_id);
        const next = asWorkflow(definition);
        return jsonContent({
          ok: true,
          workflowId: workflow_id,
          currentVersionId: current.versionId ?? null,
          currentSignature: workflowSignature(current),
          proposedSignature: workflowSignature(next),
          diff: diffWorkflows(current, next),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'n8n_list_test_clones',
    'List leftover temporary test clones created by this server, so nothing is left running. Read-only.',
    {},
    async () => {
      try {
        const workflows = await client().listWorkflows();
        const clones = workflows.filter(isTestClone).map((workflow) => ({
          id: workflow.id ?? null,
          name: workflow.name,
          active: workflow.active ?? null,
        }));
        return jsonContent({ ok: true, count: clones.length, clones });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  if (!writeToolsAvailable()) return;

  // --- everything below mutates n8n and is gated -------------------------
  server.tool(
    'n8n_create_test_clone',
    'Create an inactive, side-effect-free copy of any workflow for rehearsal. Every trigger and every outbound node (HTTP, email, chat, command execution) is disabled unless explicitly allowed, and the clone is named with a "[TEMP TEST]" prefix so it can be safely deleted afterwards. Always delete the clone with n8n_delete_test_clone when finished.',
    {
      workflow_id: z.string().min(1),
      remove_node_names: z.array(z.string()).optional(),
      allow_node_names: z.array(z.string()).optional(),
      approved: z.literal(true),
      write_token: z.string().min(1),
    },
    async ({ workflow_id, remove_node_names, allow_node_names, write_token }) => {
      const guardError = writeGuard(write_token);
      if (guardError) return jsonContent({ error: guardError });
      try {
        const api = client();
        const source = await api.getWorkflow(workflow_id);
        const built = buildTestClone(source, {
          removeNodeNames: remove_node_names,
          allowNodeNames: allow_node_names,
        });

        const created = await api.createWorkflow(built.definition);
        const cloneId = String(created.id ?? '');
        if (!cloneId) throw new Error('n8n created the clone without returning an ID.');

        // Verify what n8n actually stored, not what we sent.
        const saved = await api.getWorkflow(cloneId);
        const savedSafety = inspectCloneSafety(saved, { allowNodeNames: allow_node_names });
        if (!savedSafety.safe || saved.active === true) {
          try {
            await api.deleteWorkflow(cloneId);
          } catch {
            return jsonContent({
              error: `Saved clone failed safety inspection and could NOT be deleted. Delete workflow ${cloneId} manually.`,
              violations: savedSafety.violations,
            });
          }
          return jsonContent({
            error: `Saved clone failed safety inspection; it was deleted again: ${savedSafety.violations.join('; ')}`,
          });
        }

        return jsonContent({
          ok: true,
          cloneWorkflowId: cloneId,
          cloneName: saved.name,
          active: saved.active ?? false,
          sourceWorkflowId: workflow_id,
          sourceVersionId: source.versionId ?? null,
          disabledTriggers: built.disabledTriggers,
          disabledSideEffects: built.disabledSideEffects,
          removedNodes: built.removedNodes,
          deliberatelyAllowed: savedSafety.deliberatelyAllowed,
          reminder: 'Delete this clone with n8n_delete_test_clone when the rehearsal is finished.',
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'n8n_create_workflow',
    'Create a new n8n workflow from a definition you author. Always created inactive, so nothing runs until you turn it on in n8n. The saved result is read back and compared to what was sent, and a local backup is written immediately so there is a restore point from the very first version. Use this to build a new automation with an agent; use n8n_plan_workflow_update to change one that already exists.',
    {
      definition: workflowDefinition,
      approved: z.literal(true),
      write_token: z.string().min(1),
    },
    async ({ definition, write_token }) => {
      const guardError = writeGuard(write_token);
      if (guardError) return jsonContent({ error: guardError });
      try {
        const api = client();
        const payload = prepareNewWorkflow(asWorkflow(definition));
        const created = await api.createWorkflow(payload);
        const workflowId = String(created.id ?? '');
        if (!workflowId) throw new Error('n8n created the workflow without returning an ID.');

        // Read back what n8n actually stored rather than trusting the response.
        const saved = await api.getWorkflow(workflowId);
        const matches = workflowSignature(saved) === workflowSignature(payload);
        const backup = writeBackup(saved, env.backupDir);

        return jsonContent({
          ok: true,
          workflowId,
          workflowName: saved.name,
          active: saved.active ?? false,
          versionId: saved.versionId ?? null,
          nodeCount: saved.nodes.length,
          readbackMatches: matches,
          backupPath: backup.path,
          ...(matches
            ? {}
            : {
                warning:
                  'n8n normalised or altered the definition on save. The workflow was created; inspect it with n8n_get_workflow before building on it.',
              }),
          note: 'Created inactive. Activate it in n8n when you are ready.',
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'n8n_delete_test_clone',
    'Deactivate and permanently delete a temporary test clone, then verify it is gone. Refuses to delete any workflow whose name does not start with "[TEMP TEST", so it cannot remove a real workflow.',
    {
      clone_workflow_id: z.string().min(1),
      approved: z.literal(true),
      write_token: z.string().min(1),
    },
    async ({ clone_workflow_id, write_token }) => {
      const guardError = writeGuard(write_token);
      if (guardError) return jsonContent({ error: guardError });
      try {
        const api = client();
        const clone = await api.getWorkflow(clone_workflow_id);
        assertDeletableClone(clone);

        if (clone.active === true) await api.unpublishWorkflow(clone_workflow_id);
        await api.deleteWorkflow(clone_workflow_id);

        // Prove it is gone rather than trusting the delete response.
        let stillExists = false;
        try {
          await api.getWorkflow(clone_workflow_id);
          stillExists = true;
        } catch (error) {
          if (!(error instanceof N8nApiError) || error.statusCode !== 404) throw error;
        }
        if (stillExists) {
          return jsonContent({
            error: `Clone ${clone_workflow_id} still exists after the delete request.`,
          });
        }
        return jsonContent({ ok: true, deleted: clone_workflow_id, name: clone.name, verified: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'n8n_apply_workflow_update',
    'Phase 2 of a guarded update. Commits a plan from n8n_plan_workflow_update only if the live workflow is still byte-identical to what was planned against and a verified backup of that exact version exists, then reads the result back and confirms it matches. Any mismatch aborts. An active workflow is saved as an unpublished draft unless publish_if_active is true.',
    {
      plan_id: z.string().min(1),
      publish_if_active: z.boolean().optional(),
      approved: z.literal(true),
      write_token: z.string().min(1),
    },
    async ({ plan_id, publish_if_active, write_token }) => {
      const guardError = writeGuard(write_token);
      if (guardError) return jsonContent({ error: guardError });
      try {
        const plan = getPlan(plan_id);
        if (!plan) {
          return jsonContent({
            error: `Unknown or expired plan ${plan_id}. Plans expire 30 minutes after creation; create a new one.`,
          });
        }
        const result = await applyUpdatePlan(
          client(),
          plan_id,
          publish_if_active === true,
          env.backupDir,
        );
        return jsonContent(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'n8n_restore_workflow_backup',
    'Restore a workflow from a local backup file created by n8n_backup_workflow. Plans the restore as a normal guarded update, so it returns a diff and a plan_id that must be committed with n8n_apply_workflow_update.',
    {
      workflow_id: z.string().min(1),
      backup_path: z.string().min(1),
      approved: z.literal(true),
      write_token: z.string().min(1),
    },
    async ({ workflow_id, backup_path, write_token }) => {
      const guardError = writeGuard(write_token);
      if (guardError) return jsonContent({ error: guardError });
      try {
        const evidence = readBackup(backup_path);
        if (!evidence) {
          return jsonContent({ error: `No valid, checksum-verified backup at ${backup_path}.` });
        }
        if (evidence.workflowId !== workflow_id) {
          return jsonContent({
            error: `Backup is for workflow ${evidence.workflowId}, not ${workflow_id}.`,
          });
        }
        const parsed = JSON.parse(readFileSync(backup_path, 'utf8')) as {
          definition: N8nWorkflow;
        };
        const plan = await createUpdatePlan(
          client(),
          workflow_id,
          parsed.definition,
          env.backupDir,
        );
        return jsonContent({ ok: true, restoringFrom: evidence, plan: summarizePlan(plan) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

/** Re-exported so the backup gate can be checked without importing internals. */
export { findBackup };
