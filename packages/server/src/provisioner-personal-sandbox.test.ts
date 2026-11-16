import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';

import type { ContainerSpec } from './docker.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import type { ProjectRelaySandboxRef } from './project-relay-lifecycle.js';
import { createProvisioner, fakeDocker, fakeGit } from './provisioner.test-helper.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe("a person's own sandbox", () => {
  // ADR 0023 §4: a member's sandbox has its own relay. Asking whether "the project's"
  // relay is healthy answers for the original sandbox instead, so a second turn on a
  // member's running, healthy sandbox would rebuild it and kill their work in flight.
  it('keeps a running sandbox whose own relay is healthy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-keep-clone-'));
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-keep-secret-'));
    try {
      const id = randomUUID();
      await ctx.store.upsertProject({
        id,
        owner: 'example-org',
        repo: 'example-repo',
        containerName: 'dev-example-org-example-repo',
        state: 'absent',
      });
      await ctx.db
        .insertInto('users')
        .values({ id: 'lena', role: 'member', status: 'active' })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .execute();
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const created = new Map<string, ContainerSpec>();
      const { client: docker, calls } = fakeDocker({
        createContainer: vi.fn(async (spec: ContainerSpec) => {
          calls.push({ method: 'createContainer', payload: spec });
          created.set(spec.name, spec);
          return { id: spec.name, warnings: [] };
        }),
        inspectContainer: vi.fn(async (container: string) => ({
          id: container,
          running: true,
          labels: created.get(container)?.labels ?? {},
          networks: { 'verity-net': { ipAddress: '172.19.0.4' } },
        })),
      });
      const capabilities = createGhTokenCapabilityRegistry(ctx.db);
      const healthChecks: ProjectRelaySandboxRef[] = [];
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        defaultImageRef: 'default',
        hostCloneRoot: root,
        gitSecretRoot: secretRoot,
        dataVolumeRoot: root,
        claudeConnectorPort: 47_821,
        ghTokenCapabilities: capabilities,
        projectRelay: {
          async start(binding) {
            return {
              identity: {
                projectId: binding.projectId,
                userId: binding.userId,
                projectDefault: binding.projectDefault,
                containerGeneration: binding.containerGeneration,
              },
              signingCapability: 'test-signing-capability',
              githubCapability: await capabilities.issue({
                projectId: binding.projectId,
                userId: binding.userId,
                forgeConnectionId: null,
                owner: 'example-org',
                repo: 'example-repo',
                containerGeneration: binding.containerGeneration,
              }),
            };
          },
          async stop() {},
          // Only Lena's own relay is up; the original sandbox's is not asked about.
          isHealthy: async (binding) => {
            const sandbox = (binding as { sandbox?: ProjectRelaySandboxRef }).sandbox;
            if (sandbox !== undefined) healthChecks.push(sandbox);
            return sandbox?.userId === 'lena';
          },
          brokerUrl: () => 'http://relay:8080',
          claudeGatewayUrl: () => 'https://relay:8443',
        },
        projectTokenMint: async () => 'server-side-token',
        git,
        isDirectory: () => false,
      });
      await provisioner.provision(id);
      const first = await provisioner.ensurePersonalSandbox(id, 'lena');
      const before = calls.length;

      const second = await provisioner.ensurePersonalSandbox(id, 'lena');

      expect(second.containerName).toBe(first.containerName);
      const rebuilt = calls
        .slice(before)
        .filter((call) =>
          ['stopContainer', 'removeContainer', 'createContainer'].includes(call.method),
        );
      expect(rebuilt).toEqual([]);
      expect(healthChecks).toContainEqual(
        expect.objectContaining({ projectId: id, userId: 'lena', projectDefault: false }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });
});
