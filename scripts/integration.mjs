#!/usr/bin/env node
// Live integration test of the write paths, driven through the real MCP tool
// surface rather than by importing the modules directly.
//
// It creates its own disposable synthetic workflow and deletes it again. It
// touches no pre-existing workflow, never activates anything, and never
// executes anything. Cleanup runs in a finally block and is verified.
//
// Requires N8N_BASE_URL, N8N_API_KEY and MCP_WRITE_AUTH_TOKEN in the
// environment. Skips cleanly when they are absent, so CI stays green without
// credentials.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { N8nApiError, N8nClient } from '../dist/n8n/client.js';

const BASE_URL = process.env.N8N_BASE_URL?.trim();
const API_KEY = process.env.N8N_API_KEY?.trim();
const WRITE_TOKEN = process.env.MCP_WRITE_AUTH_TOKEN?.trim();

if (!BASE_URL || !API_KEY || !WRITE_TOKEN) {
  console.log(
    'Skipping live integration test: set N8N_BASE_URL, N8N_API_KEY and MCP_WRITE_AUTH_TOKEN to run it.',
  );
  process.exit(0);
}

const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const BACKUPS = mkdtempSync(join(tmpdir(), 'n8n-mcp-guard-integration-'));
const NAME = `n8n-mcp-guard integration test ${new Date().toISOString().replace(/[:.]/g, '-')}`;

const pass = [];
const fail = [];
const ok = (label, cond, detail = '') => (cond ? pass : fail).push(label + (detail ? ` :: ${detail}` : ''));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    N8N_BASE_URL: BASE_URL,
    N8N_API_KEY: API_KEY,
    MCP_WRITE_AUTH_TOKEN: WRITE_TOKEN,
    N8N_MCP_BACKUP_DIR: BACKUPS,
    ENABLE_EXAMPLE_TOOLS: 'false',
    // Point the user-config lookup at a scratch dir so a developer's own
    // settings cannot change the outcome of this test.
    APPDATA: BACKUPS,
    XDG_CONFIG_HOME: BACKUPS,
  },
});
const mcp = new Client({ name: 'n8n-mcp-guard-integration', version: '1.0.0' });
const call = async (name, args) => JSON.parse((await mcp.callTool({ name, arguments: args })).content[0].text);

const api = new N8nClient(BASE_URL, API_KEY);
let workflowId = '';
let cloneId = '';

// Contains exactly the node kinds the clone builder must neutralize.
const definition = {
  name: NAME,
  nodes: [
    { id: 'n1', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'days' }] } } },
    { id: 'n2', name: 'Build', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: 'return [{ json: { v: 1 } }];' } },
    { id: 'n3', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [440, 0], parameters: { method: 'GET', url: 'https://example.invalid/never-called' } },
  ],
  connections: {
    Schedule: { main: [[{ node: 'Build', type: 'main', index: 0 }]] },
    Build: { main: [[{ node: 'Call API', type: 'main', index: 0 }]] },
  },
  settings: {},
};

