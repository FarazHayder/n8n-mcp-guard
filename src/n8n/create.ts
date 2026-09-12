import { workflowUpdatePayload, type N8nWorkflow } from './client.js';
import { cloneWorkflow } from './graph.js';

/**
 * Prepare an agent-authored definition for creation.
 *
 * A new workflow is always created inactive and without any inherited
 * identity. Turning it on stays a separate, deliberate act in n8n, so an
 * agent building something cannot accidentally put a live trigger into
 * production on the first save.
 */
export function prepareNewWorkflow(definition: N8nWorkflow): N8nWorkflow {
  const workflow = cloneWorkflow(workflowUpdatePayload(definition));
  delete workflow.id;
  delete workflow.versionId;
  delete workflow.active;
  delete workflow.staticData;
  delete workflow.pinData;
  workflow.settings = workflow.settings ?? {};
  if (!workflow.name?.trim()) throw new Error('A new workflow needs a name.');
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    throw new Error('A new workflow needs at least one node.');
  }
  return workflow;
}
