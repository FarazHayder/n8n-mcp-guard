import type { N8nWorkflow } from './client.js';
import { workflowUpdatePayload } from './client.js';
import {
  cloneWorkflow,
  isDisabled,
  isManualTrigger,
  isSideEffectNode,
  isTriggerNode,
  removeNodes,
} from './graph.js';

/**
 * Every temporary clone this server creates is named with this prefix, and
 * the delete guard refuses to touch anything without it. That is the whole
 * reason cleanup can be automatic without risking a real workflow.
 */
export const TEST_CLONE_PREFIX = '[TEMP TEST]';

/** Any prefix this server has ever used, for the delete guard. */
const DELETABLE_PREFIX = '[TEMP TEST';

export interface TestCloneOptions {
  /** Node names to delete outright. */
  removeNodeNames?: string[];
  /** Side-effect node names to deliberately leave enabled. */
  allowNodeNames?: string[];
  /** Leave triggers enabled. Off by default and rarely correct. */
  keepTriggersEnabled?: boolean;
}

export interface CloneSafetyReport {
  safe: boolean;
  violations: string[];
  enabledTriggers: string[];
  enabledSideEffectNodes: string[];
  disabledNodes: string[];
  deliberatelyAllowed: string[];
}

export interface BuiltTestClone {
  definition: N8nWorkflow;
  safety: CloneSafetyReport;
  disabledTriggers: string[];
  disabledSideEffects: string[];
  removedNodes: string[];
}

/**
 * Build an inactive, side-effect-free copy of any workflow.
 *
 * Neutralization is by disabling rather than deleting, so the graph still
 * reads like the original when you inspect the clone in n8n.
 */
export function buildTestClone(
  source: N8nWorkflow,
  options: TestCloneOptions = {},
): BuiltTestClone {
  const allow = new Set(options.allowNodeNames ?? []);
  const workflow = cloneWorkflow(workflowUpdatePayload(source));

  workflow.name = `${TEST_CLONE_PREFIX} ${source.name} ${new Date().toISOString()}`;
  delete workflow.id;
  delete workflow.active;
  delete workflow.versionId;
  delete workflow.staticData;
  delete workflow.pinData;

  const removedNodes: string[] = [];
  if (options.removeNodeNames?.length) {
    const present = new Set(
      options.removeNodeNames.filter((name) => workflow.nodes.some((node) => node.name === name)),
    );
    const missing = options.removeNodeNames.filter((name) => !present.has(name));
    if (missing.length) {
      throw new Error(`Cannot remove nodes that do not exist: ${missing.join(', ')}`);
    }
    removeNodes(workflow, present);
    removedNodes.push(...present);
  }

  const disabledTriggers: string[] = [];
  const disabledSideEffects: string[] = [];

  for (const node of workflow.nodes) {
    if (!options.keepTriggersEnabled && isTriggerNode(node) && !isManualTrigger(node)) {
      if (!isDisabled(node)) {
        node.disabled = true;
        disabledTriggers.push(node.name);
      }
      continue;
    }
    if (isSideEffectNode(node) && !allow.has(node.name) && !isDisabled(node)) {
      node.disabled = true;
      disabledSideEffects.push(node.name);
    }
  }

  // Keep full execution data so a rehearsal can actually be inspected.
  workflow.settings = {
    ...workflow.settings,
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
  };

  const safety = inspectCloneSafety(workflow, options);
  if (!safety.safe) {
    throw new Error(`Refusing to build an unsafe test clone: ${safety.violations.join('; ')}`);
  }

  return { definition: workflow, safety, disabledTriggers, disabledSideEffects, removedNodes };
}

export function inspectCloneSafety(
  workflow: N8nWorkflow,
  options: TestCloneOptions = {},
): CloneSafetyReport {
  const allow = new Set(options.allowNodeNames ?? []);
  const violations: string[] = [];

  const enabledTriggers = workflow.nodes
    .filter((node) => isTriggerNode(node) && !isManualTrigger(node) && !isDisabled(node))
    .map((node) => node.name);

  const enabledSideEffectNodes = workflow.nodes
    .filter((node) => isSideEffectNode(node) && !isDisabled(node) && !allow.has(node.name))
    .map((node) => node.name);

  const deliberatelyAllowed = workflow.nodes
    .filter((node) => isSideEffectNode(node) && !isDisabled(node) && allow.has(node.name))
    .map((node) => node.name);

  if (!workflow.name.startsWith(DELETABLE_PREFIX)) {
    violations.push(`Clone name must start with "${DELETABLE_PREFIX}"`);
  }
  if (workflow.active === true) violations.push('Clone must not be active');
  if (!options.keepTriggersEnabled && enabledTriggers.length) {
    violations.push(`Production triggers still enabled: ${enabledTriggers.join(', ')}`);
  }
  if (enabledSideEffectNodes.length) {
    violations.push(`Outbound nodes still enabled: ${enabledSideEffectNodes.join(', ')}`);
  }

  return {
    safe: violations.length === 0,
    violations,
    enabledTriggers,
    enabledSideEffectNodes,
    disabledNodes: workflow.nodes.filter(isDisabled).map((node) => node.name),
    deliberatelyAllowed,
  };
}

/**
 * Refuse to delete anything that is not one of our temporary clones.
 * This is the guard that makes an automatic cleanup tool safe to expose.
 */
export function assertDeletableClone(workflow: N8nWorkflow): void {
  if (!workflow.name.startsWith(DELETABLE_PREFIX)) {
    throw new Error(
      `Refusing to delete "${workflow.name}": only workflows named "${DELETABLE_PREFIX}..." can be deleted by this tool.`,
    );
  }
}

export function isTestClone(workflow: { name?: string }): boolean {
  return typeof workflow.name === 'string' && workflow.name.startsWith(DELETABLE_PREFIX);
}
