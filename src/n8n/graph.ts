import { createHash } from 'node:crypto';
import type { N8nNode, N8nWorkflow } from './client.js';

/** Node types that start an execution. Anything ending in "trigger" counts. */
const EXTRA_TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.interval',
  'n8n-nodes-base.emailReadImap',
  'n8n-nodes-base.rssFeedRead',
]);

/**
 * Node types that reach the outside world. A test clone disables these by
 * default so a rehearsal cannot email, message, or POST anything real.
 * Matching is on the lowercased type, by substring, so vendor variants
 * (gmailTool, slackV2, ...) are covered without enumerating every one.
 */
const SIDE_EFFECT_TYPE_FRAGMENTS = [
  'httprequest',
  'webhook.response',
  'emailsend',
  'gmail',
  'microsoftoutlook',
  'sendgrid',
  'mailgun',
  'mailjet',
  'awsses',
  'slack',
  'telegram',
  'discord',
  'twilio',
  'whatsapp',
  'pushover',
  'pagerduty',
  'executecommand',
  'ssh',
  'ftp',
  'awslambda',
  'executeworkflow',
];

export function cloneWorkflow<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isTriggerNode(node: N8nNode): boolean {
  const type = node.type.toLowerCase();
  return type.endsWith('trigger') || EXTRA_TRIGGER_TYPES.has(node.type);
}

export function isManualTrigger(node: N8nNode): boolean {
  return node.type === 'n8n-nodes-base.manualTrigger';
}

export function isSideEffectNode(node: N8nNode): boolean {
  const type = node.type.toLowerCase();
  return SIDE_EFFECT_TYPE_FRAGMENTS.some((fragment) => type.includes(fragment));
}

export function isDisabled(node: N8nNode): boolean {
  return node.disabled === true;
}

/** Rewrite every reference to `previousName` in the connection graph. */
export function renameNodeReferences(
  workflow: N8nWorkflow,
  previousName: string,
  nextName: string,
): void {
  if (previousName === nextName) return;
  if (Object.prototype.hasOwnProperty.call(workflow.connections, previousName)) {
    workflow.connections[nextName] = workflow.connections[previousName];
    delete workflow.connections[previousName];
  }
  forEachEdge(workflow, (edge) => {
    if (edge.node === previousName) edge.node = nextName;
  });
}

/** Remove nodes and every edge that pointed at them. */
export function removeNodes(workflow: N8nWorkflow, names: Set<string>): void {
  workflow.nodes = workflow.nodes.filter((node) => !names.has(node.name));
  for (const name of names) delete workflow.connections[name];

  for (const connection of Object.values(workflow.connections)) {
    const outputs = outputBranches(connection);
    if (!outputs) continue;
    for (let index = 0; index < outputs.length; index += 1) {
      const branch = outputs[index];
      if (!Array.isArray(branch)) continue;
      outputs[index] = branch.filter(
        (edge) => !edge || typeof edge !== 'object' || !names.has(String(edge.node ?? '')),
      );
    }
  }
}

function outputBranches(
  connection: unknown,
): Array<Array<{ node?: unknown }>> | null {
  if (!connection || typeof connection !== 'object') return null;
  const main = (connection as { main?: unknown }).main;
  return Array.isArray(main) ? (main as Array<Array<{ node?: unknown }>>) : null;
}

function forEachEdge(workflow: N8nWorkflow, visit: (edge: { node: string }) => void): void {
  for (const connection of Object.values(workflow.connections)) {
    const outputs = outputBranches(connection);
    if (!outputs) continue;
    for (const branch of outputs) {
      if (!Array.isArray(branch)) continue;
      for (const edge of branch) {
        if (edge && typeof edge === 'object' && typeof edge.node === 'string') {
          visit(edge as { node: string });
        }
      }
    }
  }
}

/**
 * A stable fingerprint of the parts of a workflow that change behavior.
 *
 * Deliberately excludes node position, workflow id, versionId and active
 * state, so a cosmetic drag in the n8n editor does not read as a behavioral
 * change, while any parameter, type, credential binding or wiring change does.
 */
export function workflowSignature(workflow: N8nWorkflow): string {
  const nodes = [...workflow.nodes]
    .map((node) => ({
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion ?? null,
      disabled: node.disabled === true,
      parameters: node.parameters ?? {},
      credentials: node.credentials ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const connections = Object.keys(workflow.connections)
    .sort()
    .map((key) => [key, workflow.connections[key]] as const);

  return createHash('sha256')
    .update(stableStringify({ name: workflow.name, nodes, connections }))
    .digest('hex');
}

/** JSON.stringify with object keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export interface NodeChange {
  name: string;
  change: 'added' | 'removed' | 'modified';
  type: string;
  details?: string[];
}

export interface WorkflowDiff {
  changed: boolean;
  nameChanged: boolean;
  nodesAdded: number;
  nodesRemoved: number;
  nodesModified: number;
  connectionsChanged: boolean;
  nodes: NodeChange[];
}

/** A human- and machine-readable summary of what an update would do. */
export function diffWorkflows(before: N8nWorkflow, after: N8nWorkflow): WorkflowDiff {
  const beforeNodes = new Map(before.nodes.map((node) => [node.name, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.name, node]));
  const changes: NodeChange[] = [];

  for (const [name, node] of afterNodes) {
    if (!beforeNodes.has(name)) changes.push({ name, change: 'added', type: node.type });
  }
  for (const [name, node] of beforeNodes) {
    if (!afterNodes.has(name)) changes.push({ name, change: 'removed', type: node.type });
  }
  for (const [name, next] of afterNodes) {
    const previous = beforeNodes.get(name);
    if (!previous) continue;
    const details: string[] = [];
    if (previous.type !== next.type) details.push(`type: ${previous.type} -> ${next.type}`);
    if ((previous.typeVersion ?? null) !== (next.typeVersion ?? null)) {
      details.push(`typeVersion: ${previous.typeVersion ?? 'none'} -> ${next.typeVersion ?? 'none'}`);
    }
    if ((previous.disabled === true) !== (next.disabled === true)) {
      details.push(`disabled: ${previous.disabled === true} -> ${next.disabled === true}`);
    }
    if (stableStringify(previous.parameters ?? {}) !== stableStringify(next.parameters ?? {})) {
      details.push('parameters changed');
    }
    if (stableStringify(previous.credentials ?? null) !== stableStringify(next.credentials ?? null)) {
      details.push('credentials changed');
    }
    if (details.length) changes.push({ name, change: 'modified', type: next.type, details });
  }

  const connectionsChanged =
    stableStringify(before.connections) !== stableStringify(after.connections);

  changes.sort((a, b) => a.name.localeCompare(b.name));
  return {
    changed:
      changes.length > 0 || connectionsChanged || before.name !== after.name,
    nameChanged: before.name !== after.name,
    nodesAdded: changes.filter((item) => item.change === 'added').length,
    nodesRemoved: changes.filter((item) => item.change === 'removed').length,
    nodesModified: changes.filter((item) => item.change === 'modified').length,
    connectionsChanged,
    nodes: changes,
  };
}
