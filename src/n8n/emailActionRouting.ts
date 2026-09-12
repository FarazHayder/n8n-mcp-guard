import type { N8nNode, N8nWorkflow } from './client.js';

const MATCH_NODE_ID = '9051c59b-97dd-4d81-9185-6d910f627494';
const FIRST_ACTION_NODE_ID = '6182903a-dbcb-418e-9ae8-d0080478dd51';
const SECOND_ACTION_NODE_ID = '4bdc43c0-3bac-4742-8581-fb20800c9805';

const FIRST_ACTION_NAME = 'Is Auto-Send Disabled';
const SECOND_ACTION_NAME = 'Is Do-Nothing Action';

const EMAIL_ACTION_HELPER = `const normalizeEmailAction = (v) => {
  const action = (v ?? "").toString().trim().toLowerCase();
  if (action === "auto send") return "Auto Send";
  if (action === "draft only") return "Draft Only";
  return "Do Nothing";
};`;

const EMAIL_ACTION_FIELD = `        email_action: normalizeEmailAction(s["Email Action"]),`;

function cloneWorkflow(workflow: N8nWorkflow): N8nWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as N8nWorkflow;
}

function nodeById(workflow: N8nWorkflow, id: string): N8nNode {
  const node = workflow.nodes.find((item) => item.id === id);
  if (!node) throw new Error(`Required n8n node not found: ${id}`);
  return node;
}

function renameNode(workflow: N8nWorkflow, node: N8nNode, nextName: string): void {
  const previousName = node.name;
  if (previousName === nextName) return;
  node.name = nextName;

  if (Object.prototype.hasOwnProperty.call(workflow.connections, previousName)) {
    workflow.connections[nextName] = workflow.connections[previousName];
    delete workflow.connections[previousName];
  }

  for (const connection of Object.values(workflow.connections)) {
    if (!connection || typeof connection !== 'object') continue;
    const outputs = (connection as { main?: unknown }).main;
    if (!Array.isArray(outputs)) continue;
    for (const branch of outputs) {
      if (!Array.isArray(branch)) continue;
      for (const edge of branch) {
        if (edge && typeof edge === 'object' && (edge as { node?: unknown }).node === previousName) {
          (edge as { node: string }).node = nextName;
        }
      }
    }
  }
}

function setBooleanIfExpression(node: N8nNode, expression: string): void {
  const parameters = node.parameters as {
    conditions?: { conditions?: Array<{ leftValue?: string }> };
  };
  const condition = parameters.conditions?.conditions?.[0];
  if (!condition) throw new Error(`Node ${node.name} has no IF condition to update.`);
  condition.leftValue = expression;
}

function addEmailActionMapping(node: N8nNode): void {
  const code = node.parameters.jsCode;
  if (typeof code !== 'string') throw new Error(`Node ${node.name} has no jsCode.`);
  let next = code;

  if (!next.includes('const normalizeEmailAction =')) {
    const anchor = 'const supplierMap = new Map();';
    if (!next.includes(anchor)) throw new Error(`Could not find supplier-map anchor in ${node.name}.`);
    next = next.replace(anchor, `${EMAIL_ACTION_HELPER}\n\n${anchor}`);
  }

  if (!next.includes('email_action: normalizeEmailAction')) {
    const anchor = '        cc_email: cleanEmail(s["Secondary Email to CC"]),';
    if (!next.includes(anchor)) throw new Error(`Could not find supplier-field anchor in ${node.name}.`);
    next = next.replace(anchor, `${anchor}\n${EMAIL_ACTION_FIELD}`);
  }

  node.parameters.jsCode = next;
}

export interface EmailActionRoutingInspection {
  configured: boolean;
  matchNodeName: string;
  firstActionNodeName: string;
  secondActionNodeName: string;
  mapsEmailAction: boolean;
  autoSendExpression: string | null;
  doNothingExpression: string | null;
}

function firstIfExpression(node: N8nNode): string | null {
  const parameters = node.parameters as {
    conditions?: { conditions?: Array<{ leftValue?: unknown }> };
  };
  const value = parameters.conditions?.conditions?.[0]?.leftValue;
  return typeof value === 'string' ? value : null;
}

export function inspectEmailActionRouting(workflow: N8nWorkflow): EmailActionRoutingInspection {
  const match = nodeById(workflow, MATCH_NODE_ID);
  const first = nodeById(workflow, FIRST_ACTION_NODE_ID);
  const second = nodeById(workflow, SECOND_ACTION_NODE_ID);
  const autoSendExpression = firstIfExpression(first);
  const doNothingExpression = firstIfExpression(second);
  const mapsEmailAction =
    typeof match.parameters.jsCode === 'string' &&
    match.parameters.jsCode.includes('email_action: normalizeEmailAction(s["Email Action"])');
  const configured =
    mapsEmailAction &&
    first.name === FIRST_ACTION_NAME &&
    second.name === SECOND_ACTION_NAME &&
    autoSendExpression?.includes("email_action ?? 'Do Nothing') !== 'Auto Send'") === true &&
    doNothingExpression?.includes("email_action ?? 'Do Nothing') === 'Do Nothing'") === true;
  return {
    configured,
    matchNodeName: match.name,
    firstActionNodeName: first.name,
    secondActionNodeName: second.name,
    mapsEmailAction,
    autoSendExpression,
    doNothingExpression,
  };
}

/** Exact projection used for post-PUT readback verification. */
export function emailActionRoutingSignature(workflow: N8nWorkflow): string {
  const match = nodeById(workflow, MATCH_NODE_ID);
  const first = nodeById(workflow, FIRST_ACTION_NODE_ID);
  const second = nodeById(workflow, SECOND_ACTION_NODE_ID);
  return JSON.stringify({
    match: { name: match.name, parameters: match.parameters },
    first: { name: first.name, parameters: first.parameters },
    second: { name: second.name, parameters: second.parameters },
    firstConnections: workflow.connections[first.name] ?? null,
    secondConnections: workflow.connections[second.name] ?? null,
  });
}

/**
 * Replace the two hard-coded brand lists with the Supplier Details / Email Action
 * value while preserving the existing three branches and their Front endpoints.
 * Unknown or blank values fail closed to Do Nothing.
 */
export function configureEmailActionRouting(workflow: N8nWorkflow): {
  workflow: N8nWorkflow;
  changed: boolean;
  inspection: EmailActionRoutingInspection;
} {
  const next = cloneWorkflow(workflow);
  const before = JSON.stringify(next);
  const match = nodeById(next, MATCH_NODE_ID);
  const first = nodeById(next, FIRST_ACTION_NODE_ID);
  const second = nodeById(next, SECOND_ACTION_NODE_ID);

  addEmailActionMapping(match);
  renameNode(next, first, FIRST_ACTION_NAME);
  renameNode(next, second, SECOND_ACTION_NAME);
  setBooleanIfExpression(
    first,
    "={{ (($json.supplier?.email_action ?? 'Do Nothing') !== 'Auto Send') }}",
  );
  setBooleanIfExpression(
    second,
    "={{ (($json.supplier?.email_action ?? 'Do Nothing') === 'Do Nothing') }}",
  );

  const inspection = inspectEmailActionRouting(next);
  if (!inspection.configured) throw new Error('Email Action routing validation failed.');
  return { workflow: next, changed: JSON.stringify(next) !== before, inspection };
}
