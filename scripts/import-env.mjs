#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : '';
if (!sourcePath) {
  throw new Error('Usage: node scripts/import-env.mjs <source-env-file>');
}

const names = [
  'N8N_BASE_URL',
  'N8N_API_KEY',
  'ENABLE_N8N_WORKFLOW_TOOLS',
  'ENABLE_N8N_WORKFLOW_WRITE_TOOLS',
  'MCP_WRITE_AUTH_TOKEN',
];
const source = await readFile(sourcePath, 'utf8');
const values = new Map();

for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (match && names.includes(match[1])) values.set(match[1], match[2]);
}

if (!values.get('N8N_BASE_URL') || !values.get('N8N_API_KEY')) {
  throw new Error('The source file must contain non-empty N8N_BASE_URL and N8N_API_KEY values.');
}
if (!values.has('ENABLE_N8N_WORKFLOW_TOOLS')) {
  values.set('ENABLE_N8N_WORKFLOW_TOOLS', 'true');
}
if (!values.has('ENABLE_N8N_WORKFLOW_WRITE_TOOLS')) {
  values.set('ENABLE_N8N_WORKFLOW_WRITE_TOOLS', 'false');
}
if (
  values.get('ENABLE_N8N_WORKFLOW_WRITE_TOOLS')?.trim().toLowerCase() === 'true' &&
  !values.get('MCP_WRITE_AUTH_TOKEN')
) {
  throw new Error('Write tools are enabled, but MCP_WRITE_AUTH_TOKEN is empty.');
}

const targetPath = fileURLToPath(new URL('../.env', import.meta.url));
const output = `${names.map((name) => `${name}=${values.get(name) ?? ''}`).join('\n')}\n`;
await writeFile(targetPath, output, { encoding: 'utf8', flag: 'wx' });
console.log(`Created private MCP environment file with ${names.length} scoped settings.`);
