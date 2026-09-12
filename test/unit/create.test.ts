import { describe, expect, it } from 'vitest';
import type { N8nWorkflow } from '../../src/n8n/client.js';
import { prepareNewWorkflow } from '../../src/n8n/create.js';

function authored(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    name: 'My first automation',
    nodes: [
      { id: 'a', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
      { id: 'b', name: 'Transform', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items;' } },
    ],
    connections: { Schedule: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] } },
    settings: {},
    ...overrides,
  };
}

describe('prepareNewWorkflow', () => {
  it('never creates a workflow that is already live', () => {
    const prepared = prepareNewWorkflow(authored({ active: true }));
    expect(prepared.active).toBeUndefined();
  });

  it('drops identity copied from another workflow', () => {
    const prepared = prepareNewWorkflow(authored({ id: 'someone-elses-id', versionId: 'v7' }));
    expect(prepared.id).toBeUndefined();
    expect(prepared.versionId).toBeUndefined();
  });

  it('keeps the graph the author actually wrote', () => {
    const prepared = prepareNewWorkflow(authored());
    expect(prepared.name).toBe('My first automation');
    expect(prepared.nodes).toHaveLength(2);
    expect(prepared.connections.Schedule).toBeDefined();
  });

  it('does not carry over pinned or static data from a copied definition', () => {
    const prepared = prepareNewWorkflow(authored({ staticData: { x: 1 }, pinData: { Schedule: [] } }));
    expect(prepared.staticData).toBeUndefined();
    expect(prepared.pinData).toBeUndefined();
  });

  it('always has a settings object so n8n accepts the payload', () => {
    const prepared = prepareNewWorkflow(authored({ settings: undefined as unknown as Record<string, unknown> }));
    expect(prepared.settings).toEqual({});
  });

  it('rejects a workflow with no name', () => {
    expect(() => prepareNewWorkflow(authored({ name: '   ' }))).toThrow(/needs a name/);
  });

  it('rejects a workflow with no nodes', () => {
    expect(() => prepareNewWorkflow(authored({ nodes: [] }))).toThrow(/at least one node/);
  });

  it('does not mutate the caller definition', () => {
    const source = authored({ active: true });
    prepareNewWorkflow(source);
    expect(source.active).toBe(true);
    expect(source.nodes).toHaveLength(2);
  });
});
