#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const READ_ONLY_TOOLS = [
  'n8n_backup_workflow',
  'n8n_diff_workflow',
  'n8n_get_workflow',
  'n8n_list_test_clones',
  'n8n_plan_workflow_update',
];

const WRITE_TOOLS = [
  'n8n_apply_workflow_update',
  'n8n_create_test_clone',
  'n8n_delete_test_clone',
  'n8n_restore_workflow_backup',
];

const EXAMPLE_TOOLS = [
  'n8n_configure_supplier_email_action_routing',
  'n8n_test_supplier_email_action_routing',
];

async function toolsFor({ writeFlag, token, examples }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      N8N_BASE_URL: 'https://n8n.example.invalid',
      N8N_API_KEY: 'smoke-test-key',
      ENABLE_N8N_WORKFLOW_TOOLS: 'true',
      // An empty string is how we simulate "variable not set" here.
      ENABLE_N8N_WORKFLOW_WRITE_TOOLS: writeFlag ?? '',
      MCP_WRITE_AUTH_TOKEN: token ?? '',
      ENABLE_EXAMPLE_TOOLS: examples ? 'true' : 'false',
    },
  });
  const client = new Client({ name: 'n8n-mcp-guard-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

function assertSame(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify([...expected].sort());
  if (a !== b) throw new Error(`${label}\n  expected: ${b}\n  actual:   ${a}`);
}

// Write tools default on, but a write is impossible without a token, so with
// no token configured they must not be registered at all.
const noToken = await toolsFor({});
assertSame(noToken, READ_ONLY_TOOLS, 'Default config with no write token exposed the wrong tools');
const leaked = noToken.filter((name) => WRITE_TOOLS.includes(name));
if (leaked.length) throw new Error(`Write tools registered with no token: ${leaked.join(', ')}`);
console.log(`Default, no write token: ${noToken.length} read-only tools.`);

// An explicit false must win even when a token is present.
const forcedOff = await toolsFor({ writeFlag: 'false', token: 'smoke-test-write-token' });
assertSame(forcedOff, READ_ONLY_TOOLS, 'ENABLE_N8N_WORKFLOW_WRITE_TOOLS=false did not disable writes');
console.log(`Explicitly disabled despite a token: ${forcedOff.length} read-only tools.`);

// A token alone is the opt-in: write tools appear with no flag set.
const generic = await toolsFor({ token: 'smoke-test-write-token' });
assertSame(generic, [...READ_ONLY_TOOLS, ...WRITE_TOOLS], 'Token-only config exposed the wrong tools');
const exampleLeak = generic.filter((name) => EXAMPLE_TOOLS.includes(name));
if (exampleLeak.length) throw new Error(`Topology-specific tools leaked without opt-in: ${exampleLeak.join(', ')}`);
console.log(`Token set, no flag: ${generic.length} tools, writes enabled by default.`);

const everything = await toolsFor({ token: 'smoke-test-write-token', examples: true });
assertSame(everything, [...READ_ONLY_TOOLS, ...WRITE_TOOLS, ...EXAMPLE_TOOLS], 'Example mode exposed the wrong tools');
console.log(`Examples opted in: ${everything.length} tools.`);

console.log('MCP handshake passed; tool gating verified across all four modes.');
