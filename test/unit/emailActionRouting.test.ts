import { describe, expect, it } from 'vitest';
import type { N8nWorkflow } from '../../src/n8n/client.js';
import {
  configureEmailActionRouting,
  inspectEmailActionRouting,
} from '../../src/n8n/emailActionRouting.js';
import {
  buildSafeEmailActionTestClone,
  inspectTestCloneSafety,
} from '../../src/n8n/emailActionTestClone.js';

function fixture(): N8nWorkflow {
  return {
    id: 'workflow-1',
    name: 'New Order Front Draft Email',
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: '9051c59b-97dd-4d81-9185-6d910f627494',
        name: 'Match Supplier by Vendor',
        type: 'n8n-nodes-base.code',
        parameters: {
          jsCode: [
            'const cleanEmail = (v) => String(v ?? "").trim();',
            '',
            'const supplierMap = new Map();',
            'return [{ json: { supplier: {',
            '        cc_email: cleanEmail(s["Secondary Email to CC"]),',
            '} } }];',
          ].join('\n'),
        },
      },
      {
        id: '6182903a-dbcb-418e-9ae8-d0080478dd51',
        name: 'Is Draft-Only Brand',
        type: 'n8n-nodes-base.if',
        parameters: { conditions: { conditions: [{ leftValue: 'hard-coded list 1' }] } },
      },
      {
        id: '4bdc43c0-3bac-4742-8581-fb20800c9805',
        name: 'Is Draft-Only Brand1',
        type: 'n8n-nodes-base.if',
        parameters: { conditions: { conditions: [{ leftValue: 'hard-coded list 2' }] } },
      },
      {
        id: 'group',
        name: 'Group Order Lines by Supplier',
        type: 'n8n-nodes-base.code',
        parameters: {},
      },
    ],
    connections: {
      'Group Order Lines by Supplier': {
        main: [[{ node: 'Is Draft-Only Brand', type: 'main', index: 0 }]],
      },
      'Is Draft-Only Brand': {
        main: [
          [{ node: 'Is Draft-Only Brand1', type: 'main', index: 0 }],
          [{ node: 'Send', type: 'main', index: 0 }],
        ],
      },
      'Is Draft-Only Brand1': {
        main: [[], [{ node: 'Draft', type: 'main', index: 0 }]],
      },
    },
  };
}

describe('configureEmailActionRouting', () => {
  it('replaces hard-coded brand lists while preserving the three existing branches', () => {
    const original = fixture();
    const result = configureEmailActionRouting(original);

    expect(result.changed).toBe(true);
    expect(result.inspection.configured).toBe(true);
    expect(original.nodes[1]!.name).toBe('Is Draft-Only Brand');

    const match = result.workflow.nodes.find((node) => node.id?.startsWith('9051'))!;
    expect(match.parameters.jsCode).toContain('normalizeEmailAction(s["Email Action"])');
    expect(match.parameters.jsCode).toContain('return "Do Nothing";');

    expect(result.workflow.connections['Group Order Lines by Supplier']).toEqual({
      main: [[{ node: 'Is Auto-Send Disabled', type: 'main', index: 0 }]],
    });
    expect(result.workflow.connections['Is Auto-Send Disabled']).toEqual({
      main: [
        [{ node: 'Is Do-Nothing Action', type: 'main', index: 0 }],
        [{ node: 'Send', type: 'main', index: 0 }],
      ],
    });
    expect(result.workflow.connections['Is Do-Nothing Action']).toEqual({
      main: [[], [{ node: 'Draft', type: 'main', index: 0 }]],
    });
  });

  it('is idempotent', () => {
    const first = configureEmailActionRouting(fixture()).workflow;
    const second = configureEmailActionRouting(first);
    expect(second.changed).toBe(false);
    expect(inspectEmailActionRouting(second.workflow).configured).toBe(true);
  });

  it('fails closed when the expected workflow nodes are missing', () => {
    const broken = fixture();
    broken.nodes = broken.nodes.filter((node) => !node.id?.startsWith('4bdc'));
    expect(() => configureEmailActionRouting(broken)).toThrow('Required n8n node not found');
  });
});

describe('buildSafeEmailActionTestClone', () => {
  it('removes every production trigger and Front write before producing a test definition', () => {
    const source = fixture();
    source.nodes.push(
      {
        id: 'trigger',
        name: 'Shopify Trigger',
        type: 'n8n-nodes-base.shopifyTrigger',
        parameters: { topic: 'orders/create' },
        credentials: { shopifyAccessTokenApi: { id: 'secret-ref' } },
      },
      {
        id: 'parse',
        name: 'Parse Shopify Order Line Items',
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'const order = $input.first().json || {};\nreturn [];' },
      },
      {
        id: 'sheet',
        name: 'Google Sheets - Get Supplier List',
        type: 'n8n-nodes-base.googleSheets',
        parameters: {},
        credentials: { googleSheetsOAuth2Api: { id: 'allowed-read-credential' } },
      },
      ...[
        'HTTP Request - Send (has CC)',
        'HTTP Request2 - Send (no CC)',
        'HTTP Request - Send (has CC)1',
        'HTTP Request2 - Send (no CC)1',
        'Post Internal Comment',
        'Tag Conversation',
      ].map((name, index) => ({
        id: `http-${index}`,
        name,
        type: 'n8n-nodes-base.httpRequest',
        parameters: { method: 'POST', url: 'https://api2.frontapp.com/example' },
        credentials: { httpHeaderAuth: { id: 'front-secret-ref' } },
      })),
    );
    source.connections['Shopify Trigger'] = {
      main: [[{ node: 'Parse Shopify Order Line Items', type: 'main', index: 0 }]],
    };
    source.connections.Send = {
      main: [[{ node: 'Post Internal Comment', type: 'main', index: 0 }]],
    };
    source.connections.Draft = {
      main: [[{ node: 'Post Internal Comment', type: 'main', index: 0 }]],
    };

    const testClone = buildSafeEmailActionTestClone(source, 'random-test-webhook');
    const safety = inspectTestCloneSafety(testClone);

    expect(safety).toEqual({
      safe: true,
      violations: [],
      httpRequestNodeCount: 0,
      shopifyTriggerCount: 0,
      frontReferenceCount: 0,
      allowedCredentialNodeCount: 1,
    });
    expect(testClone.nodes.find((node) => node.name.startsWith('TEST Webhook'))?.parameters).toMatchObject({
      path: 'random-test-webhook',
      responseMode: 'onReceived',
    });
    expect(testClone.nodes.some((node) => node.name === 'TEST Capture - Do Nothing')).toBe(true);
    expect(testClone.nodes.some((node) => node.name === 'Post Internal Comment')).toBe(false);
    expect(testClone.nodes.some((node) => node.name === 'Tag Conversation')).toBe(false);
  });
});
