import { describe, expect, it } from 'vitest';
import type { N8nWorkflow } from '../../src/n8n/client.js';
import {
  TEST_CLONE_PREFIX,
  assertDeletableClone,
  buildTestClone,
  inspectCloneSafety,
  isTestClone,
} from '../../src/n8n/testClone.js';

function production(): N8nWorkflow {
  return {
    id: 'prod-1',
    name: 'Order emails',
    versionId: 'v9',
    active: true,
    nodes: [
      { id: '1', name: 'Shopify Trigger', type: 'n8n-nodes-base.shopifyTrigger', parameters: {}, credentials: { shopifyApi: { id: '1', name: 'x' } } },
      { id: '2', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
      { id: '3', name: 'Send Email', type: 'n8n-nodes-base.emailSend', parameters: {} },
      { id: '4', name: 'Notify Slack', type: 'n8n-nodes-base.slack', parameters: {} },
      { id: '5', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.example' } },
      { id: '6', name: 'Transform', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items;' } },
      { id: '7', name: 'Read Sheet', type: 'n8n-nodes-base.googleSheets', parameters: {} },
    ],
    connections: {
      'Shopify Trigger': { main: [[{ node: 'Transform', type: 'main', index: 0 }]] },
      Transform: { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] },
    },
    settings: {},
  };
}

describe('buildTestClone', () => {
  it('disables every trigger and every outbound node by default', () => {
    const built = buildTestClone(production());
    const byName = new Map(built.definition.nodes.map((node) => [node.name, node]));

    expect(byName.get('Shopify Trigger')?.disabled).toBe(true);
    expect(byName.get('Schedule')?.disabled).toBe(true);
    expect(byName.get('Send Email')?.disabled).toBe(true);
    expect(byName.get('Notify Slack')?.disabled).toBe(true);
    expect(byName.get('Call API')?.disabled).toBe(true);

    // Nodes with no outside reach stay enabled so the clone still behaves.
    expect(byName.get('Transform')?.disabled).toBeUndefined();
    expect(byName.get('Read Sheet')?.disabled).toBeUndefined();

    expect(built.safety.safe).toBe(true);
  });

  it('never carries over identity or active state from production', () => {
    const built = buildTestClone(production());
    expect(built.definition.id).toBeUndefined();
    expect(built.definition.active).toBeUndefined();
    expect(built.definition.versionId).toBeUndefined();
  });

  it('names the clone with the deletable prefix', () => {
    const built = buildTestClone(production());
    expect(built.definition.name.startsWith(TEST_CLONE_PREFIX)).toBe(true);
    expect(built.definition.name).toContain('Order emails');
    expect(isTestClone(built.definition)).toBe(true);
  });

  it('leaves exactly the nodes the caller deliberately allowed', () => {
    const built = buildTestClone(production(), { allowNodeNames: ['Send Email'] });
    const byName = new Map(built.definition.nodes.map((node) => [node.name, node]));
    expect(byName.get('Send Email')?.disabled).toBeUndefined();
    expect(byName.get('Notify Slack')?.disabled).toBe(true);
    expect(built.safety.deliberatelyAllowed).toEqual(['Send Email']);
  });

  it('removes requested nodes and their edges', () => {
    const built = buildTestClone(production(), { removeNodeNames: ['Send Email'] });
    expect(built.definition.nodes.some((node) => node.name === 'Send Email')).toBe(false);
    const edges = (built.definition.connections.Transform as { main: Array<Array<unknown>> }).main[0]!;
    expect(edges).toHaveLength(0);
  });

  it('refuses to remove a node that does not exist rather than silently ignoring it', () => {
    expect(() => buildTestClone(production(), { removeNodeNames: ['Nope'] })).toThrow(/do not exist/);
  });

  it('keeps full execution data so a rehearsal can be inspected', () => {
    const built = buildTestClone(production());
    expect(built.definition.settings.saveDataSuccessExecution).toBe('all');
    expect(built.definition.settings.saveDataErrorExecution).toBe('all');
  });
});

describe('inspectCloneSafety', () => {
  it('flags an enabled production trigger', () => {
    const wf = production();
    wf.name = `${TEST_CLONE_PREFIX} x`;
    wf.active = false;
    const report = inspectCloneSafety(wf);
    expect(report.safe).toBe(false);
    expect(report.violations.join(' ')).toMatch(/triggers still enabled/i);
  });

  it('flags a clone that is active', () => {
    const built = buildTestClone(production());
    const saved = { ...built.definition, active: true };
    expect(inspectCloneSafety(saved).safe).toBe(false);
    expect(inspectCloneSafety(saved).violations.join(' ')).toMatch(/must not be active/i);
  });

  it('flags a clone missing the prefix', () => {
    const built = buildTestClone(production());
    const renamed = { ...built.definition, name: 'Order emails' };
    expect(inspectCloneSafety(renamed).violations.join(' ')).toMatch(/must start with/i);
  });
});

describe('assertDeletableClone', () => {
  it('refuses to delete a workflow without the temp-test prefix', () => {
    expect(() => assertDeletableClone(production())).toThrow(/Refusing to delete/);
  });

  it('allows deleting a clone this server created', () => {
    const built = buildTestClone(production());
    expect(() => assertDeletableClone(built.definition)).not.toThrow();
  });

  it('still allows the older prefix variant', () => {
    const wf = production();
    wf.name = '[TEMP TEST - NO FRONT] Order emails';
    expect(() => assertDeletableClone(wf)).not.toThrow();
  });

  it('is not fooled by the prefix appearing later in the name', () => {
    const wf = production();
    wf.name = 'Production [TEMP TEST] lookalike';
    expect(() => assertDeletableClone(wf)).toThrow(/Refusing to delete/);
  });
});
