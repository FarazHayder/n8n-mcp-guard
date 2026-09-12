import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { N8nWorkflow } from '../../src/n8n/client.js';
import { findBackup, readBackup, writeBackup } from '../../src/n8n/backup.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'n8n-guard-backup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function workflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: 'wf-1',
    name: 'Order emails',
    versionId: 'v1',
    active: true,
    nodes: [{ id: '1', name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: 'x' } }],
    connections: {},
    settings: {},
    ...overrides,
  };
}

describe('writeBackup', () => {
  it('writes a backup that reads back intact', () => {
    const evidence = writeBackup(workflow(), dir);
    expect(evidence.workflowId).toBe('wf-1');
    expect(evidence.versionId).toBe('v1');
    expect(evidence.active).toBe(true);
    expect(evidence.nodeCount).toBe(1);
    expect(readBackup(evidence.path)).toEqual(evidence);
  });

  it('stores the full definition, not just metadata', () => {
    const evidence = writeBackup(workflow(), dir);
    const parsed = JSON.parse(readFileSync(evidence.path, 'utf8'));
    expect(parsed.definition.nodes).toHaveLength(1);
    expect(parsed.definition.nodes[0].parameters.jsCode).toBe('x');
  });

  it('refuses to back up a workflow with no ID', () => {
    expect(() => writeBackup(workflow({ id: undefined }), dir)).toThrow(/no ID/);
  });

  it('produces a filesystem-safe name from an awkward workflow name', () => {
    const evidence = writeBackup(workflow({ name: 'A/B: "weird" \\ name *?' }), dir);
    expect(() => readFileSync(evidence.path, 'utf8')).not.toThrow();
  });
});

describe('readBackup', () => {
  it('rejects a tampered backup rather than trusting it', () => {
    const evidence = writeBackup(workflow(), dir);
    const parsed = JSON.parse(readFileSync(evidence.path, 'utf8'));
    parsed.definition.nodes[0].parameters.jsCode = 'malicious';
    writeFileSync(evidence.path, JSON.stringify(parsed), 'utf8');
    expect(readBackup(evidence.path)).toBeNull();
  });

  it('returns null for a file that is not a backup', () => {
    const path = join(dir, 'junk.json');
    writeFileSync(path, '{"hello":"world"}', 'utf8');
    expect(readBackup(path)).toBeNull();
  });

  it('returns null for unparseable content', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, 'not json at all', 'utf8');
    expect(readBackup(path)).toBeNull();
  });
});

describe('findBackup', () => {
  it('finds a backup for the exact workflow and version', () => {
    const evidence = writeBackup(workflow(), dir);
    expect(findBackup('wf-1', 'v1', dir)?.path).toBe(evidence.path);
  });

  it('does not match a different version, so a stale backup cannot satisfy the gate', () => {
    writeBackup(workflow({ versionId: 'v1' }), dir);
    expect(findBackup('wf-1', 'v2', dir)).toBeNull();
  });

  it('does not match a different workflow', () => {
    writeBackup(workflow(), dir);
    expect(findBackup('wf-2', 'v1', dir)).toBeNull();
  });

  it('ignores a tampered backup when satisfying the gate', () => {
    const evidence = writeBackup(workflow(), dir);
    const parsed = JSON.parse(readFileSync(evidence.path, 'utf8'));
    parsed.definition.nodes = [];
    writeFileSync(evidence.path, JSON.stringify(parsed), 'utf8');
    expect(findBackup('wf-1', 'v1', dir)).toBeNull();
  });

  it('returns null when the directory does not exist', () => {
    expect(findBackup('wf-1', 'v1', join(dir, 'nope'))).toBeNull();
  });
});
