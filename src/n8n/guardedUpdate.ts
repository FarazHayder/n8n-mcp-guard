import { randomUUID } from 'node:crypto';
import { N8nApiError, type N8nClient, type N8nWorkflow } from './client.js';
import { findBackup, writeBackup, type BackupEvidence } from './backup.js';
import { diffWorkflows, workflowSignature, type WorkflowDiff } from './graph.js';

/**
 * Production updates run as a two-phase commit.
 *
 * Phase 1 (plan) reads the live workflow, backs it up, and records the exact
 * state the change was designed against. Phase 2 (apply) re-reads the
 * workflow and refuses unless it is still bit-for-bit the state that was
 * planned against, then verifies the saved result by reading it back.
 *
 * The point is that "the workflow changed under us" and "n8n saved something
 * other than what we asked for" both become hard failures rather than silent
 * surprises.
 */

const PLAN_TTL_MS = 30 * 60 * 1000;

export interface UpdatePlan {
  planId: string;
  workflowId: string;
  workflowName: string;
  baseVersionId: string | null;
  baseSignature: string;
  targetSignature: string;
  baseActive: boolean | null;
  diff: WorkflowDiff;
  backup: BackupEvidence;
  createdAt: number;
  definition: N8nWorkflow;
}

export type PlanSummary = Omit<UpdatePlan, 'definition' | 'createdAt'> & {
  createdAt: string;
  expiresAt: string;
};

const plans = new Map<string, UpdatePlan>();

function prune(now = Date.now()): void {
  for (const [id, plan] of plans) {
    if (now - plan.createdAt > PLAN_TTL_MS) plans.delete(id);
  }
}

export function summarizePlan(plan: UpdatePlan): PlanSummary {
  const { definition: _definition, createdAt, ...rest } = plan;
  return {
    ...rest,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + PLAN_TTL_MS).toISOString(),
  };
}

export function getPlan(planId: string): UpdatePlan | null {
  prune();
  return plans.get(planId) ?? null;
}

/** Test seam: drop all stored plans. */
export function clearPlans(): void {
  plans.clear();
}

export async function createUpdatePlan(
  api: N8nClient,
  workflowId: string,
  next: N8nWorkflow,
  backupDir: string,
): Promise<UpdatePlan> {
  prune();
  const current = await api.getWorkflow(workflowId);
  const diff = diffWorkflows(current, next);
  if (!diff.changed) {
    throw new Error('The proposed definition is identical to the live workflow; nothing to plan.');
  }

  // Back up before a change is even planned, so the evidence exists no matter
  // what the caller does next.
  const existing = findBackup(workflowId, current.versionId ?? null, backupDir);
  const backup = existing ?? writeBackup(current, backupDir);

  const plan: UpdatePlan = {
    planId: randomUUID(),
    workflowId,
    workflowName: current.name,
    baseVersionId: current.versionId ?? null,
    baseSignature: workflowSignature(current),
    targetSignature: workflowSignature(next),
    baseActive: current.active ?? null,
    diff,
    backup,
    createdAt: Date.now(),
    definition: next,
  };
  plans.set(plan.planId, plan);
  return plan;
}

export interface ApplyResult {
  ok: true;
  workflowId: string;
  workflowName: string;
  previousVersionId: string | null;
  currentVersionId: string | null;
  active: boolean | null;
  published: boolean;
  publishMode: string;
  backupPath: string;
  diff: WorkflowDiff;
  readbackVerified: true;
}

export async function applyUpdatePlan(
  api: N8nClient,
  planId: string,
  publishIfActive: boolean,
  backupDir: string,
): Promise<ApplyResult> {
  const plan = getPlan(planId);
  if (!plan) {
    throw new Error(`Unknown or expired plan ${planId}. Create a new plan and review its diff.`);
  }

  // Gate 1: the live workflow must still be exactly what we planned against.
  const current = await api.getWorkflow(plan.workflowId);
  if ((current.versionId ?? null) !== plan.baseVersionId) {
    throw new Error(
      `Workflow version changed since planning (planned ${plan.baseVersionId ?? 'none'}, now ${current.versionId ?? 'none'}). Re-plan against the current state.`,
    );
  }
  if (workflowSignature(current) !== plan.baseSignature) {
    throw new Error(
      'Workflow content changed since planning even though its version ID did not. Re-plan against the current state.',
    );
  }

  // Gate 2: a verified backup for this exact version must still exist on disk.
  const backup = findBackup(plan.workflowId, plan.baseVersionId, backupDir);
  if (!backup) {
    throw new Error(
      `No valid backup found for workflow ${plan.workflowId} at version ${plan.baseVersionId ?? 'none'}. Refusing to write.`,
    );
  }

  const shouldPublish = publishIfActive && current.active === true;
  let publishMode = shouldPublish ? 'publishIfActive-query' : 'unpublished-draft';

  try {
    await api.updateWorkflow(plan.workflowId, plan.definition, shouldPublish);
  } catch (error) {
    const unsupportedPublishQuery =
      error instanceof N8nApiError &&
      error.statusCode === 400 &&
      error.message.includes("Unknown query parameter 'publishIfActive'");
    if (!unsupportedPublishQuery) throw error;

    // Some n8n versions reject the publishIfActive query parameter outright,
    // including when it is sent as false. Fall back to the plain PUT for every
    // such instance, not only when publishing was requested, then verify the
    // saved graph before deciding whether to publish it.
    await api.updateWorkflow(plan.workflowId, plan.definition, null);
    const saved = await api.getWorkflow(plan.workflowId);
    if (workflowSignature(saved) !== plan.targetSignature) {
      throw new Error('Legacy update did not persist the requested graph; refusing to continue.');
    }
    if (shouldPublish) {
      await api.publishWorkflow(plan.workflowId, saved.versionId);
      publishMode = 'legacy-put-then-explicit-publish';
    } else {
      publishMode = 'legacy-put';
    }
  }

  // Gate 3: read back and prove n8n stored what we asked for.
  const verified = await api.getWorkflow(plan.workflowId);
  if (workflowSignature(verified) !== plan.targetSignature) {
    throw new Error(
      `n8n reported success, but the readback does not match the planned result. Workflow ${plan.workflowId} is at version ${verified.versionId ?? 'unknown'}; restore from ${backup.path} if it is wrong.`,
    );
  }

  plans.delete(planId);
  return {
    ok: true,
    workflowId: plan.workflowId,
    workflowName: verified.name,
    previousVersionId: plan.baseVersionId,
    currentVersionId: verified.versionId ?? null,
    active: verified.active ?? null,
    published: shouldPublish,
    publishMode,
    backupPath: backup.path,
    diff: plan.diff,
    readbackVerified: true,
  };
}
