import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { N8nApiError, type N8nClient, type N8nWorkflow } from '../../src/n8n/client.js';
import { writeBackup } from '../../src/n8n/backup.js';
import {
  applyUpdatePlan,
  clearPlans,
  createUpdatePlan,
  getPlan,
} from '../../src/n8n/guardedUpdate.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'n8n-guard-update-'));
  clearPlans();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function workflow(overrides: Partial<N8nWorkflow> = {}): N8nWorkflow {
  return {
    id: 'wf-1',
    name: 'Order emails',
    versionId: 'v1',
    active: false,
    nodes: [
      { id: '1', name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: 'before' } },
    ],
    connections: {},
    settings: {},
    ...overrides,
  };
}

function proposed(): N8nWorkflow {
  return workflow({ nodes: [{ id: '1', name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: 'after' } }] });
}

/**
 * Fake n8n. `stored` is what a GET returns; `saveAs` lets a test simulate an
 * instance that persists something other than what it was sent.
 */
class FakeApi {
  updates = 0;
  publishes = 0;
  constructor(
    public stored: N8nWorkflow,
    private readonly saveAs?: (sent: N8nWorkflow) => N8nWorkflow,
    private readonly onUpdate?: () => void,
  ) {}

  async getWorkflow(): Promise<N8nWorkflow> {
    return JSON.parse(JSON.stringify(this.stored)) as N8nWorkflow;
  }

  async updateWorkflow(_id: string, next: N8nWorkflow): Promise<N8nWorkflow> {
    this.updates += 1;
    this.onUpdate?.();
    const saved = this.saveAs ? this.saveAs(next) : next;
    this.stored = { ...this.stored, ...saved, versionId: 'v2' };
    return this.stored;
  }

  async publishWorkflow(): Promise<N8nWorkflow> {
    this.publishes += 1;
    this.stored = { ...this.stored, active: true };
    return this.stored;
  }

  asClient(): N8nClient {
    return this as unknown as N8nClient;
  }
}

describe('createUpdatePlan', () => {
  it('backs up the live workflow as part of planning', async () => {
    const api = new FakeApi(workflow());
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    expect(plan.backup.workflowId).toBe('wf-1');
    expect(plan.backup.versionId).toBe('v1');
    expect(plan.diff.nodesModified).toBe(1);
  });

  it('refuses to plan a no-op change', async () => {
    const api = new FakeApi(workflow());
    await expect(createUpdatePlan(api.asClient(), 'wf-1', workflow(), dir)).rejects.toThrow(
      /identical to the live workflow/,
    );
  });
});

describe('applyUpdatePlan', () => {
  it('commits a clean plan and verifies the readback', async () => {
    const api = new FakeApi(workflow());
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    const result = await applyUpdatePlan(api.asClient(), plan.planId, false, dir);

    expect(result.ok).toBe(true);
    expect(result.readbackVerified).toBe(true);
    expect(result.previousVersionId).toBe('v1');
    expect(result.currentVersionId).toBe('v2');
    expect(api.updates).toBe(1);
  });

  it('aborts when the workflow version changed after planning', async () => {
    const api = new FakeApi(workflow());
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    api.stored = { ...api.stored, versionId: 'v-other' };

    await expect(applyUpdatePlan(api.asClient(), plan.planId, false, dir)).rejects.toThrow(
      /version changed since planning/,
    );
    expect(api.updates).toBe(0);
  });

  it('aborts when content changed but the version ID did not', async () => {
    const api = new FakeApi(workflow());
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    api.stored = {
      ...api.stored,
      nodes: [{ id: '1', name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: 'someone else' } }],
    };

    await expect(applyUpdatePlan(api.asClient(), plan.planId, false, dir)).rejects.toThrow(
      /content changed since planning/,
    );
    expect(api.updates).toBe(0);
  });

  it('aborts when the backup for that version has disappeared', async () => {
    const api = new FakeApi(workflow());
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    rmSync(plan.backup.path);

    await expect(applyUpdatePlan(api.asClient(), plan.planId, false, dir)).rejects.toThrow(
      /No valid backup found/,
    );
    expect(api.updates).toBe(0);
  });

  it('fails loudly when n8n stores something other than what was sent', async () => {
    const api = new FakeApi(workflow(), () =>
      workflow({ nodes: [{ id: '1', name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: 'WRONG' } }] }),
    );
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);

    await expect(applyUpdatePlan(api.asClient(), plan.planId, false, dir)).rejects.toThrow(
      /readback does not match/,
    );
  });

  it('rejects an unknown plan id', async () => {
    const api = new FakeApi(workflow());
    await expect(applyUpdatePlan(api.asClient(), 'nope', false, dir)).rejects.toThrow(
      /Unknown or expired plan/,
    );
  });

  it('consumes the plan so the same change cannot be applied twice', async () => {
    const api = new FakeApi(workflow());
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    await applyUpdatePlan(api.asClient(), plan.planId, false, dir);

    expect(getPlan(plan.planId)).toBeNull();
    await expect(applyUpdatePlan(api.asClient(), plan.planId, false, dir)).rejects.toThrow(
      /Unknown or expired plan/,
    );
    expect(api.updates).toBe(1);
  });

  it('leaves an active workflow unpublished unless publishing is requested', async () => {
    const api = new FakeApi(workflow({ active: true }));
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    const result = await applyUpdatePlan(api.asClient(), plan.planId, false, dir);
    expect(result.published).toBe(false);
    expect(api.publishes).toBe(0);
  });

  it('does not publish an inactive workflow even when asked to', async () => {
    const api = new FakeApi(workflow({ active: false }));
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    const result = await applyUpdatePlan(api.asClient(), plan.planId, true, dir);
    expect(result.published).toBe(false);
  });

  it('falls back to an explicit publish on older n8n versions', async () => {
    let first = true;
    const api = new FakeApi(workflow({ active: true }), undefined, () => {
      if (first) {
        first = false;
        throw new N8nApiError(400, "n8n API request failed: Unknown query parameter 'publishIfActive'");
      }
    });
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    const result = await applyUpdatePlan(api.asClient(), plan.planId, true, dir);

    expect(result.publishMode).toBe('legacy-put-then-explicit-publish');
    expect(api.publishes).toBe(1);
  });

  it('restores are just plans, so a stale backup cannot be written blind', async () => {
    const api = new FakeApi(workflow());
    const backup = writeBackup(workflow({ versionId: 'ancient' }), dir);
    expect(backup.versionId).toBe('ancient');
    // The gate matches on the *live* version, not the backup's own version.
    const plan = await createUpdatePlan(api.asClient(), 'wf-1', proposed(), dir);
    expect(plan.baseVersionId).toBe('v1');
  });
});
