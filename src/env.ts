import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Configuration precedence, highest priority first:
//   1. The real process environment, which is how an MCP client passes config
//      through the `env` block of its server definition.
//   2. N8N_MCP_ENV_FILE, an explicit path to a dotenv file.
//   3. A .env beside this package, which is how a cloned checkout is set up.
//   4. A user-level .env, so one global install can serve every repository.
// dotenv never overwrites a variable that is already set, so loading the
// candidates in this order lets the more specific source win.

/** Per-user directory for configuration and workflow backups. */
export function userConfigDir(): string {
  return process.env.APPDATA
    ? join(process.env.APPDATA, 'n8n-mcp-guard')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'n8n-mcp-guard');
}

function userConfigEnvFile(): string {
  return join(userConfigDir(), '.env');
}

const candidates = [
  process.env.N8N_MCP_ENV_FILE?.trim(),
  fileURLToPath(new URL('../.env', import.meta.url)),
  userConfigEnvFile(),
].filter((path): path is string => Boolean(path));

export const loadedEnvFiles: string[] = [];
for (const path of candidates) {
  if (!existsSync(path)) continue;
  dotenv.config({ path });
  loadedEnvFiles.push(path);
}

function value(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function flag(name: string, fallback: boolean): boolean {
  const raw = value(name).toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export const env = {
  n8nBaseUrl: value('N8N_BASE_URL'),
  n8nApiKey: value('N8N_API_KEY'),
  // Read-only inspection defaults on so a fresh install exposes a working
  // tool. Mutation stays strictly opt-in.
  enableN8nWorkflowTools: flag('ENABLE_N8N_WORKFLOW_TOOLS', true),
  // On by default. The real gate is MCP_WRITE_AUTH_TOKEN: without a token no
  // write can succeed, so setting one is the deliberate opt-in and this flag
  // exists to force writes off even when a token is present.
  enableN8nWorkflowWriteTools: flag('ENABLE_N8N_WORKFLOW_WRITE_TOOLS', true),
  // Reference implementations for one specific workflow topology. Off by
  // default: they fail closed on any other shape, so they are noise for
  // everyone but the instance they were written for.
  enableExampleTools: flag('ENABLE_EXAMPLE_TOOLS', false),
  mcpWriteAuthToken: value('MCP_WRITE_AUTH_TOKEN'),
  // Where workflow backups are written. Defaults under the user config
  // directory so the gate works identically from any repository.
  backupDir: value('N8N_MCP_BACKUP_DIR') || join(userConfigDir(), 'backups'),
};

/**
 * Whether the mutating tools should be registered at all.
 *
 * A write is impossible without a token, so registering write tools with no
 * token configured would only hand the agent tools that always fail. The
 * token is therefore both the credential and the opt-in.
 */
export function writeToolsAvailable(): boolean {
  return env.enableN8nWorkflowWriteTools && Boolean(env.mcpWriteAuthToken);
}

/** Problems that stop the server working at all. Never about write config. */
export function configErrors(): string[] {
  const errors: string[] = [];
  if (!env.n8nBaseUrl) errors.push('N8N_BASE_URL is not set.');
  if (!env.n8nApiKey) errors.push('N8N_API_KEY is not set.');
  return errors;
}

/** Non-fatal notes worth printing at startup. */
export function configNotes(): string[] {
  const notes: string[] = [];
  if (env.enableN8nWorkflowWriteTools && !env.mcpWriteAuthToken) {
    notes.push(
      'Write tools are not registered because MCP_WRITE_AUTH_TOKEN is empty. Set a long random value to enable them.',
    );
  }
  if (!env.enableN8nWorkflowWriteTools) {
    notes.push('Write tools are disabled by ENABLE_N8N_WORKFLOW_WRITE_TOOLS=false.');
  }
  return notes;
}
