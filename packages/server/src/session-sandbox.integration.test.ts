import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { createDockerClient } from './docker.js';
import { dockerHostFor } from './project-backend.js';
import { sessionSandboxSpec } from './session-sandbox.js';

const run = promisify(execFile);
const image = process.env.VERITY_ISOLATION_TEST_IMAGE;
const fixtureRoot = process.env.VERITY_ISOLATION_TEST_ROOT;
const dockerUrl = process.env.VERITY_ISOLATION_DOCKER_URL ?? 'unix:///var/run/docker.sock';

// The fixture root must be the same path on the test process and Docker host.
// Explicit opt-in prevents a remote daemon from creating empty bind sources.
describe.skipIf(!image || !fixtureRoot)(
  'real Docker session isolation (requires VERITY_ISOLATION_TEST_IMAGE and VERITY_ISOLATION_TEST_ROOT)',
  () => {
    it('keeps two independent clones isolated while each can commit and install dependencies', async () => {
      const docker = createDockerClient({ baseUrl: dockerUrl });
      const env = { ...process.env, DOCKER_HOST: dockerHostFor(dockerUrl) };
      await run('docker', ['info'], { env, timeout: 10_000, maxBuffer: 1024 * 1024 });
      const root = await mkdtemp(join(fixtureRoot!, 'verity-isolation-'));
      const source = join(root, 'central');
      const created: string[] = [];
      const volumes: string[] = [];
      try {
        await mkdir(source);
        await run('git', ['init', source]);
        await writeFile(join(source, 'sentinel'), 'central');
        await run('git', ['-C', source, 'add', '.']);
        await run('git', [
          '-C',
          source,
          '-c',
          'user.name=Isolation Test',
          '-c',
          'user.email=isolation@example.invalid',
          'commit',
          '-m',
          'test: fixture',
        ]);
        const workspaces = [join(root, 'a'), join(root, 'b')];
        for (const workspace of workspaces)
          await run('git', ['clone', '--no-local', source, workspace]);
        const project = { id: randomUUID() } as ProjectRecord;
        for (const [index, workspace] of workspaces.entries()) {
          const spec = sessionSandboxSpec(
            {
              id: 'template',
              running: true,
              image: image!,
              privileged: false,
              deviceCount: 0,
              mounts: [],
              entrypoint: ['node'],
              command: ['-e', 'setInterval(()=>{},1000)'],
              capDrop: ['ALL'],
              securityOpt: ['no-new-privileges:true'],
            },
            { project, sessionId: randomUUID(), worktree: workspace },
          );
          spec.user = '0:0';
          for (const mount of spec.volumeMounts ?? []) {
            await docker.ensureVolume!(mount.volume);
            volumes.push(mount.volume);
          }
          const { id } = await docker.createContainer(spec);
          created.push(id);
          await docker.startContainer(id);
          const exec = (command: string[]) =>
            run('docker', ['exec', id, ...command], {
              env,
              timeout: 10_000,
              maxBuffer: 1024 * 1024,
            });
          await exec([
            '/usr/bin/git',
            '-C',
            '/work',
            'config',
            '--global',
            'safe.directory',
            '/work',
          ]);
          await exec(['/usr/bin/git', '-C', '/work', 'status', '--porcelain']);
          await exec([
            'node',
            '-e',
            `require('node:fs').writeFileSync('/work/own-${index}', 'private')`,
          ]);
          await exec(['/usr/bin/git', '-C', '/work', 'add', '.']);
          await exec([
            'git',
            '-C',
            '/work',
            '-c',
            'user.name=Isolation Test',
            '-c',
            'user.email=isolation@example.invalid',
            'commit',
            '-m',
            'test: private commit',
          ]);
          await exec(['/usr/bin/git', '-C', '/work', 'worktree', 'prune', '--expire', 'now']);
          await exec([
            'node',
            '-e',
            `const fs=require('node:fs'); for(const path of ${JSON.stringify([source, workspaces[1 - index], join(source, '.git')])}) {if(fs.existsSync(path))process.exit(1)}`,
          ]);
          await exec([
            'node',
            '-e',
            "const fs=require('node:fs'); fs.mkdirSync('/work/vendor'); fs.writeFileSync('/work/vendor/package.json',JSON.stringify({name:'private-fixture-dependency',version:'1.0.0'})); fs.writeFileSync('/work/vendor/index.js','module.exports=42'); fs.writeFileSync('/work/package.json', JSON.stringify({name:'isolation-fixture',version:'1.0.0',dependencies:{'private-fixture-dependency':'file:./vendor'}}))",
          ]);
          await exec(['npm', 'install', '--ignore-scripts', '--offline', '--package-lock-only']);
          await exec(['/usr/local/bin/verity-node-modules-install', '--wait']);
          await exec([
            'node',
            '-e',
            "if(require('/work/node_modules/private-fixture-dependency')!==42)process.exit(1)",
          ]);
          await docker.stopContainer(id);
          await docker.startContainer(id);
          await exec(['/usr/bin/git', '-C', '/work', 'status', '--porcelain']);
        }
        expect((await run('git', ['-C', source, 'log', '--format=%s'])).stdout.trim()).toBe(
          'test: fixture',
        );
        for (const workspace of workspaces)
          expect(
            (await run('git', ['-C', workspace, 'log', '-1', '--format=%s'])).stdout.trim(),
          ).toBe('test: private commit');
      } finally {
        for (const id of created) await docker.removeContainer(id);
        for (const volume of volumes) await docker.removeVolume!(volume);
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
