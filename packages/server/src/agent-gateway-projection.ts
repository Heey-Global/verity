import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ContainerInspect } from './docker.js';
import { CONTAINER_GENERATION_LABEL, PROJECT_ID_LABEL } from './project-relay-migration.js';

/** Fingerprint of the Agent Gateway client certificate projected into a Sandbox
 *  when the container was created. Docker labels are immutable, so this stays the
 *  creation-time value for the life of the container. */
export const AGENT_GATEWAY_PEER_FINGERPRINT_LABEL = 'verity.agent-gateway.peer-fingerprint-sha256';

const PROJECTION_DIRECTORY = 'claude-egress';
const FINGERPRINT = /^[a-f0-9]{64}$/u;

/**
 * The Agent Gateway identity a retained Sandbox was given on wake.
 *
 * Sleep revokes the project's client certificate, so waking the same container
 * issues a new one and rewrites the mounted files in place. The container's
 * fingerprint label cannot follow, because Docker labels are immutable. This
 * record carries the re-projected fingerprint instead, scoped to the exact
 * container id and relay generation it was written into.
 */
export interface AgentGatewayProjectionRecord {
  projectId: string;
  containerId: string;
  containerGeneration: string;
  fingerprint256: string;
}

function projectionPath(secretRoot: string, projectId: string): string {
  return join(secretRoot, PROJECTION_DIRECTORY, `agent_gateway_projection.${projectId}.json`);
}

/** Persist a wake re-projection in the Server's private secret directory. The
 *  file is never mounted into a Sandbox, so only the Server can vouch for it. */
export function recordAgentGatewayProjection(
  secretRoot: string,
  record: AgentGatewayProjectionRecord,
): void {
  const directory = join(secretRoot, PROJECTION_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = projectionPath(secretRoot, record.projectId);
  const temporary = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readProjection(
  secretRoot: string,
  projectId: string,
): AgentGatewayProjectionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(projectionPath(secretRoot, projectId), 'utf8'));
  } catch {
    // Absent or unreadable: no wake re-projection to vouch for this container.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const { containerId, containerGeneration, fingerprint256 } = record;
  if (
    record.projectId !== projectId ||
    typeof containerId !== 'string' ||
    containerId === '' ||
    typeof containerGeneration !== 'string' ||
    containerGeneration === '' ||
    typeof fingerprint256 !== 'string' ||
    !FINGERPRINT.test(fingerprint256)
  ) {
    return undefined;
  }
  return { projectId, containerId, containerGeneration, fingerprint256 };
}

/**
 * The Agent Gateway client fingerprint this exact container currently holds.
 *
 * A wake re-projection wins only for the container id and relay generation it
 * was written for, and only over a container that was created with an identity
 * projection in the first place. Any other container — a recreated one, a
 * foreign one, one created without the egress mounts — falls back to its
 * creation-time label, so a stale record can never vouch for it. The result is
 * still only a claim: the caller must find it among the currently issued and
 * routed bindings before the Sandbox counts as ready.
 */
export function projectedAgentGatewayFingerprint(
  secretRoot: string | undefined,
  projectId: string,
  inspected: Pick<ContainerInspect, 'id' | 'labels'>,
): string | undefined {
  const labelled = inspected.labels?.[AGENT_GATEWAY_PEER_FINGERPRINT_LABEL];
  if (labelled === undefined || labelled === '') return undefined;
  if (secretRoot === undefined) return labelled;
  if (inspected.labels?.[PROJECT_ID_LABEL] !== projectId) return labelled;
  const generation = inspected.labels?.[CONTAINER_GENERATION_LABEL];
  if (generation === undefined || generation === '') return labelled;
  const projection = readProjection(secretRoot, projectId);
  if (
    projection === undefined ||
    projection.containerId !== inspected.id ||
    projection.containerGeneration !== generation
  ) {
    return labelled;
  }
  return projection.fingerprint256;
}
