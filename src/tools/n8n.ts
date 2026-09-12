import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configErrors, env, writeToolsAvailable } from '../env.js';
import { N8nApiError, N8nClient, workflowUpdatePayload } from '../n8n/client.js';
import {
  configureEmailActionRouting,
  emailActionRoutingSignature,
  inspectEmailActionRouting,
} from '../n8n/emailActionRouting.js';
import { runSafeEmailActionCloneTest } from '../n8n/emailActionTestClone.js';
import { registerWorkflowTools } from './workflow.js';
import { jsonContent } from './util.js';

function client(): N8nClient {
  const problems = configErrors();
  if (problems.length) {
    throw new Error(
      `n8n-mcp-guard is not configured: ${problems.join(' ')} See the Configuration section of the README.`,
    );
  }
  return new N8nClient(env.n8nBaseUrl, env.n8nApiKey);
}

function errorResult(error: unknown): ReturnType<typeof jsonContent> {
  if (error instanceof N8nApiError) {
    return jsonContent({ error: error.message, statusCode: error.statusCode, details: error.details });
  }
  return jsonContent({ error: error instanceof Error ? error.message : String(error) });
}

function writeGuard(writeToken?: string): string | null {
  if (!env.mcpWriteAuthToken) return 'MCP_WRITE_AUTH_TOKEN is not configured.';
  return writeToken === env.mcpWriteAuthToken ? null : 'Invalid or missing write_token.';
}

