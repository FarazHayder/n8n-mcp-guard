import { randomUUID } from 'node:crypto';
import { configureEmailActionRouting } from './emailActionRouting.js';
import {
  N8nApiError,
  N8nClient,
  workflowUpdatePayload,
  type N8nExecution,
  type N8nNode,
  type N8nWorkflow,
} from './client.js';

export const TEST_CLONE_PREFIX = '[TEMP TEST - NO FRONT]';

const SHOPIFY_TRIGGER_NAME = 'Shopify Trigger';
const TEST_WEBHOOK_NAME = 'TEST Webhook (synthetic orders only)';
const DO_NOTHING_CAPTURE_NAME = 'TEST Capture - Do Nothing';
const REMOVED_FRONT_NODES = new Set(['Post Internal Comment', 'Tag Conversation']);

const CAPTURE_NODES = [
  { name: 'HTTP Request - Send (has CC)', action: 'Auto Send', hasCc: true },
  { name: 'HTTP Request2 - Send (no CC)', action: 'Auto Send', hasCc: false },
  { name: 'HTTP Request - Send (has CC)1', action: 'Draft Only', hasCc: true },
  { name: 'HTTP Request2 - Send (no CC)1', action: 'Draft Only', hasCc: false },
] as const;

export interface RoutingTestCase {
  vendor: string;
  expectedAction: string;
  expectedHasCc: boolean;
}

/**
 * Placeholder vendors. They only pass against an instance whose supplier
 * source actually contains them, so callers should pass their own.
 */
export const DEFAULT_TEST_CASES: RoutingTestCase[] = [
  { vendor: 'Example Supplier A', expectedAction: 'Auto Send', expectedHasCc: false },
  { vendor: 'Example Supplier B', expectedAction: 'Auto Send', expectedHasCc: true },
  { vendor: 'Example Supplier C', expectedAction: 'Draft Only', expectedHasCc: false },
  { vendor: 'Example Supplier D', expectedAction: 'Do Nothing', expectedHasCc: false },
];

export interface TestCaseResult {
  vendor: string;
  expectedAction: string;
  expectedHasCc: boolean;
  actualAction: string | null;
  actualHasCc: boolean | null;
  passed: boolean;
}

