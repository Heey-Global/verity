import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONTROL_PLANE_PROJECT_ID } from '../packages/server/src/control-plane-project.js';
import { projectKnowledgeDir } from '../packages/server/src/knowledge-folder.js';

const exec = promisify(execFile);

// Exercise the shipped initializer against real Knowledge code without requiring a prior build.
it('prepares only Control and Shared Knowledge with the existing layout and permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'control-knowledge-'));
  try {
    const dist = join(root, 'dist');
    const data = join(root, 'data');
    await mkdir(dist);
    await writeFile(join(dist, 'package.json'), '{"type":"module"}');
    for (const name of [
      'knowledge-folder',
      'control-plane-project',
      'sandbox-standard-mounts',
      'session-file-history',
      'knowledge-mutation-lock',
    ]) {
      const source = await readFile(`packages/server/src/${name}.ts`, 'utf8');
      await writeFile(
        join(dist, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
        }).outputText,
      );
    }
    const foreign = projectKnowledgeDir(data, 'other-project');
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, 'untouched'), 'private');
    const script = await readFile('deploy/bin/verity-control-plane-knowledge-init', 'utf8');
    const launcher = join(root, 'init.cjs');
    await writeFile(launcher, script.replaceAll('/app/packages/server/dist/', `${dist}/`));
    for (let pass = 0; pass < 2; pass++) await exec(process.execPath, [launcher, data]);
    const control = projectKnowledgeDir(data, CONTROL_PLANE_PROJECT_ID);
    expect(await readdir(join(data, 'knowledge'))).toEqual(
      ['other-project', 'shared', CONTROL_PLANE_PROJECT_ID].sort(),
    );
    for (const folder of ['sources/documents', 'sources/meetings', '.text', 'shared']) {
      expect((await stat(join(control, folder))).isDirectory()).toBe(true);
    }
    expect((await stat(join(control, 'insights'))).mode & 0o777).toBe(0o777);
    expect((await stat(join(control, 'sources'))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(foreign, 'untouched'), 'utf8')).toBe('private');
    expect(await readdir(foreign)).toEqual(['untouched']);
    expect((await stat(join(data, 'knowledge/shared/sources/documents'))).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('ships and invokes the Knowledge initializer before legacy volume subpaths are consumed', async () => {
  const dockerfile = await readFile('deploy/Dockerfile', 'utf8');
  expect(dockerfile).toContain(
    'COPY deploy/bin/verity-control-plane-knowledge-init /usr/local/bin/verity-control-plane-knowledge-init',
  );
  expect(dockerfile).toMatch(
    /chmod 0755 [^\n]*\/usr\/local\/bin\/verity-control-plane-knowledge-init/u,
  );
  const overlay = parse(await readFile('deploy/docker-compose.runner-supervisor.yml', 'utf8')) as {
    services: Record<
      string,
      { command?: string[]; depends_on?: Record<string, { condition: string }> }
    >;
  };
  expect(overlay.services['verity-control-runner-init']?.command?.join(' ')).toContain(
    'setpriv --reuid=1000 --regid=1000 --clear-groups /usr/local/bin/verity-control-plane-knowledge-init /data',
  );
  expect(
    overlay.services['verity-control-runner']?.depends_on?.['verity-control-runner-init']
      ?.condition,
  ).toBe('service_completed_successfully');
});

// YAML folding must not detach the initializer from the uid-changing command.
it('executes the folded initializer command through setpriv', async () => {
  const overlay = parse(await readFile('deploy/docker-compose.runner-supervisor.yml', 'utf8')) as {
    services: Record<string, { command: string[] }>;
  };
  const command = overlay.services['verity-control-runner-init']!.command[0]!;
  const start = command.indexOf('setpriv');
  const end = command.indexOf('&&', start);
  const initializer = command.slice(start, end);
  const result = await exec('/bin/sh', [
    '-c',
    `
    setpriv() {
      [ "$1" = --reuid=1000 ] && [ "$2" = --regid=1000 ] &&
      [ "$3" = --clear-groups ] &&
      [ "$4" = /usr/local/bin/verity-control-plane-knowledge-init ] &&
      [ "$5" = /data ] || return 1
      printf 'initializer-as-data-owner'
    }
    ${initializer}
  `,
  ]);
  expect(result.stdout).toBe('initializer-as-data-owner');
});
