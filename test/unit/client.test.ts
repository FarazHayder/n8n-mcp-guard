import { describe, expect, it } from 'vitest';
import { workflowUpdatePayload, type N8nWorkflow } from '../../src/n8n/client.js';

const base = {
  name: 'W',
  nodes: [{ id: '1', name: 'A', type: 'n8n-nodes-base.code', parameters: {} }],
  connections: {},
} as unknown as N8nWorkflow;

describe('workflowUpdatePayload', () => {
  it('survives a definition with no settings at all', () => {
    expect(() => workflowUpdatePayload(base)).not.toThrow();
    expect(workflowUpdatePayload(base).settings).toEqual({});
  });

  it('keeps only the settings n8n accepts on write', () => {
    const wf = { ...base, settings: { timezone: 'UTC', bogusDerivedField: 1 } } as N8nWorkflow;
    const out = workflowUpdatePayload(wf);
    expect(out.settings).toEqual({ timezone: 'UTC' });
  });

  it('drops fields the public write schema rejects', () => {
    const wf = { ...base, settings: {}, id: 'x', versionId: 'v', active: true } as N8nWorkflow;
    const out = workflowUpdatePayload(wf);
    expect(out.id).toBeUndefined();
    expect(out.versionId).toBeUndefined();
    expect(out.active).toBeUndefined();
  });
});
