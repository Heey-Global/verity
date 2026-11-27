import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPostgresAuditLog } from './audit-log.js';
import { createAuditRecorder } from './audit-recorder.js';
import type { ProjectEgressLifecycle } from './project-egress-lifecycle.js';
import type { DevcontainerBuildSpawner } from './provisioner.js';
import { createProvisioner, fakeDocker } from './provisioner.test-helper.js';

let ctx: TestDb;
const roots: string[] = [];
beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => {
  await truncateAll(ctx.db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(async () => ctx.close());

async function fixture(protectedBuild = false) {
  const root = mkdtempSync(join(tmpdir(), 'verity-provision-evidence-'));
  roots.push(root);
  const source = join(root, 'example-org-example-repo');
  const configDir = join(source, '.devcontainer');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'devcontainer.json'),
    JSON.stringify({
      build: { dockerfile: 'Dockerfile', context: '..' },
      postCreateCommand: 'echo evidence-setup',
    }),
  );
  writeFileSync(
    join(configDir, 'Dockerfile'),
    'ARG VERITY_SANDBOX_IMAGE\nFROM ${VERITY_SANDBOX_IMAGE}\n',
  );
  writeFileSync(join(source, 'input'), 'before');
  const id = randomUUID();
  await ctx.store.upsertProject({
    id,
    owner: 'example-org',
    repo: 'example-repo',
    containerName: 'dev-example-org-example-repo',
    state: 'active',
  });
  const docker = fakeDocker({
    inspectImageIdentity: async () => ({
      id: 'sha256:evidence-image',
      sizeBytes: 123,
      repoDigests: [],
    }),
  });
  const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
  const command = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const log = createPostgresAuditLog(ctx.db);
  const provisioner = createProvisioner({
    store: ctx.store,
    db: ctx.db,
    docker: docker.client,
    hostCloneRoot: root,
    defaultImageRef: 'base:current',
    devcontainerBuild: build,
    projectEgressEnabled: async () => protectedBuild,
    // Changed-input tests stop before touching the existing protected generation.
    ...(protectedBuild
      ? { protectedDevcontainerBuild: build, projectEgress: {} as ProjectEgressLifecycle }
      : {}),
    dockerHostForBuild: 'unix:///var/run/docker.sock',
    containerCommand: command,
    devcontainerFeature: { ref: '/opt/toolkit', version: '1', identity: 'sha256:toolkit' },
    audit: createAuditRecorder(log, {
      server: async () => ({ release: 'test', generation: null }),
    }),
  });
  return { id, source, build, docker, provisioner, command, log };
}

describe('provisioner build evidence', () => {
  it.each([false, true])(
    'preserves the active Sandbox when inputs change during the build (protected=%s)',
    async (protectedBuild) => {
      const f = await fixture(protectedBuild);
      f.build.mockImplementation(async () => {
        writeFileSync(join(f.source, 'input'), 'edited');
        return { stdout: '', stderr: '' };
      });
      await expect(f.provisioner.recreateContainer(f.id, { forceRebuild: true })).rejects.toThrow(
        'inputs changed before setup',
      );
      expect(f.build).toHaveBeenCalledOnce();
      expect(f.docker.calls.some((c) => c.method === 'stopContainer')).toBe(false);
      expect(f.command).not.toHaveBeenCalled();
      expect((await ctx.store.getProject(f.id))?.state).toBe('active');
    },
  );

  it('refuses setup when inputs change after the replacement container is created', async () => {
    const f = await fixture();
    const create = f.docker.client.createContainer.bind(f.docker.client);
    f.docker.client.createContainer = async (spec) => {
      const result = await create(spec);
      writeFileSync(join(f.source, 'input'), 'edited');
      return result;
    };
    await expect(f.provisioner.recreateContainer(f.id, { forceRebuild: true })).rejects.toThrow(
      'inputs changed before setup',
    );
    expect(f.command.mock.calls.some((c) => JSON.stringify(c).includes('evidence-setup'))).toBe(
      false,
    );
    expect((await ctx.store.getProject(f.id))?.state).toBe('failed');
  });

  it('allows unchanged dirty inputs, pins only the private configuration and correlates the image audit', async () => {
    const f = await fixture();
    f.build.mockImplementation(async ({ workspaceFolder }) => {
      expect(readFileSync(join(workspaceFolder, 'input'), 'utf8')).toBe('before');
      expect(
        readFileSync(join(workspaceFolder, '.devcontainer/devcontainer.json'), 'utf8'),
      ).toContain('base:current');
      return { stdout: '', stderr: '' };
    });
    const result = await f.provisioner.recreateContainer(f.id, { forceRebuild: true });
    expect(result.state).toBe('active');
    expect(f.command.mock.calls.some((c) => JSON.stringify(c).includes('evidence-setup'))).toBe(
      true,
    );
    expect(readFileSync(join(f.source, '.devcontainer/devcontainer.json'), 'utf8')).not.toContain(
      'base:current',
    );
    const operations = await f.log.listOperations({});
    expect(operations.operations).toHaveLength(1);
    const operationId = operations.operations[0]![0]!.operationId;
    const events = await f.log.operation(operationId);
    expect(events.map((e) => e.kind)).toEqual(['build.requested', 'build.succeeded']);
    expect(events[0]!.payload).toMatchObject({
      snapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(events[1]!.imageId).toBe('sha256:evidence-image');
  });
});
