import { describe, expect, it } from 'vitest';
import type { N8nWorkflow } from '../../src/n8n/client.js';
import {
  diffWorkflows,
  isSideEffectNode,
  isTriggerNode,
  removeNodes,
  renameNodeReferences,
  stableStringify,
  workflowSignature,
} from '../../src/n8n/graph.js';

function workflow(): N8nWorkflow {
  return {
    id: 'wf1',
    name: 'Demo',
    versionId: 'v1',
    active: true,
    nodes: [
      { id: '1', name: 'Trigger', type: 'n8n-nodes-base.shopifyTrigger', parameters: {}, position: [0, 0] },
      { id: '2', name: 'Send', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://a.example' }, position: [100, 0] },
      { id: '3', name: 'Log', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items;' }, position: [200, 0] },
    ],
    connections: {
      Trigger: { main: [[{ node: 'Send', type: 'main', index: 0 }]] },
      Send: { main: [[{ node: 'Log', type: 'main', index: 0 }]] },
    },
    settings: {},
  };
}

describe('node classification', () => {
  it('detects triggers by suffix and by explicit type', () => {
    expect(isTriggerNode({ name: 'a', type: 'n8n-nodes-base.shopifyTrigger', parameters: {} })).toBe(true);
    expect(isTriggerNode({ name: 'b', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} })).toBe(true);
    expect(isTriggerNode({ name: 'c', type: 'n8n-nodes-base.webhook', parameters: {} })).toBe(true);
    expect(isTriggerNode({ name: 'd', type: 'n8n-nodes-base.code', parameters: {} })).toBe(false);
  });

  it('detects outbound side-effect nodes across vendors', () => {
    for (const type of [
      'n8n-nodes-base.httpRequest',
      'n8n-nodes-base.emailSend',
      'n8n-nodes-base.gmail',
      'n8n-nodes-base.slack',
      'n8n-nodes-base.telegram',
      'n8n-nodes-base.executeCommand',
    ]) {
      expect(isSideEffectNode({ name: 'n', type, parameters: {} }), type).toBe(true);
    }
    expect(isSideEffectNode({ name: 'n', type: 'n8n-nodes-base.code', parameters: {} })).toBe(false);
    expect(isSideEffectNode({ name: 'n', type: 'n8n-nodes-base.set', parameters: {} })).toBe(false);
  });
});

describe('workflowSignature', () => {
  it('ignores cosmetic changes that cannot alter behavior', () => {
    const before = workflow();
    const after = workflow();
    after.nodes[0]!.position = [999, 999];
    after.id = 'different';
    after.versionId = 'v2';
    after.active = false;
    expect(workflowSignature(after)).toBe(workflowSignature(before));
  });

  it('is stable regardless of node ordering', () => {
    const before = workflow();
    const after = workflow();
    after.nodes.reverse();
    expect(workflowSignature(after)).toBe(workflowSignature(before));
  });

  it('changes when a parameter changes', () => {
    const before = workflow();
    const after = workflow();
    after.nodes[1]!.parameters = { url: 'https://evil.example' };
    expect(workflowSignature(after)).not.toBe(workflowSignature(before));
  });

  it('changes when a node is disabled', () => {
    const before = workflow();
    const after = workflow();
    after.nodes[1]!.disabled = true;
    expect(workflowSignature(after)).not.toBe(workflowSignature(before));
  });

  it('changes when wiring changes', () => {
    const before = workflow();
    const after = workflow();
    after.connections.Trigger = { main: [[{ node: 'Log', type: 'main', index: 0 }]] };
    expect(workflowSignature(after)).not.toBe(workflowSignature(before));
  });
});

describe('stableStringify', () => {
  it('sorts keys at every depth so equal objects hash equally', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('diffWorkflows', () => {
  it('reports added, removed and modified nodes', () => {
    const before = workflow();
    const after = workflow();
    after.nodes[1]!.parameters = { url: 'https://b.example' };
    after.nodes.push({ id: '4', name: 'New', type: 'n8n-nodes-base.noOp', parameters: {} });
    after.nodes = after.nodes.filter((node) => node.name !== 'Log');

    const diff = diffWorkflows(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.nodesAdded).toBe(1);
    expect(diff.nodesRemoved).toBe(1);
    expect(diff.nodesModified).toBe(1);
    expect(diff.nodes.find((n) => n.name === 'Send')?.details).toContain('parameters changed');
  });

  it('reports no change for an identical workflow', () => {
    expect(diffWorkflows(workflow(), workflow()).changed).toBe(false);
  });

  it('notices connection-only changes', () => {
    const after = workflow();
    after.connections.Send = { main: [[]] };
    const diff = diffWorkflows(workflow(), after);
    expect(diff.changed).toBe(true);
    expect(diff.connectionsChanged).toBe(true);
  });
});

describe('graph surgery', () => {
  it('renames a node everywhere it is referenced', () => {
    const wf = workflow();
    renameNodeReferences(wf, 'Send', 'Renamed');
    expect(wf.connections.Renamed).toBeDefined();
    expect(wf.connections.Send).toBeUndefined();
    const edges = (wf.connections.Trigger as { main: Array<Array<{ node: string }>> }).main[0]!;
    expect(edges[0]!.node).toBe('Renamed');
  });

  it('removes a node and every edge pointing at it', () => {
    const wf = workflow();
    removeNodes(wf, new Set(['Send']));
    expect(wf.nodes.map((n) => n.name)).toEqual(['Trigger', 'Log']);
    expect(wf.connections.Send).toBeUndefined();
    const edges = (wf.connections.Trigger as { main: Array<Array<{ node: string }>> }).main[0]!;
    expect(edges).toHaveLength(0);
  });
});
