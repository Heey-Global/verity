import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { DockerProjectRuntime, type RuntimeRunner } from './project-runtime.js';

const project = { id: 'project-one', containerName: 'sandbox-person' } as ProjectRecord;
const input = {
  userId: 'user-one',
  generation: 'generation-one',
  action: 'create' as const,
  operationId: 'f58431a8-fcce-4d63-a401-3583c98a55d1',
};
const containerId = 'a'.repeat(64);
const reply = {
  ok: true,
  capacityLeaseVersion: 1,
  operationId: input.operationId,
  generation: input.generation,
  state: 'idle',
  path: `/run/verity-capacity-leases/${input.operationId}.lock`,
  identity: { device: '1', inode: '123' },
};
const inspect = (generation = input.generation, running = true, projectId = project.id) =>
  [containerId, running, projectId, generation].map((item) => JSON.stringify(item)).join('\n');

describe('immutable sandbox capacity lease bridge', () => {
  it('pins the authoritative project and generation before executing by immutable container id', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce({ stdout: inspect(), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(reply), stderr: '' });
    const runtime = new DockerProjectRuntime({ runner });
    expect(await runtime.capacityLease(project, input)).toEqual(reply);
    expect(runner.mock.calls[0]?.[1]).toEqual([
      'inspect',
      '--format',
      expect.any(String),
      project.containerName,
    ]);
    expect(runner.mock.calls[1]?.[1]).toEqual([
      'exec',
      '-i',
      '--user',
      '0',
      containerId,
      'node',
      '-e',
      expect.any(String),
    ]);
    expect(JSON.parse(runner.mock.calls[1]?.[2]?.stdin ?? '')).toEqual({
      protocolVersion: 1,
      kind: 'capacity-lease',
      action: 'create',
      generation: input.generation,
      operationId: input.operationId,
    });
  });

  it.each([
    inspect('replaced'),
    inspect(input.generation, false),
    inspect(input.generation, true, 'foreign'),
    '',
  ])('fails closed for unproven container evidence %s', async (stdout) => {
    const runner = vi.fn<RuntimeRunner>().mockResolvedValue({ stdout, stderr: '' });
    expect((await new DockerProjectRuntime({ runner }).capacityLease(project, input)).state).toBe(
      'unknown',
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...reply, generation: 'foreign' },
    { ...reply, identity: undefined },
    { ...reply, path: '/tmp/foreign.lock' },
    { ...reply, state: 'absent' },
  ])('refuses unbound broker responses', async (response) => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce({ stdout: inspect(), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(response), stderr: '' });
    expect((await new DockerProjectRuntime({ runner }).capacityLease(project, input)).state).toBe(
      'unknown',
    );
  });
});
