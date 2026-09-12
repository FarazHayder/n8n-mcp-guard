import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { N8nWorkflow } from './client.js';
import { stableStringify } from './graph.js';

/**
 * Backups exist so a production write can be *proved* to be recoverable
 * before it happens. `findBackup` is the machine-checkable half of that:
 * the updater refuses to run without a backup recorded against the exact
 * workflow version being modified.
 */

export interface BackupEvidence {
  path: string;
  workflowId: string;
  workflowName: string;
  versionId: string | null;
  active: boolean | null;
  nodeCount: number;
  definitionSha256: string;
  createdAt: string;
}

interface BackupFile extends Omit<BackupEvidence, 'path'> {
  definition: N8nWorkflow;
}

function safeName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'workflow'
  );
}

export function definitionHash(workflow: N8nWorkflow): string {
  return createHash('sha256').update(stableStringify(workflow)).digest('hex');
}

export function writeBackup(workflow: N8nWorkflow, directory: string): BackupEvidence {
  const workflowId = String(workflow.id ?? '').trim();
  if (!workflowId) throw new Error('Cannot back up a workflow with no ID.');

  mkdirSync(directory, { recursive: true });

  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const path = join(directory, `${stamp}__${safeName(workflowId)}__${safeName(workflow.name)}.json`);

  const record: BackupFile = {
    workflowId,
    workflowName: workflow.name,
    versionId: workflow.versionId ?? null,
    active: workflow.active ?? null,
    nodeCount: workflow.nodes.length,
    definitionSha256: definitionHash(workflow),
    createdAt,
    definition: workflow,
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  // Read back rather than trusting the write: a backup that cannot be parsed
  // is not a backup, and this gate is only worth having if it is real.
  const verified = readBackup(path);
  if (!verified) throw new Error(`Backup at ${path} could not be read back.`);
  if (verified.definitionSha256 !== record.definitionSha256) {
    throw new Error(`Backup at ${path} did not round-trip intact.`);
  }
  return verified;
}

export function readBackup(path: string): BackupEvidence | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BackupFile>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.workflowId || !parsed.definition || !parsed.definitionSha256) return null;
    if (definitionHash(parsed.definition) !== parsed.definitionSha256) return null;
    return {
      path,
      workflowId: parsed.workflowId,
      workflowName: parsed.workflowName ?? parsed.definition.name,
      versionId: parsed.versionId ?? null,
      active: parsed.active ?? null,
      nodeCount: parsed.nodeCount ?? parsed.definition.nodes.length,
      definitionSha256: parsed.definitionSha256,
      createdAt: parsed.createdAt ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * The most recent valid backup for this workflow at this exact version.
 * A null result means the update gate must fail closed.
 */
export function findBackup(
  workflowId: string,
  versionId: string | null,
  directory: string,
): BackupEvidence | null {
  if (!existsSync(directory)) return null;
  let best: BackupEvidence | null = null;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.json')) continue;
    const evidence = readBackup(join(directory, entry));
    if (!evidence) continue;
    if (evidence.workflowId !== workflowId) continue;
    if (evidence.versionId !== versionId) continue;
    if (!best || evidence.createdAt > best.createdAt) best = evidence;
  }
  return best;
}
