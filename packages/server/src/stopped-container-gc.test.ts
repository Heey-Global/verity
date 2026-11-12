import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import type {
  ContainerInspect,
  DockerClient,
  DockerContainerSummary,
  DockerImageSummary,
} from './docker.js';
import {
  retireCompletedHostPreparationJobs,
  retireCompletedUpdateContainers,
  retireStoppedContainers,
} from './stopped-container-gc.js';

const now = Date.parse('2026-10-30T12:00:00Z');
const project = {
  id: 'p',
  containerName: 'verity-p',
  state: 'sleeping',
  imageOverrideRef: null,
} as ProjectRecord;
function fixture() {
  const sandbox: DockerContainerSummary = {
    id: 'sandbox',
    names: ['verity-p'],
    imageId: 'old',
    state: 'exited',
    created: 1,
    labels: { 'verity.project-id': 'p', 'verity.container-generation': 'g' },
  };
  const images = [
    {
      id: 'old',
      repoTags: ['ghcr.io/heey-global/verity/verity-sandbox:old'],
      repoDigests: [],
      created: 1,
      labels: {},
      size: 1,
    },
    {
      id: 'new',
      repoTags: ['ghcr.io/heey-global/verity/verity-sandbox:new'],
      repoDigests: [],
      created: 2,
      labels: {},
      size: 1,
    },
  ] as DockerImageSummary[];
  const containers = [sandbox];
  const docker = {
    listContainers: vi.fn(async () => containers),
    listImages: vi.fn(async () => images),
    inspectContainer: vi.fn(async (id: string): Promise<ContainerInspect> => ({
      id,
      running: false,
      status: 'exited',
      imageId: 'old',
      finishedAt: new Date(now - 2 * 86400000).toISOString(),
      exitCode: 0,
      labels: sandbox.labels,
    })),
    removeStoppedContainer: vi.fn(async () => {}),
    removeContainer: vi.fn(),
  };
  const input = {
    docker: docker as unknown as DockerClient,
    listProjects: async () => [project],
    withProjectMutation: vi.fn(async (_: string, run: () => Promise<void>) => run()),
    now,
  };
  return { docker, containers, sandbox, input };
}
describe('stopped container retirement', () => {
  it('does not renew sleeping grace when maintenance briefly restarts a sandbox', async () => {
    const f = fixture();
    f.docker.inspectContainer.mockResolvedValue({
      id: 'sandbox',
      running: false,
      status: 'exited',
      imageId: 'old',
      finishedAt: new Date(now).toISOString(),
      exitCode: 0,
    });
    const sleeping = { ...project, sleepingSince: new Date(now - 2 * 86400000) };
    expect(
      (await retireStoppedContainers({ ...f.input, listProjects: async () => [sleeping] })).removed,
    ).toEqual(['verity-p']);
    expect(
      (
        await retireStoppedContainers({
          ...f.input,
          listProjects: async () => [{ ...sleeping, sleepingSince: new Date(now) }],
        })
      ).removed,
    ).toEqual([]);
  });

  it('retires outdated stopped sandboxes under the lifecycle gate without force or volumes', async () => {
    const f = fixture();
    expect((await retireStoppedContainers(f.input)).removed).toEqual(['verity-p']);
    expect(f.input.withProjectMutation).toHaveBeenCalledOnce();
    expect(f.docker.removeStoppedContainer).toHaveBeenCalledWith('sandbox');
    expect(f.docker.removeContainer).not.toHaveBeenCalled();
  });
  it.each(['running', 'created', 'unknown'])(
    'protects a recently stopped or uncertain %s container',
    async (state) => {
      const f = fixture();
      f.sandbox.state = state;
      expect((await retireStoppedContainers(f.input)).removed).toEqual([]);
    },
  );
  it('rechecks lifecycle state after taking the mutation barrier', async () => {
    const f = fixture();
    f.input.withProjectMutation.mockImplementation(async (_, run) => {
      f.sandbox.state = 'running';
      await run();
    });
    await retireStoppedContainers(f.input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('protects current images, overrides, active projects and unreadable inventory', async () => {
    const f = fixture();
    f.docker.listImages.mockResolvedValue([]);
    await retireStoppedContainers(f.input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    await retireStoppedContainers({
      ...f.input,
      listProjects: async () => [{ ...project, state: 'active' }],
    });
    await expect(
      retireStoppedContainers({
        ...f.input,
        listProjects: async () => {
          throw new Error('DB offline');
        },
      }),
    ).rejects.toThrow('DB offline');
  });
  it('preserves unrelated containers and dry-run candidates', async () => {
    const f = fixture();
    await retireStoppedContainers({ ...f.input, dryRun: true });
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    f.sandbox.labels = {};
    await retireStoppedContainers(f.input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it.each([
    ['storage-maintenance', 'verity-query-12345678-1234-1234-1234-123456789abc'],
    ['runner-cache-maintenance', 'verity-cache-maintenance-12345678-1234-1234-1234-123456789abc'],
  ])(
    'reaps expired labelled %s containers after seven days even on active projects',
    async (component, name) => {
      const f = fixture();
      f.sandbox.names = [name];
      f.sandbox.labels = { 'verity.project-id': 'p', 'verity.component': component };
      f.docker.listImages.mockResolvedValue([]);
      const input = {
        ...f.input,
        listProjects: async () => [{ ...project, state: 'active' as const }],
      };
      await retireStoppedContainers(input);
      expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
      await retireStoppedContainers({ ...input, now: now + 7 * 86400000 });
      expect(f.docker.removeStoppedContainer).toHaveBeenCalledOnce();
    },
  );
  it('requires seven days and identity labels for an abandoned project', async () => {
    const f = fixture();
    const input = { ...f.input, listProjects: async () => [] };
    await retireStoppedContainers(input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    await retireStoppedContainers({ ...input, now: now + 7 * 86400000 });
    expect(f.docker.removeStoppedContainer).toHaveBeenCalledOnce();
  });
});
describe('completed update bootstrap jobs', () => {
  it.each(['verity-agent-seed', 'verity-managed-data-init'])(
    'retires a never-started %s only after explicit deployment completion',
    async (service) => {
      const f = fixture();
      f.sandbox.state = 'created';
      f.sandbox.labels = {
        'com.docker.compose.service': service,
        'com.docker.compose.project': 'deploy',
      };
      const inspect = await f.docker.inspectContainer('sandbox');
      f.docker.inspectContainer.mockResolvedValue({ ...inspect, status: 'created' });
      expect(await retireCompletedUpdateContainers(f.input.docker)).toEqual([]);
      expect(
        await retireCompletedUpdateContainers(f.input.docker, { composeProject: 'deploy' }),
      ).toEqual(['verity-p']);
      expect(f.docker.removeContainer).not.toHaveBeenCalled();
    },
  );
  it.each([{ labels: {} }, { imageId: 'changed' }, { running: true }, { status: 'running' }])(
    'retains bootstrap jobs whose fresh inspection changed: %j',
    async (changed) => {
      const f = fixture();
      f.sandbox.labels = {
        'com.docker.compose.service': 'verity-agent-seed',
        'com.docker.compose.project': 'deploy',
      };
      const inspect = await f.docker.inspectContainer('sandbox');
      f.docker.inspectContainer.mockResolvedValue({ ...inspect, ...changed });
      expect(
        await retireCompletedUpdateContainers(f.input.docker, { composeProject: 'deploy' }),
      ).toEqual([]);
      expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    },
  );
  it('removes successful old jobs only after a matching deployment server is running', async () => {
    const f = fixture();
    f.sandbox.labels = {
      'com.docker.compose.service': 'verity-agent-seed',
      'com.docker.compose.project': 'deploy',
    };
    await retireCompletedUpdateContainers(f.input.docker);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    f.containers.push({
      id: 'server',
      created: 2,
      imageId: 'new',
      state: 'running',
      labels: {
        'com.docker.compose.service': 'verity-server',
        'com.docker.compose.project': 'deploy',
      },
    });
    f.containers[1]!.created = 0;
    expect(await retireCompletedUpdateContainers(f.input.docker)).toEqual([]);
    f.containers[1]!.created = 2;
    expect(await retireCompletedUpdateContainers(f.input.docker)).toEqual(['verity-p']);
  });
  it('retains failures and unrelated deployment jobs', async () => {
    const f = fixture();
    f.sandbox.labels = {
      'com.docker.compose.service': 'verity-managed-data-init',
      'com.docker.compose.project': 'other',
    };
    await retireCompletedUpdateContainers(f.input.docker, { composeProject: 'deploy' });
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    f.docker.inspectContainer.mockResolvedValue({
      id: 'sandbox',
      imageId: 'old',
      running: false,
      status: 'exited',
      exitCode: 1,
      finishedAt: new Date(now).toISOString(),
    });
    await retireCompletedUpdateContainers(f.input.docker);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
});

describe('completed preparation job retirement', () => {
  const completed = { deploymentId: 'deployment', updateId: 'update', targetDigest: 'target' };
  function preparedJob(role = 'runtime-renewal', stage = 'install') {
    const f = fixture();
    f.sandbox.labels = {
      'verity.managed-deployment-id': completed.deploymentId,
      'verity.update-id': completed.updateId,
      'verity.target-digest': completed.targetDigest,
      'verity.managed-role': role,
      'verity.renewal-stage': stage,
    };
    return f;
  }
  it.each([
    ['runtime-renewal', 'verify'],
    ['runtime-renewal', 'install'],
    ['egress-provisioning', 'verify'],
    ['egress-provisioning', 'install'],
  ])('retires successful %s %s jobs only for the committed operation', async (role, stage) => {
    const f = preparedJob(role, stage);
    expect(await retireCompletedHostPreparationJobs(f.input.docker, completed)).toEqual([
      'verity-p',
    ]);
    expect(f.docker.removeStoppedContainer).toHaveBeenCalledWith('sandbox');
    expect(f.docker.removeContainer).not.toHaveBeenCalled();
  });
  it.each([
    ['other-role', 'install'],
    ['runtime-renewal', 'other-stage'],
  ])('retains helpers with unrelated role or stage: %s %s', async (role, stage) => {
    const f = preparedJob(role, stage);
    expect(await retireCompletedHostPreparationJobs(f.input.docker, completed)).toEqual([]);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it.each(['deploymentId', 'updateId', 'targetDigest'] as const)(
    'retains jobs from another %s',
    async (field) => {
      const f = preparedJob();
      expect(
        await retireCompletedHostPreparationJobs(f.input.docker, {
          ...completed,
          [field]: 'other',
        }),
      ).toEqual([]);
      expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: 'running', running: true },
    { status: 'created' },
    { exitCode: 1 },
    { imageId: 'different' },
    { labels: {} },
  ])('retains failed, unsettled, or changed jobs: %j', async (changed) => {
    const f = preparedJob();
    const inspect = await f.docker.inspectContainer('sandbox');
    f.docker.inspectContainer.mockResolvedValue({ ...inspect, ...changed });
    expect(await retireCompletedHostPreparationJobs(f.input.docker, completed)).toEqual([]);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it.each(['runtime-renewal', 'egress-provisioning'])(
    'retains running %s jobs without inspecting for removal',
    async (role) => {
      const f = preparedJob(role);
      f.sandbox.state = 'running';
      expect(await retireCompletedHostPreparationJobs(f.input.docker, completed)).toEqual([]);
      expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    },
  );
});

function cacheGcFixture() {
  const containers = new Map<string, DockerContainerSummary>();
  const inspections = new Map<string, ContainerInspect>();
  let held = false;
  const add = (id: string, age = 1000, state = 'exited') => {
    const labels = { 'verity.project-id': 'p', 'verity.component': 'runner-cache-maintenance' };
    const summary: DockerContainerSummary = {
      id,
      labels,
      state,
      imageId: 'image',
      created: (now - age) / 1000,
      names: [`verity-cache-maintenance-${id.padStart(8, '0')}-1234-1234-1234-123456789abc`],
    };
    const inspect: ContainerInspect = {
      id,
      labels: { ...labels },
      running: state === 'running',
      status: state,
      imageId: summary.imageId,
      finishedAt: new Date(now - age).toISOString(),
      exitCode: 1,
    };
    containers.set(id, summary);
    inspections.set(id, inspect);
    return { summary, inspect };
  };
  const docker = {
    listContainers: vi.fn(async () => structuredClone([...containers.values()])),
    listImages: vi.fn(async () => []),
    inspectContainer: vi.fn(async (id: string) => {
      expect(held).toBe(true);
      const value = inspections.get(id);
      if (!value) throw new Error('container missing');
      return structuredClone(value);
    }),
    removeStoppedContainer: vi.fn(async (id: string) => {
      expect(held).toBe(true);
      if (inspections.get(id)?.running) throw new Error('container running');
      containers.delete(id);
      inspections.delete(id);
    }),
    removeContainer: vi.fn(),
  };
  const withProjectMutation = vi.fn(async (id: string, run: () => Promise<void>) => {
    expect(id).toBe('p');
    held = true;
    try {
      await run();
    } finally {
      held = false;
    }
  });
  const listProjects = vi.fn(async () => [project]);
  const input = {
    docker: docker as unknown as DockerClient,
    listProjects,
    withProjectMutation,
    now,
  };
  return { add, containers, inspections, docker, input, withProjectMutation };
}

describe('scheduled cache-helper retention', () => {
  it('prunes duplicate failed helpers without launching another helper or waiting seven days', async () => {
    const f = cacheGcFixture();
    const older = f.add('a', 2000);
    const latest = f.add('b');
    const result = await retireStoppedContainers(f.input);
    expect(result.removed).toEqual(older.summary.names);
    expect(result.retained).toEqual([
      { name: latest.summary.names![0], reason: 'Latest cache helper evidence retained (7 days)' },
    ]);
    expect(result.errors).toEqual([]);
    expect([...f.containers.keys()]).toEqual(['b']);
    expect(f.withProjectMutation).toHaveBeenCalledOnce();
    expect(f.docker.removeStoppedContainer.mock.calls).toEqual([['a']]);
    expect(f.docker.removeContainer).not.toHaveBeenCalled();
  });
  it('limits capacity retirement to helpers and retains the latest evidence', async () => {
    const f = cacheGcFixture();
    const older = f.add('a', 2000);
    const latest = f.add('b');
    f.containers.set('sandbox', {
      id: 'sandbox',
      names: ['unrelated'],
      imageId: 'old',
      state: 'exited',
      labels: { 'verity.project-id': 'p' },
    });
    const result = await retireStoppedContainers({
      ...f.input,
      cacheHelpersOnly: true,
      maxHelperProjects: 1,
    });
    expect(result.removed).toEqual(older.summary.names);
    expect(f.containers.has('sandbox')).toBe(true);
    expect(f.containers.has(latest.summary.id)).toBe(true);
    expect(f.docker.inspectContainer).not.toHaveBeenCalledWith('sandbox');
  });

  it('bounds and rotates the helper project selection', async () => {
    const f = cacheGcFixture();
    f.add('a');
    const extra = f.add('b');
    extra.summary.labels = { ...extra.summary.labels, 'verity.project-id': 'q' };
    f.containers.set('b', extra.summary);
    const selected: string[] = [];
    const withProjectMutation = async (id: string) => {
      selected.push(id);
      throw new Error('locked');
    };
    await retireStoppedContainers({
      ...f.input,
      cacheHelpersOnly: true,
      maxHelperProjects: 1,
      withProjectMutation,
    });
    expect(selected).toEqual(['p']);
    await retireStoppedContainers({
      ...f.input,
      cacheHelpersOnly: true,
      maxHelperProjects: 1,
      helperProjectOffset: 1,
      withProjectMutation,
    });
    expect(selected).toEqual(['p', 'q']);
    expect(f.docker.inspectContainer).not.toHaveBeenCalled();
  });

  it('skips locked helper projects without inspecting or removing their containers', async () => {
    const f = cacheGcFixture();
    f.add('a', 2000);
    f.add('b');
    const result = await retireStoppedContainers({
      ...f.input,
      cacheHelpersOnly: true,
      maxHelperProjects: 1,
      withProjectMutation: async () => {
        throw new Error('lifecycle owned by build');
      },
    });
    expect(result.errors).toHaveLength(1);
    expect(
      result.retained.every(
        (item) =>
          item.reason === 'Project lifecycle or storage barrier unavailable; helpers retained',
      ),
    ).toBe(true);
    expect(result.retained).toHaveLength(2);
    expect(f.docker.inspectContainer).not.toHaveBeenCalled();
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });

  it('does not claim a removed helper was retained after partial cleanup failed', async () => {
    const f = cacheGcFixture();
    f.add('a', 2000);
    f.add('b');
    f.docker.removeStoppedContainer.mockImplementationOnce(async (id) => {
      f.containers.delete(id);
      throw new Error('secret-canary-in-engine-error');
    });
    const result = await retireStoppedContainers({ ...f.input, cacheHelpersOnly: true });
    expect(f.containers.has('a')).toBe(false);
    expect(result.retained).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('secret-canary');
  });

  it('reports an inventory-limit blocker even without per-helper inspection results', async () => {
    const f = cacheGcFixture();
    f.add('a');
    const list = f.docker.listContainers.getMockImplementation()!;
    f.docker.listContainers.mockImplementation(async () => [
      ...(await list()),
      ...Array.from({ length: 1000 }, (_, index) => ({
        id: `foreign-${index}`,
        imageId: 'foreign',
        state: 'running',
      })),
    ]);
    const result = await retireStoppedContainers(f.input);
    expect(result.errors).toEqual([
      'p: Cache helper retention inventory unavailable or too large; containers retained',
    ]);
    expect(result.removed).toEqual([]);
    expect(f.docker.inspectContainer).not.toHaveBeenCalled();
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('expires the latest retained helper at the existing seven-day boundary', async () => {
    const f = cacheGcFixture();
    const last = f.add('a', 7 * 86400000 - 1);
    expect((await retireStoppedContainers(f.input)).removed).toEqual([]);
    expect((await retireStoppedContainers({ ...f.input, now: now + 1 })).removed).toEqual(
      last.summary.names,
    );
    expect(f.containers.size).toBe(0);
  });
  it.each(['component', 'name', 'time', 'inspect identity'])(
    'never lets generic GC bypass blocked cache retention for ambiguous %s',
    async (field) => {
      const f = cacheGcFixture();
      const old = f.add('a', 8 * 86400000);
      f.add('b', 9 * 86400000);
      if (field === 'component') old.summary.labels!['verity.component'] = 'unknown';
      if (field === 'name') old.summary.names = ['unknown'];
      if (field === 'time') old.inspect.finishedAt = 'unknown';
      if (field === 'inspect identity') old.inspect.labels!['verity.project-id'] = 'other';
      const result = await retireStoppedContainers(f.input);
      expect(result.removed).toEqual([]);
      expect(result.retained).toHaveLength(2);
      expect(result.retained.every((item) => item.reason.includes('could not be verified'))).toBe(
        true,
      );
      expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    },
  );
  it('protects all evidence while another helper remains running', async () => {
    const f = cacheGcFixture();
    f.add('a', 8 * 86400000);
    f.add('b', 1000, 'running');
    const result = await retireStoppedContainers(f.input);
    expect(result.removed).toEqual([]);
    expect(result.retained).toHaveLength(2);
    expect(result.retained.every((item) => item.reason.includes('reports running'))).toBe(true);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('sanitizes cleanup errors and leaves evidence rather than falling through to generic GC', async () => {
    const f = cacheGcFixture();
    f.add('a', 8 * 86400000);
    f.add('b');
    f.docker.removeStoppedContainer.mockRejectedValueOnce(
      new Error('private registry token and path'),
    );
    const result = await retireStoppedContainers(f.input);
    expect(result.errors).toEqual([
      'p: Cache helper retention failed; unverified containers retained',
    ]);
    expect(result.removed).toEqual([]);
    expect(f.containers.size).toBe(2);
    expect(f.docker.removeStoppedContainer).toHaveBeenCalledOnce();
  });
  it('defers a project removed during lifecycle revalidation', async () => {
    const f = cacheGcFixture();
    f.add('a', 8 * 86400000);
    f.add('b');
    f.input.listProjects.mockResolvedValueOnce([project]).mockResolvedValueOnce([]);
    expect((await retireStoppedContainers(f.input)).removed).toEqual([]);
    expect(f.docker.inspectContainer).not.toHaveBeenCalled();
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('waits for the result-collection barrier before inspecting or deleting helper evidence', async () => {
    const f = cacheGcFixture();
    f.add('a', 2000);
    f.add('b');
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let entered!: () => void;
    const attempted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mutation = f.input.withProjectMutation;
    const sweep = retireStoppedContainers({
      ...f.input,
      withProjectMutation: async (id, run) => {
        entered();
        await gate;
        await mutation(id, run);
      },
    });
    await attempted;
    expect(f.docker.inspectContainer).not.toHaveBeenCalled();
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    unlock();
    expect((await sweep).removed).toHaveLength(1);
  });
  it('composes the production GC barriers in the same order as helper result collection', () => {
    const source = ts.createSourceFile(
      'embedded.ts',
      readFileSync(new URL('./embedded.ts', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'retireStoppedContainers'
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls).toHaveLength(1);
    const options = calls[0]!.arguments[0];
    expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
    if (!options || !ts.isObjectLiteralExpression(options)) throw new Error('GC options missing');
    const property = options.properties.find(
      (item) =>
        ts.isPropertyAssignment(item) && item.name.getText(source) === 'withProjectMutation',
    );
    if (
      !property ||
      !ts.isPropertyAssignment(property) ||
      !ts.isArrowFunction(property.initializer)
    )
      throw new Error('GC mutation callback missing');
    const outer = property.initializer.body;
    if (!ts.isCallExpression(outer)) throw new Error('GC lifecycle barrier missing');
    expect(outer.expression.getText(source)).toBe('provisioner.withProjectExclusiveMutation');
    const callback = outer.arguments[1];
    if (!callback || !ts.isArrowFunction(callback) || !ts.isCallExpression(callback.body))
      throw new Error('GC storage barrier missing');
    expect(callback.body.expression.getText(source)).toBe('withStorageProjectMutation');
    // The inverse order deadlocks against maintenance's lifecycle-then-storage path.
    expect(callback.body.arguments[0]?.getText(source)).toBe(
      property.initializer.parameters[0]?.name.getText(source),
    );
  });
});
