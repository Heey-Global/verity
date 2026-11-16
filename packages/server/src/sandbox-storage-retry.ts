import { randomUUID } from 'node:crypto';
import type { SandboxRepairIntent } from '@verity/store';
import {
  SANDBOX_REPAIR_RETRY_MIN_MS,
  SANDBOX_REPAIR_RETRY_MAX_MS,
} from './project-relay-migration.js';

/** A storage refusal happens before retirement; retain a bounded repair obligation. */
export function storageRefusedTurnRepair(input: {
  projectId: string;
  sourceGeneration: string | null;
  targetImageRef: string | null;
  failures: number;
  now: number;
  error: unknown;
}): SandboxRepairIntent {
  const retryAt =
    input.now +
    Math.min(
      SANDBOX_REPAIR_RETRY_MAX_MS,
      SANDBOX_REPAIR_RETRY_MIN_MS * 2 ** Math.min(input.failures - 1, 10),
    );
  return {
    projectId: input.projectId,
    version: 1,
    attemptId: randomUUID(),
    status: 'waiting',
    sourceGeneration: input.sourceGeneration,
    targetImageRef: input.targetImageRef,
    failures: input.failures,
    retryAt: new Date(retryAt),
    storageRefused: true,
    lastFailureAt: new Date(input.now),
    lastFailureMessage: String(input.error).slice(0, 500),
  };
}
