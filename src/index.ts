#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configErrors, configNotes, loadedEnvFiles, writeToolsAvailable } from './env.js';
import { registerN8nTools } from './tools/n8n.js';

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'n8n-mcp-guard',
    version: '1.2.2',
  });

  registerN8nTools(server);
  await server.connect(new StdioServerTransport());

  // stdout carries the MCP protocol, so all diagnostics go to stderr.
  const source = loadedEnvFiles.length ? loadedEnvFiles.join(', ') : 'process environment';
  console.error(`[n8n-mcp-guard] ready on stdio (config: ${source})`);
  console.error(
    `[n8n-mcp-guard] write tools ${writeToolsAvailable() ? 'ENABLED' : 'not registered'}`,
  );
  for (const problem of configErrors()) {
    console.error(`[n8n-mcp-guard] configuration warning: ${problem}`);
  }
  for (const note of configNotes()) {
    console.error(`[n8n-mcp-guard] note: ${note}`);
  }
}

main().catch((error) => {
  console.error('[n8n-mcp-guard] fatal:', error);
  process.exit(1);
});