export interface SafeCloneTestResult {
  ok: true;
  productionWorkflowId: string;
  productionVersionId: string | null;
  cloneWorkflowId: string;
  cloneDeleted: true;
  safety: ReturnType<typeof inspectTestCloneSafety>;
  cases: TestCaseResult[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function renameNodeReferences(workflow: N8nWorkflow, previousName: string, nextName: string): void {
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

function removeNodes(workflow: N8nWorkflow, names: Set<string>): void {
  workflow.nodes = workflow.nodes.filter((node) => !names.has(node.name));
  for (const name of names) delete workflow.connections[name];

  for (const connection of Object.values(workflow.connections)) {
    if (!connection || typeof connection !== 'object') continue;
    const outputs = (connection as { main?: unknown }).main;
    if (!Array.isArray(outputs)) continue;
    for (let index = 0; index < outputs.length; index += 1) {
      const branch = outputs[index];
      if (!Array.isArray(branch)) continue;
      outputs[index] = branch.filter(
        (edge) =>
          !edge ||
          typeof edge !== 'object' ||
          !names.has(String((edge as { node?: unknown }).node ?? '')),
      );
    }
  }
}

function captureCode(action: string, hasCc: boolean): string {
  return `const j = $input.first().json ?? {};
return [{
  json: {
    testOnly: true,
    action: ${JSON.stringify(action)},
    hasCc: ${JSON.stringify(hasCc)},
    supplierName: j.supplier?.supplier_name ?? null,
    emailAction: j.supplier?.email_action ?? null,
    hasContactEmail: !!((j.supplier?.contact_email ?? "").trim()),
    orderName: j.order_name ?? null,
  },
}];`;
}

function replaceWithCaptureNode(node: N8nNode, action: string, hasCc: boolean): void {
  node.type = 'n8n-nodes-base.code';
  node.typeVersion = 2;
  node.parameters = { jsCode: captureCode(action, hasCc) };
  delete node.credentials;
  delete node.webhookId;
}

function buildDoNothingCapture(position: number[] | undefined): N8nNode {
  return {
    id: randomUUID(),
    name: DO_NOTHING_CAPTURE_NAME,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: position ? [position[0]! + 300, position[1]! - 180] : [1800, 200],
    parameters: { jsCode: captureCode('Do Nothing', false) },
  };
}

export function buildSafeEmailActionTestClone(
  source: N8nWorkflow,
  webhookPath: string,
): N8nWorkflow {
  const workflow = clone(workflowUpdatePayload(configureEmailActionRouting(source).workflow));
  workflow.name = `${TEST_CLONE_PREFIX} ${source.name} ${new Date().toISOString()}`;
  delete workflow.id;
  delete workflow.active;
  delete workflow.versionId;
  delete workflow.staticData;
  delete workflow.pinData;
  delete workflow.nodeGroups;
  delete workflow.description;

  const trigger = workflow.nodes.find(
    (node) => node.name === SHOPIFY_TRIGGER_NAME || node.type === 'n8n-nodes-base.shopifyTrigger',
  );
  if (!trigger) throw new Error('Could not find the Shopify trigger for the safe test clone.');
  renameNodeReferences(workflow, trigger.name, TEST_WEBHOOK_NAME);
  trigger.name = TEST_WEBHOOK_NAME;
  trigger.type = 'n8n-nodes-base.webhook';
  trigger.typeVersion = 2;
  trigger.parameters = {
    httpMethod: 'POST',
    path: webhookPath,
    responseMode: 'onReceived',
    options: {},
  };
  trigger.webhookId = randomUUID();
  delete trigger.credentials;

  const parseNode = workflow.nodes.find((node) => node.name === 'Parse Shopify Order Line Items');
  if (!parseNode || typeof parseNode.parameters.jsCode !== 'string') {
    throw new Error('Could not find the Shopify-order parser for the safe test clone.');
  }
  parseNode.parameters.jsCode = parseNode.parameters.jsCode.replace(
    'const order = $input.first().json || {};',
    'const incoming = $input.first().json || {};\nconst order = incoming.body ?? incoming;',
  );

  for (const capture of CAPTURE_NODES) {
    const node = workflow.nodes.find((item) => item.name === capture.name);
    if (!node) throw new Error(`Could not find outbound node ${capture.name}.`);
    replaceWithCaptureNode(node, capture.action, capture.hasCc);
    workflow.connections[node.name] = { main: [[]] };
  }

  removeNodes(workflow, REMOVED_FRONT_NODES);

  const doNothingIf = workflow.nodes.find((node) => node.name === 'Is Do-Nothing Action');
  if (!doNothingIf) throw new Error('Could not find the Do Nothing routing node.');
  const doNothingCapture = buildDoNothingCapture(doNothingIf.position);
  workflow.nodes.push(doNothingCapture);
  const doNothingOutputs = workflow.connections[doNothingIf.name] as
    | { main?: Array<Array<{ node: string; type: string; index: number }>> }
    | undefined;
  if (!doNothingOutputs?.main) throw new Error('Do Nothing routing connections are missing.');
  doNothingOutputs.main[0] = [{ node: doNothingCapture.name, type: 'main', index: 0 }];
  workflow.connections[doNothingCapture.name] = { main: [[]] };
  workflow.settings.saveDataSuccessExecution = 'all';
  workflow.settings.saveDataErrorExecution = 'all';

  const safety = inspectTestCloneSafety(workflow);
  if (!safety.safe) {
    throw new Error(`Refusing to create unsafe test clone: ${safety.violations.join('; ')}`);
  }
  return workflow;
}

export function inspectTestCloneSafety(workflow: N8nWorkflow): {
  safe: boolean;
  violations: string[];
  httpRequestNodeCount: number;
  shopifyTriggerCount: number;
  frontReferenceCount: number;
  allowedCredentialNodeCount: number;
} {
  const violations: string[] = [];
  const httpRequestNodeCount = workflow.nodes.filter(
    (node) => node.type === 'n8n-nodes-base.httpRequest',
  ).length;
  const shopifyTriggerCount = workflow.nodes.filter(
    (node) => node.type === 'n8n-nodes-base.shopifyTrigger',
  ).length;
  const frontReferenceCount = (JSON.stringify(workflow).match(/frontapp\.com/gi) ?? []).length;
  const frontReferenceNodes = workflow.nodes
    .filter((node) => /frontapp\.com/i.test(JSON.stringify(node)))
    .map((node) => node.name);
  let allowedCredentialNodeCount = 0;

  for (const node of workflow.nodes) {
    const credentials = node.credentials;
    if (!credentials || typeof credentials !== 'object') continue;
    const keys = Object.keys(credentials as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === 'googleSheetsOAuth2Api') {
      allowedCredentialNodeCount += 1;
      continue;
    }
    if (keys.length > 0) violations.push(`Unexpected credentials remain on ${node.name}`);
  }

  if (httpRequestNodeCount) violations.push('HTTP Request nodes remain');
  if (shopifyTriggerCount) violations.push('Shopify trigger remains');
  if (frontReferenceCount) {
    violations.push(`Front API references remain on: ${frontReferenceNodes.join(', ') || 'metadata'}`);
  }
  if (!workflow.nodes.some((node) => node.name === TEST_WEBHOOK_NAME)) {
    violations.push('Synthetic test webhook is missing');
  }

  return {
    safe: violations.length === 0,
    violations,
    httpRequestNodeCount,
    shopifyTriggerCount,
    frontReferenceCount,
    allowedCredentialNodeCount,
  };
}

function syntheticOrder(vendor: string): Record<string, unknown> {
  return {
    id: `test-${randomUUID()}`,
    order_number: 999999,
    name: '#SAFETY-TEST-NOT-A-REAL-ORDER',
    created_at: new Date().toISOString(),
    currency: 'USD',
    customer: {
      first_name: 'Safety',
      last_name: 'Test',
      email: 'nobody@example.invalid',
      phone: '',
    },
    shipping_address: {
      name: 'Safety Test',
      first_name: 'Safety',
      last_name: 'Test',
      address1: '1 Test Way',
      address2: '',
      city: 'Test City',
      province: 'CA',
      zip: '00000',
      country: 'US',
      phone: '',
    },
    billing_address: {},
    line_items: [
      {
        product_id: 1,
        variant_id: 1,
        name: 'Safety Test Product',
        sku: 'SAFETY-TEST-SKU',
        quantity: 1,
        price: '1.00',
        vendor,
      },
    ],
  };
}

function resultObject(value: unknown): Record<string, unknown> {
  const first = Array.isArray(value) ? value[0] : value;
  if (first && typeof first === 'object' && 'json' in first) {
    const json = (first as { json?: unknown }).json;
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  }
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : {};
}

async function invokeTestWebhook(
  instanceUrl: string,
  webhookPath: string,
  vendor: string,
): Promise<void> {
  const response = await fetch(`${instanceUrl}/webhook/${encodeURIComponent(webhookPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(syntheticOrder(vendor)),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw body for the diagnostic below.
  }
  if (!response.ok) {
    throw new Error(`Test webhook failed with HTTP ${response.status}: ${String(text).slice(0, 300)}`);
  }
  void body;
}

function executionCapture(execution: N8nExecution): Record<string, unknown> {
  const resultData = execution.data?.resultData;
  const runData =
    resultData && typeof resultData === 'object'
      ? (resultData as { runData?: unknown }).runData
      : null;
  if (!runData || typeof runData !== 'object') return {};
  const captureNames = [...CAPTURE_NODES.map((node) => node.name), DO_NOTHING_CAPTURE_NAME];
  for (const name of captureNames) {
    const runs = (runData as Record<string, unknown>)[name];
    if (!Array.isArray(runs) || runs.length === 0) continue;
    const latest = runs[runs.length - 1];
    if (!latest || typeof latest !== 'object') continue;
    const data = (latest as { data?: unknown }).data;
    if (!data || typeof data !== 'object') continue;
    const main = (data as { main?: unknown }).main;
    if (!Array.isArray(main) || !Array.isArray(main[0]) || !main[0][0]) continue;
    return resultObject(main[0][0]);
  }
  return {};
}

async function waitForNewExecution(
  api: N8nClient,
  workflowId: string,
  seenIds: Set<string>,
): Promise<N8nExecution> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const executions = await api.listExecutions(workflowId, true);
    const execution = executions.find((item) => !seenIds.has(String(item.id)));
    if (execution && execution.status !== 'running' && execution.status !== 'new') {
      seenIds.add(String(execution.id));
      if (execution.status !== 'success') {
        const resultData = execution.data?.resultData;
        const error =
          resultData && typeof resultData === 'object'
            ? (resultData as { error?: { message?: unknown } }).error?.message
            : null;
        throw new Error(
          `Safe clone execution ${execution.id} ended with ${execution.status}: ${String(error ?? 'unknown error')}`,
        );
      }
      return execution;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the safe clone execution record.');
}

export async function runSafeEmailActionCloneTest(
  api: N8nClient,
  production: N8nWorkflow,
  testCases?: RoutingTestCase[],
): Promise<SafeCloneTestResult> {
  const productionId = String(production.id ?? '');
  if (!productionId) throw new Error('Production workflow has no ID.');
  const productionVersionId = production.versionId ?? null;
  const webhookPath = `supplier-email-action-safety-test-${randomUUID()}`;
  const definition = buildSafeEmailActionTestClone(production, webhookPath);
  const localSafety = inspectTestCloneSafety(definition);
  let cloneId = '';
  let cloneActive = false;
  let cleanupError: Error | null = null;

  try {
    const created = await api.createWorkflow(definition);
    cloneId = String(created.id ?? '');
    if (!cloneId) throw new Error('n8n created the test clone without returning an ID.');
    cloneActive = created.active === true;
    if (cloneActive) throw new Error('Test clone was unexpectedly active immediately after creation.');

    const saved = await api.getWorkflow(cloneId);
    const savedSafety = inspectTestCloneSafety(saved);
    if (!savedSafety.safe) {
      throw new Error(`Saved test clone failed safety inspection: ${savedSafety.violations.join('; ')}`);
    }

    const published = await api.publishWorkflow(cloneId, saved.versionId);
    cloneActive = published.active === true;
    if (!cloneActive) throw new Error('Test clone did not become active for webhook testing.');

    // Vendor names must exist in the Supplier Details source with the
    // expected Email Action, so override these for your own instance.
    const cases = testCases ?? DEFAULT_TEST_CASES;
    const results: TestCaseResult[] = [];
    const seenExecutionIds = new Set<string>();
    for (const testCase of cases) {
      await invokeTestWebhook(api.instanceUrl, webhookPath, testCase.vendor);
      const execution = await waitForNewExecution(api, cloneId, seenExecutionIds);
      const actual = executionCapture(execution);
      const actualAction = typeof actual.action === 'string' ? actual.action : null;
      const actualHasCc = typeof actual.hasCc === 'boolean' ? actual.hasCc : null;
      results.push({
        ...testCase,
        actualAction,
        actualHasCc,
        passed:
          actual.testOnly === true &&
          actualAction === testCase.expectedAction &&
          actualHasCc === testCase.expectedHasCc &&
          actual.hasContactEmail === true,
      });
    }
    const failures = results.filter((result) => !result.passed);
    if (failures.length) {
      throw new Error(`Safe clone routing test failed for: ${failures.map((item) => item.vendor).join(', ')}`);
    }

    return {
      ok: true,
      productionWorkflowId: productionId,
      productionVersionId,
      cloneWorkflowId: cloneId,
      cloneDeleted: true,
      safety: localSafety,
      cases: results,
    };
  } finally {
    if (cloneId) {
      if (cloneActive) {
        try {
          await api.unpublishWorkflow(cloneId);
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error));
        }
      }
      try {
        await api.deleteWorkflow(cloneId);
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      }
      try {
        await api.getWorkflow(cloneId);
        cleanupError = new Error('Test clone still exists after the delete request.');
      } catch (error) {
        if (!(error instanceof N8nApiError) || error.statusCode !== 404) {
          cleanupError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    if (cleanupError) {
      throw new Error(
        `CRITICAL: test clone cleanup failed${cloneId ? ` (${cloneId})` : ''}: ${cleanupError.message}`,
      );
    }
  }
}