export function registerN8nTools(server: McpServer): void {
  if (!env.enableN8nWorkflowTools) return;

  server.tool(
    'n8n_get_workflow',
    'Read one n8n workflow through the official REST API. Returns a compact summary by default; include_definition returns the updateable workflow definition but never credential secrets.',
    {
      workflow_id: z.string().min(1),
      include_definition: z.boolean().optional(),
    },
    async ({ workflow_id, include_definition }) => {
      try {
        const workflow = await client().getWorkflow(workflow_id);
        return jsonContent({
          id: workflow.id ?? workflow_id,
          name: workflow.name,
          active: workflow.active ?? null,
          versionId: workflow.versionId ?? null,
          nodeCount: workflow.nodes.length,
          nodes: workflow.nodes.map((node) => ({ id: node.id, name: node.name, type: node.type })),
          emailActionRouting: inspectEmailActionRoutingSafe(workflow),
          ...(include_definition ? { definition: workflowUpdatePayload(workflow) } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // Generic, topology-independent tools. These gate themselves internally.
  registerWorkflowTools(server, client, writeGuard);

  if (!writeToolsAvailable()) return;
  // The two tools below target one exact workflow topology and are opt-in.
  if (!env.enableExampleTools) return;

  server.tool(
    'n8n_test_supplier_email_action_routing',
    'Reference implementation for one specific workflow topology; see the README before enabling it. Creates one temporary inactive clone of the target order-email workflow, removes every Shopify trigger and Front HTTP write before publishing it behind a random test webhook, executes synthetic routing cases against the Supplier Details source, then unpublishes and permanently deletes the clone. The production workflow is only read and must retain the same version throughout.',
    {
      workflow_id: z.string().min(1),
      expected_version_id: z.string().min(1),
      approved: z.literal(true),
      write_token: z.string().min(1),
    },
    async ({ workflow_id, expected_version_id, write_token }) => {
      const guardError = writeGuard(write_token);
      if (guardError) return jsonContent({ error: guardError });
      try {
        const api = client();
        const production = await api.getWorkflow(workflow_id);
        if (production.versionId !== expected_version_id) {
          return jsonContent({
            error: 'Workflow version changed; refusing to create a test clone from stale data.',
            expectedVersionId: expected_version_id,
            currentVersionId: production.versionId ?? null,
          });
        }
        const result = await runSafeEmailActionCloneTest(api, production);
        const after = await api.getWorkflow(workflow_id);
        if (after.versionId !== expected_version_id) {
          return jsonContent({
            error: 'Production workflow changed while the safe clone test was running.',
            expectedVersionId: expected_version_id,
            currentVersionId: after.versionId ?? null,
            cloneDeleted: result.cloneDeleted,
            cloneWorkflowId: result.cloneWorkflowId,
          });
        }
        return jsonContent({ ...result, productionUnchanged: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'n8n_configure_supplier_email_action_routing',
    'Reference implementation for one specific workflow topology; see the README before enabling it. Previews or applies the narrowly scoped Supplier Details / Email Action routing update to the target order-email workflow, preserving the existing Auto Send, Draft Only, and Do Nothing branches. Writes require approval, a write token, and post-update API readback verification. Active workflows are saved as an unpublished draft unless publish_if_active=true is explicitly requested.',
    {
      workflow_id: z.string().min(1),
      expected_version_id: z.string().min(1).optional(),
      publish_if_active: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      approved: z.literal(true),
      write_token: z.string().min(1),
    },
    async ({
      workflow_id,
      expected_version_id,
      publish_if_active,
      dry_run,
      write_token,
    }) => {
      const guardError = writeGuard(write_token);
      if (guardError) return jsonContent({ error: guardError });
      try {
        const api = client();
        const current = await api.getWorkflow(workflow_id);
        if (expected_version_id && current.versionId !== expected_version_id) {
          return jsonContent({
            error: 'Workflow version changed; refusing to update stale data.',
            expectedVersionId: expected_version_id,
            currentVersionId: current.versionId ?? null,
          });
        }

        const configured = configureEmailActionRouting(current);
        const preview = {
          workflowId: current.id ?? workflow_id,
          workflowName: current.name,
          active: current.active ?? null,
          currentVersionId: current.versionId ?? null,
          changed: configured.changed,
          publishIfActive: publish_if_active === true,
          changes: [
            'Map Supplier Details[Email Action] into supplier.email_action.',
            'Route Auto Send to the existing Front /messages nodes.',
            'Route Draft Only to the existing Front /drafts nodes.',
            'Route Do Nothing, blank, or unknown values to no Front request.',
          ],
          inspection: configured.inspection,
        };
        if (dry_run !== false || !configured.changed) {
          return jsonContent({ ok: true, dryRun: true, ...preview });
        }

        let publishMode = publish_if_active === true ? 'publishIfActive-query' : 'unpublished-draft';
        try {
          await api.updateWorkflow(workflow_id, configured.workflow, publish_if_active === true);
        } catch (error) {
          const unsupportedPublishQuery =
            error instanceof N8nApiError &&
            error.statusCode === 400 &&
            error.message.includes("Unknown query parameter 'publishIfActive'");
          if (!unsupportedPublishQuery) throw error;

          // Older n8n versions reject publishIfActive. Re-check optimistic
          // concurrency, save through the legacy PUT, verify the saved graph,
          // then publish that exact returned version explicitly.
          const beforeLegacyUpdate = await api.getWorkflow(workflow_id);
          if (beforeLegacyUpdate.versionId !== current.versionId) {
            return jsonContent({
              error: 'Workflow version changed during deployment; refusing the legacy update.',
              expectedVersionId: current.versionId ?? null,
              currentVersionId: beforeLegacyUpdate.versionId ?? null,
            });
          }
          await api.updateWorkflow(workflow_id, configured.workflow, null);
          const saved = await api.getWorkflow(workflow_id);
          if (emailActionRoutingSignature(saved) !== emailActionRoutingSignature(configured.workflow)) {
            return jsonContent({
              error: 'Legacy n8n update did not persist the requested routing; refusing to publish.',
              workflowId: workflow_id,
              currentVersionId: saved.versionId ?? null,
              inspection: inspectEmailActionRoutingSafe(saved),
            });
          }
          if (publish_if_active === true && current.active === true) {
            await api.publishWorkflow(workflow_id, saved.versionId);
            publishMode = 'legacy-put-then-explicit-publish';
          } else {
            publishMode = 'legacy-put';
          }
        }
        const verified = await api.getWorkflow(workflow_id);
        const expectedSignature = emailActionRoutingSignature(configured.workflow);
        const actualSignature = emailActionRoutingSignature(verified);
        if (expectedSignature !== actualSignature) {
          return jsonContent({
            error: 'n8n returned success, but post-update readback did not match the requested routing.',
            workflowId: workflow_id,
            currentVersionId: verified.versionId ?? null,
            inspection: inspectEmailActionRoutingSafe(verified),
          });
        }
        return jsonContent({
          ok: true,
          dryRun: false,
          changed: 1,
          workflowId: verified.id ?? workflow_id,
          workflowName: verified.name,
          previousVersionId: current.versionId ?? null,
          currentVersionId: verified.versionId ?? null,
          active: verified.active ?? null,
          published: publish_if_active === true,
          publishMode,
          inspection: inspectEmailActionRouting(verified),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function inspectEmailActionRoutingSafe(workflow: Parameters<typeof inspectEmailActionRouting>[0]) {
  try {
    return inspectEmailActionRouting(workflow);
  } catch (error) {
    return { configured: false, error: error instanceof Error ? error.message : String(error) };
  }
}
