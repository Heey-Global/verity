import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_GATEWAY_PEER_FINGERPRINT_LABEL,
  projectedAgentGatewayFingerprint,
  recordAgentGatewayProjection,
} from './agent-gateway-projection.js';
import { CONTAINER_GENERATION_LABEL, PROJECT_ID_LABEL } from './project-relay-migration.js';

const CREATED = 'a'.repeat(64);
const WOKEN = 'b'.repeat(64);

describe('projectedAgentGatewayFingerprint', () => {
  let secretRoot: string;
  const container = {
    id: 'container-1',
    labels: {
      [PROJECT_ID_LABEL]: 'project-1',
      [CONTAINER_GENERATION_LABEL]: 'generation-1',
      [AGENT_GATEWAY_PEER_FINGERPRINT_LABEL]: CREATED,
    },
  };
  const record = {
    projectId: 'project-1',
    containerId: 'container-1',
    containerGeneration: 'generation-1',
    fingerprint256: WOKEN,
  };

  beforeEach(() => {
    secretRoot = mkdtempSync(join(tmpdir(), 'verity-agent-gateway-projection-'));
  });
  afterEach(() => {
    rmSync(secretRoot, { recursive: true, force: true });
  });

  it('uses the creation-time label until a wake records a re-projection', () => {
    expect(projectedAgentGatewayFingerprint(secretRoot, 'project-1', container)).toBe(CREATED);
    recordAgentGatewayProjection(secretRoot, record);
    expect(projectedAgentGatewayFingerprint(secretRoot, 'project-1', container)).toBe(WOKEN);
  });

  it('keeps the record private to the Server', () => {
    recordAgentGatewayProjection(secretRoot, record);
    const directory = join(secretRoot, 'claude-egress');
    const [file, ...rest] = readdirSync(directory);
    expect(rest).toEqual([]);
    expect(statSync(join(directory, file!)).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('never lets a record vouch for a container created without an identity label', () => {
    // Such a container has no egress mounts, so nothing was ever projected into it.
    recordAgentGatewayProjection(secretRoot, record);
    const unlabelled = {
      ...container,
      labels: { ...container.labels, [AGENT_GATEWAY_PEER_FINGERPRINT_LABEL]: '' },
    };
    expect(projectedAgentGatewayFingerprint(secretRoot, 'project-1', unlabelled)).toBeUndefined();
  });

  it('ignores a record written for another project', () => {
    recordAgentGatewayProjection(secretRoot, { ...record, projectId: 'project-2' });
    expect(projectedAgentGatewayFingerprint(secretRoot, 'project-1', container)).toBe(CREATED);
  });

  it.each([
    ['not JSON', 'not json'],
    ['the wrong project', JSON.stringify({ ...record, projectId: 'project-2' })],
    ['a malformed fingerprint', JSON.stringify({ ...record, fingerprint256: 'B'.repeat(64) })],
    ['no container id', JSON.stringify({ ...record, containerId: '' })],
  ])('falls back to the label for a record with %s', (_name, contents) => {
    recordAgentGatewayProjection(secretRoot, record);
    // Overwrite whatever file the writer produced rather than restating its name.
    const directory = join(secretRoot, 'claude-egress');
    for (const file of readdirSync(directory)) writeFileSync(join(directory, file), contents);
    expect(projectedAgentGatewayFingerprint(secretRoot, 'project-1', container)).toBe(CREATED);
  });
});
