import { existsSync } from 'node:fs';
import { agentLaunchSpec } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

let root: string;
let binary: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'verity-confinement-')));
  binary = join(root, 'sandbox');
  const compile = spawnSync(
    'cc',
    [
      '-Wall',
      '-Wextra',
      '-Werror',
      '-O2',
      resolve('features/verity-sandbox-toolkit/bin/verity-script-sandbox.c'),
      '-o',
      binary,
    ],
    { encoding: 'utf8' },
  );
  expect(compile.status, compile.stderr).toBe(0);
  for (const name of ['work', 'home', 'sibling', 'knowledge/insights'])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'sibling/private'), 'foreign');
  await writeFile(join(root, 'knowledge/source'), 'reference');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(extra: string[], script: string, forceMount = false, planning = false) {
  return spawnSync(
    binary,
    [
      '--root',
      join(root, 'work'),
      '--cwd',
      join(root, 'work'),
      '--loading',
      'dynamic',
      '--dynamic-root',
      join(root, 'home'),
      planning ? '--read-only-root' : '--write-isolated',
      ...extra,
      '--',
      '/bin/sh',
      '-c',
      script,
    ],
    {
      env: { ...process.env, VERITY_SCRIPT_SANDBOX_FORCE_MOUNT_NAMESPACE: forceMount ? '1' : '0' },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
}

for (const forceMount of [false, true]) {
  it(`confines native processes and descendants (forced mounts: ${String(forceMount)})`, (context) => {
    const probe = run([], 'exit 0', forceMount);
    if (probe.status !== 0) {
      // Unsupported kernels/container policies are environmental limitations, not passing isolation tests.
      expect(probe.stderr).toMatch(
        /verity-script-sandbox: (unshare user namespace|unshare mount namespace|\/proc\/self\/(?:uid_map|gid_map)|disable setgroups|landlock_create_ruleset|landlock_restrict_self|Wiki isolation requires Landlock ABI 3).*?(Operation not permitted|Function not implemented|Operation not supported)/s,
      );
      console.warn(
        `Confinement unavailable (${forceMount ? 'mount namespaces' : 'Landlock/default'}): ${probe.stderr.trim()}`,
      );
      context.skip();
      return;
    }
    const script = `set -eu
printf own > '${root}/home/state'
printf changed > '${root}/work/result'
test "$(cat '${root}/knowledge/source')" = reference
ls '${root}/knowledge' >/dev/null
printf insight > '${root}/knowledge/insights/note'
if cat '${root}/sibling/private' 2>/dev/null; then exit 21; fi
if /bin/sh -c "cat '${root}/sibling/private'" 2>/dev/null; then exit 22; fi
if printf bad > '${root}/knowledge/source' 2>/dev/null; then exit 23; fi
if printf bad > '${root}/sibling/new' 2>/dev/null; then exit 24; fi
`;
    const result = run(
      ['--read-root', join(root, 'knowledge'), '--write-root', join(root, 'knowledge/insights')],
      script,
      forceMount,
    );
    expect(result.status, result.stderr).toBe(0);
    // Guard: the same workflow needs the new roots; an unextended helper/policy fails.
    expect(run([], script, forceMount).status).not.toBe(0);
  });
}

it('keeps planning worktree read-only while allowing scoped runtime and insights writes', (context) => {
  const extra = [
    '--read-root',
    join(root, 'knowledge'),
    '--write-root',
    join(root, 'knowledge/insights'),
  ];
  const probe = run([], 'exit 0', true, true);
  if (probe.status !== 0) {
    context.skip(`Mount isolation unavailable: ${probe.stderr.trim()}`);
    return;
  }
  const result = run(
    extra,
    `set -eu
printf planning > '${root}/home/planning'
printf planning > '${root}/knowledge/insights/planning'
if printf bad > '${root}/work/new' 2>/dev/null; then exit 25; fi
`,
    true,
    true,
  );
  expect(result.status, result.stderr).toBe(0);
});

it('rejects relative roots and symbolic links before launching', async () => {
  await symlink(join(root, 'knowledge'), join(root, 'link'));
  for (const path of ['relative', join(root, 'link'), join(root, 'link/insights')]) {
    const result = run(['--read-root', path], 'exit 0');
    expect(result.status).toBe(126);
    expect(result.stderr).toMatch(/invalid secret path|invalid runtime root|symbolic links/);
  }
});

it('executes installed review and package wrappers with the normal launch policy', (context) => {
  const paths = ['/opt/agent-seed', '/opt/verity/package-managers'];
  if (!paths.every((path) => existsSync(path))) {
    context.skip('Toolkit installation directories are unavailable');
    return;
  }
  const spec = agentLaunchSpec(
    { command: 'codex-acp', args: [], cwd: join(root, 'work'), managedHome: join(root, 'home') },
    { agentUid: process.getuid!(), agentGid: process.getgid!(), worktreeRoot: root, env: {} },
  );
  const extra = paths.flatMap((path) => {
    const index = spec.args.indexOf(path);
    expect(index).toBeGreaterThan(0);
    return spec.args.slice(index - 1, index + 1);
  });
  const script = `set -eu
/opt/agent-seed/bin/verity-code-review --help
/opt/verity/package-managers/npm --version
if touch /opt/agent-seed/confinement-write-probe 2>/dev/null; then exit 31; fi
if touch /opt/verity/package-managers/confinement-write-probe 2>/dev/null; then exit 32; fi
`;
  const probe = run([], 'exit 0', true);
  if (probe.status !== 0) {
    context.skip(`Mount isolation unavailable: ${probe.stderr.trim()}`);
    return;
  }
  const result = run(extra, script, true);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('usage: verity-code-review');
  expect(run([], script, true).status).not.toBe(0);
});

it('launches symlinked npm CLIs without exposing the enclosing user directory', async (context) => {
  const installation = join(root, 'nvm/versions/node/current/lib/node_modules');
  const packageRoot = join(installation, 'fixture-agent');
  await mkdir(packageRoot, { recursive: true });
  const executable = join(packageRoot, 'cli');
  await writeFile(executable, '#!/bin/sh\ncat "$(dirname "$(readlink -f "$0")")/data"\n', {
    mode: 0o755,
  });
  await writeFile(join(packageRoot, 'data'), 'fixture-agent-output');
  await writeFile(join(root, 'nvm/private'), 'private');
  const link = join(root, 'work/fixture-agent');
  await symlink(executable, link);
  const spec = agentLaunchSpec(
    { command: 'codex-acp', args: [], cwd: join(root, 'work'), managedHome: join(root, 'home') },
    {
      agentUid: process.getuid!(),
      agentGid: process.getgid!(),
      codexAcpPath: link,
      worktreeRoot: root,
      env: {},
    },
  );
  const index = spec.args.indexOf(installation);
  expect(index).toBeGreaterThan(0);
  const extra = spec.args.slice(index - 1, index + 1);
  expect(extra[0]).toBe('--read-root');
  const probe = run([], 'exit 0', true);
  if (probe.status !== 0) {
    context.skip(`Mount isolation unavailable: ${probe.stderr.trim()}`);
    return;
  }
  const script = `set -eu
${link}
if cat '${root}/nvm/private' 2>/dev/null; then exit 41; fi
if touch '${packageRoot}/unexpected-write' 2>/dev/null; then exit 42; fi
`;
  const result = run(extra, script, true);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('fixture-agent-output');
  expect(run([], script, true).status).not.toBe(0);
});

it('starts Node with the system OpenSSL configuration under the normal policy', (context) => {
  if (!existsSync('/etc/ssl/openssl.cnf')) {
    context.skip('System OpenSSL configuration unavailable');
    return;
  }
  const spec = agentLaunchSpec(
    { command: 'codex-acp', args: [], cwd: join(root, 'work'), managedHome: join(root, 'home') },
    { agentUid: process.getuid!(), agentGid: process.getgid!(), worktreeRoot: root, env: {} },
  );
  const index = spec.args.indexOf('/etc/ssl/openssl.cnf');
  expect(index).toBeGreaterThan(0);
  const extra = spec.args.slice(index - 1, index + 1);
  expect(extra[0]).toBe('--secret');
  const probe = run([], 'exit 0', true);
  if (probe.status !== 0) {
    context.skip(`Mount isolation unavailable: ${probe.stderr.trim()}`);
    return;
  }
  const script = `set -e
cat /etc/ssl/openssl.cnf >/dev/null
OPENSSL_CONF=/etc/ssl/openssl.cnf ${process.execPath} -e 'console.log("node-started")'`;
  const result = run(extra, script, true);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('node-started');
  expect(run([], script, true).status).not.toBe(0);
});