try {
  await mcp.connect(transport);

  const created = await call('n8n_create_workflow', { definition, approved: true, write_token: WRITE_TOKEN });
  ok('create returns ok', created.ok === true, created.error ?? '');
  workflowId = created.workflowId ?? '';
  ok('create returned an id', Boolean(workflowId));
  ok('created inactive', created.active === false, `active=${created.active}`);
  ok('create readback matched what was sent', created.readbackMatches === true);
  ok('create wrote a backup', Boolean(created.backupPath));

  const badToken = await call('n8n_create_workflow', {
    definition: { ...definition, name: `${NAME} SHOULD NOT EXIST` },
    approved: true,
    write_token: 'wrong',
  });
  ok('an invalid write token is refused', typeof badToken.error === 'string' && /write_token/i.test(badToken.error));

  const edited = structuredClone(definition);
  edited.nodes[1].parameters.jsCode = 'return [{ json: { v: 2 } }];';
  const planned = await call('n8n_plan_workflow_update', { workflow_id: workflowId, definition: edited });
  ok('plan returns ok', planned.ok === true, planned.error ?? '');
  ok('plan diff sees exactly one modified node', planned.plan?.diff?.nodesModified === 1);
  ok('plan captured a backup of the live version', Boolean(planned.plan?.backup?.path));

  // A second plan against the same base, deliberately left stale by the apply.
  const stale = structuredClone(definition);
  stale.nodes[1].parameters.jsCode = 'return [{ json: { v: 99 } }];';
  const stalePlanId = (await call('n8n_plan_workflow_update', { workflow_id: workflowId, definition: stale })).plan?.planId;

  const applied = await call('n8n_apply_workflow_update', { plan_id: planned.plan.planId, approved: true, write_token: WRITE_TOKEN });
  ok('apply returns ok', applied.ok === true, applied.error ?? '');
  ok('apply verified the readback', applied.readbackVerified === true);
  ok('apply moved the version', applied.previousVersionId !== applied.currentVersionId);

  const staleApply = await call('n8n_apply_workflow_update', { plan_id: stalePlanId, approved: true, write_token: WRITE_TOKEN });
  ok('a stale plan is refused once the workflow moves',
    typeof staleApply.error === 'string' && /changed since planning/i.test(staleApply.error), staleApply.error ?? 'no error');

  const live = await call('n8n_get_workflow', { workflow_id: workflowId, include_definition: true });
  ok('the applied change is live in n8n',
    live.definition?.nodes?.find((n) => n.name === 'Build')?.parameters?.jsCode === 'return [{ json: { v: 2 } }];');

  const replay = await call('n8n_apply_workflow_update', { plan_id: planned.plan.planId, approved: true, write_token: WRITE_TOKEN });
  ok('a consumed plan cannot be replayed', typeof replay.error === 'string' && /expired|Unknown/i.test(replay.error));

  const clone = await call('n8n_create_test_clone', { workflow_id: workflowId, approved: true, write_token: WRITE_TOKEN });
  ok('clone created', clone.ok === true, clone.error ?? '');
  cloneId = clone.cloneWorkflowId ?? '';
  ok('clone is inactive', clone.active === false);
  ok('clone disabled the trigger', (clone.disabledTriggers ?? []).includes('Schedule'));
  ok('clone disabled the outbound HTTP node', (clone.disabledSideEffects ?? []).includes('Call API'));

  const cloneNodes = (await call('n8n_get_workflow', { workflow_id: cloneId, include_definition: true })).definition?.nodes ?? [];
  ok('n8n stored the trigger as disabled', cloneNodes.find((n) => n.name === 'Schedule')?.disabled === true);
  ok('n8n stored the HTTP node as disabled', cloneNodes.find((n) => n.name === 'Call API')?.disabled === true);

  const listed = await call('n8n_list_test_clones', {});
  ok('clone appears in the leftover-clone list', (listed.clones ?? []).some((c) => String(c.id) === cloneId));

  const guard = await call('n8n_delete_test_clone', { clone_workflow_id: workflowId, approved: true, write_token: WRITE_TOKEN });
  ok('the delete guard refuses a workflow that is not a clone',
    typeof guard.error === 'string' && /Refusing to delete/i.test(guard.error), guard.error ?? 'no error');

  const deleted = await call('n8n_delete_test_clone', { clone_workflow_id: cloneId, approved: true, write_token: WRITE_TOKEN });
  ok('clone deleted and verified gone', deleted.ok === true && deleted.verified === true, deleted.error ?? '');
  if (deleted.ok) cloneId = '';

  ok('backups landed on disk', readdirSync(BACKUPS).filter((f) => f.endsWith('.json')).length >= 1);
} catch (error) {
  fail.push(`threw: ${error?.message ?? String(error)}`);
} finally {
  for (const [id, what] of [[cloneId, 'clone'], [workflowId, 'test workflow']]) {
    if (!id) continue;
    try {
      await api.deleteWorkflow(id);
    } catch (error) {
      fail.push(`CLEANUP FAILED for ${what} ${id}: ${error.message}`);
    }
    try {
      await api.getWorkflow(id);
      fail.push(`CLEANUP UNVERIFIED: ${what} ${id} still exists`);
    } catch (error) {
      if (error instanceof N8nApiError && error.statusCode === 404) pass.push(`cleanup verified: ${what} removed`);
      else fail.push(`CLEANUP CHECK ERROR for ${what}: ${error.message}`);
    }
  }
  try {
    await mcp.close();
  } catch {
    // the server is being torn down anyway
  }
  rmSync(BACKUPS, { recursive: true, force: true });
}

for (const line of pass) console.log(`  PASS  ${line}`);
for (const line of fail) console.log(`  FAIL  ${line}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
