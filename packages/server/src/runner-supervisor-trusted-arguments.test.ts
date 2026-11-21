import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  materializeTrustedCliEntryScript,
  trustedCliLaunchSpec,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import {
  execFileAsync,
  IMMUTABLE_EXECUTABLE_PATH,
  validateTrustedCliArguments,
} from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  // Without file injection a tool that wants its secret as a file — example-cli's
  // EXAMPLE_CONFIG, `example-cli up --secret=file:…` — is unreachable: there is no
  // shell, and a script in the worktree is refused because the executable must be
  // root-owned. Agents then build a wrapper, which is exactly what that rule
  // exists to stop. Verity writing the file removes the reason to try.
  it('hands a file-injected secret to the command as a path, never as the value', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/local/bin/example-cli',
        args: ['get', 'items'],
        cwd: '/work/project',
        secrets: [{ name: 'EXAMPLE_CONFIG', value: 'apiVersion: v1', injection: 'file' }],
      },
      { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
    );
    expect(spec.spawnOptions.env?.EXAMPLE_CONFIG).toBe('/run/verity-runner/secrets/EXAMPLE_CONFIG');
    expect(JSON.stringify(spec)).not.toContain('apiVersion');
  });

  it('still passes an env-injected secret by value', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/local/bin/fastlane',
        args: [],
        cwd: '/work/project',
        secrets: [{ name: 'ASC_KEY', value: 'value-marker', injection: 'env' }],
      },
      { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
    );
    expect(spec.spawnOptions.env?.ASC_KEY).toBe('value-marker');
  });

  // The executable rule used to cover argv[0] alone, so
  // `/usr/bin/timeout … /work/…/script.sh` slipped through: timeout is
  // root-owned while the payload is a script the agent can rewrite between one
  // approved run and the next.
  it('refuses an agent-owned executable hidden in the arguments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-argv-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an agent-owned symlink even when it currently targets root-owned code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-argv-symlink-'));
    const link = join(root, 'payload');
    await symlink('/bin/sh', link);
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', link], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  // The approval card already warns that a trusted process may disclose its
  // secret, so inline code the operator read before approving stays legitimate.
  // What must not pass is a path: it shows a name, never the bytes behind it.
  it('allows inline code the operator could read in the prompt', async () => {
    await expect(
      validateTrustedCliArguments('/bin/sh', ['-c', 'echo hi'], '/'),
    ).resolves.toBeUndefined();
  });

  it('refuses a mutable script handed to an interpreter, execute bit or not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-interp-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments('/bin/sh', [script], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('allows a worktree entry script only under its approved content hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-hashed-interp-'));
    const script = join(root, 'payload.sh');
    const contents = 'echo hi\n';
    await writeFile(script, contents, { mode: 0o644 });
    const approved = {
      path: script,
      projectPath: 'payload.sh',
      sha256: createHash('sha256').update(contents).digest('hex'),
      loading: 'isolated' as const,
    };
    await expect(
      validateTrustedCliArguments('/bin/sh', [script], root, undefined, [], approved),
    ).resolves.toBeUndefined();
    await writeFile(script, 'echo changed\n', { mode: 0o644 });
    // The outer broker performs this comparison immediately before validation;
    // focused validator calls still prove the mutable-file exception is scoped
    // to the one attested path rather than every interpreter operand.
    await expect(
      validateTrustedCliArguments(
        '/bin/sh',
        [join(root, 'other.sh')],
        root,
        undefined,
        [],
        approved,
      ),
    ).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('allows directory data only after an approved dynamic script within its worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-dynamic-directory-'));
    const script = join(root, 'deploy.sh');
    await writeFile(script, 'echo approved\n');
    await mkdir(join(root, 'dist'));
    await symlink(tmpdir(), join(root, 'outside'));
    const approved = {
      path: script,
      projectPath: 'deploy.sh',
      sha256: createHash('sha256').update('echo approved\n').digest('hex'),
      loading: 'dynamic' as const,
      worktreeRoot: root,
    };
    try {
      await expect(
        validateTrustedCliArguments(
          '/bin/sh',
          [script, '--input-dir', 'dist'],
          root,
          undefined,
          [],
          approved,
        ),
      ).resolves.toBeUndefined();
      for (const operand of ['outside', tmpdir()]) {
        await expect(
          validateTrustedCliArguments(
            '/bin/sh',
            [script, '--input-dir', operand],
            root,
            undefined,
            [],
            approved,
          ),
        ).rejects.toThrow('regular file');
      }
      await expect(
        validateTrustedCliArguments('/bin/sh', ['dist'], root, undefined, [], approved),
      ).rejects.toThrow('regular file');
      await expect(
        validateTrustedCliArguments('/bin/sh', [script, 'dist'], root, undefined, [], {
          ...approved,
          loading: 'isolated',
        }),
      ).rejects.toThrow('regular file');
      await expect(validateTrustedCliArguments('/usr/bin/true', ['dist'], root)).rejects.toThrow(
        'regular file',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes an immutable broker snapshot rather than reopening mutable worktree bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-snapshot-'));
    const script = join(root, 'payload.sh');
    const contents = 'echo approved\n';
    await writeFile(script, contents, { mode: 0o644 });
    const materialized = await materializeTrustedCliEntryScript(
      {
        args: [script, '--apply'],
        cwd: root,
        entryScript: {
          path: script,
          projectPath: 'payload.sh',
          sha256: createHash('sha256').update(contents).digest('hex'),
          loading: 'isolated',
          worktreeRoot: root,
        },
      },
      {
        trustedCliEntryScriptDir: join(root, 'snapshots'),
        enforceRoot: false,
        agentUid: process.getuid!(),
        agentGid: process.getgid!(),
      },
    );
    await writeFile(script, 'echo attacker replacement\n', { mode: 0o644 });
    expect(materialized.args[0]).not.toBe(script);
    expect(materialized.entrySandbox).toMatchObject({ loading: 'isolated' });
    await expect(readFile(materialized.args[0]!, 'utf8')).resolves.toBe(contents);
    await expect(materialized.cleanup()).resolves.toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('preserves nested parent-relative resources for one-time dynamic scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-dynamic-tree-'));
    const scripts = join(root, 'commands', 'nested');
    await mkdir(scripts, { recursive: true });
    await mkdir(join(root, 'lib'));
    const script = join(scripts, 'deploy.js');
    const contents = 'require("../../lib/config.js")\n';
    await writeFile(script, contents);
    await writeFile(join(root, 'lib', 'config.js'), 'module.exports = true\n');
    const materialized = await materializeTrustedCliEntryScript(
      {
        args: [script],
        cwd: root,
        entryScript: {
          path: script,
          projectPath: 'commands/nested/deploy.js',
          sha256: createHash('sha256').update(contents).digest('hex'),
          loading: 'dynamic',
          worktreeRoot: root,
        },
      },
      {
        trustedCliEntryScriptDir: join(root, 'snapshots'),
        enforceRoot: false,
        agentUid: process.getuid!(),
        agentGid: process.getgid!(),
      },
    );
    expect(materialized.entrySandbox).toMatchObject({
      loading: 'dynamic',
      dynamicRoot: root,
    });
    const launch = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/bin/node',
        args: materialized.args,
        cwd: root,
        secrets: [],
        entrySandbox: materialized.entrySandbox!,
      },
      { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
    );
    expect(launch.args).toEqual(expect.arrayContaining(['--dynamic-root', root]));
    const parentResource = resolve(materialized.args[0]!, '..', '..', '..', 'lib', 'config.js');
    await expect(readFile(parentResource, 'utf8')).resolves.toBe('module.exports = true\n');
    await expect(materialized.cleanup()).resolves.toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('denies mutable worktree reads for reusable scripts but permits one-time dynamic loading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-script-isolation-'));
    const helper = join(root, 'verity-script-sandbox');
    const snapshotRoot = join(root, 'snapshot');
    const worktree = join(root, 'worktree');
    await mkdir(snapshotRoot);
    await mkdir(worktree);
    await writeFile(join(worktree, 'dependency'), 'mutable\n');
    await symlink(join(worktree, 'dependency'), join(snapshotRoot, 'escaped-dependency'));
    const allowedSecret = join(root, 'secret-allowed');
    const otherSecret = join(root, 'secret-other');
    await writeFile(allowedSecret, 'allowed\n');
    await writeFile(otherSecret, 'other\n');
    const sharedMemoryDependency = `/dev/shm/verity-script-isolation-${String(process.pid)}`;
    await writeFile(sharedMemoryDependency, 'mutable\n');
    await copyFile(
      resolve('features/verity-sandbox-toolkit/prebuilt/linux-amd64/verity-script-sandbox'),
      helper,
    );
    await chmod(helper, 0o755);
    const execSandbox = (args: string[]) => execFileAsync(helper, args);
    await expect(execSandbox(['--probe'])).resolves.toBeDefined();
    const command = ['--root', snapshotRoot, '--cwd', snapshotRoot, '--loading'];
    await expect(
      execSandbox([...command, 'isolated', '--', '/usr/bin/cat', join(worktree, 'dependency')]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execSandbox([
        ...command,
        'isolated',
        '--',
        '/usr/bin/cat',
        join(snapshotRoot, 'escaped-dependency'),
      ]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execSandbox([
        ...command,
        'isolated',
        '--secret',
        allowedSecret,
        '--',
        '/usr/bin/cat',
        allowedSecret,
      ]),
    ).resolves.toMatchObject({ stdout: 'allowed\n' });
    await expect(
      execSandbox([
        ...command,
        'isolated',
        '--secret',
        allowedSecret,
        '--',
        '/usr/bin/cat',
        otherSecret,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execSandbox([
        ...command,
        'isolated',
        '--',
        '/usr/bin/cat',
        `/proc/self/root${join(worktree, 'dependency')}`,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execSandbox([...command, 'isolated', '--', '/usr/bin/cat', sharedMemoryDependency]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execSandbox([...command, 'isolated', '--', '/usr/bin/cat', '/etc/passwd']),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execSandbox([
        ...command,
        'isolated',
        '--write-isolated',
        '--',
        '/usr/bin/mount',
        '-o',
        'remount,rw,bind',
        snapshotRoot,
        snapshotRoot,
      ]),
    ).rejects.toMatchObject({ code: 32 });
    await expect(
      execSandbox([
        ...command,
        'dynamic',
        '--dynamic-root',
        worktree,
        '--',
        '/usr/bin/cat',
        join(worktree, 'dependency'),
      ]),
    ).resolves.toBeDefined();
    await expect(
      execSandbox([
        ...command,
        'dynamic',
        '--dynamic-root',
        worktree,
        '--',
        '/usr/bin/cat',
        otherSecret,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    await rm(sharedMemoryDependency, { force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('enforces the mount-namespace backend, including nested read-only mounts, when supported', async () => {
    const namespaceProbe = await execFileAsync('/usr/bin/unshare', [
      '--user',
      '--map-root-user',
      '--mount',
      '/bin/true',
    ]).then(
      () => true,
      () => false,
    );
    if (!namespaceProbe) return;

    const root = mkdtempSync(join(tmpdir(), 'verity-script-namespace-'));
    const helper = join(root, 'verity-script-sandbox');
    const allowedRoot = join(root, 'allowed');
    const hidden = join(root, 'hidden');
    const nestedMount = join(allowedRoot, 'dependency-volume');
    const nestedMountWrite = join(nestedMount, 'write-attempt');
    const allowedSecret = join(root, 'allowed-secret');
    await mkdir(allowedRoot);
    await mkdir(nestedMount);
    await writeFile(hidden, 'hidden\n');
    await writeFile(allowedSecret, 'allowed\n');
    await symlink(hidden, join(allowedRoot, 'escaped'));
    await copyFile(
      resolve('features/verity-sandbox-toolkit/prebuilt/linux-amd64/verity-script-sandbox'),
      helper,
    );
    await chmod(helper, 0o755);
    const forcedEnvironment = {
      ...process.env,
      VERITY_SCRIPT_SANDBOX_FORCE_MOUNT_NAMESPACE: '1',
    };
    await expect(
      execFileAsync(helper, ['--probe'], { env: forcedEnvironment }),
    ).resolves.toBeDefined();
    await expect(
      execFileAsync(
        helper,
        [
          '--root',
          allowedRoot,
          '--cwd',
          allowedRoot,
          '--loading',
          'isolated',
          '--',
          '/usr/bin/cat',
          hidden,
        ],
        { env: forcedEnvironment },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync(
        helper,
        [
          '--root',
          allowedRoot,
          '--cwd',
          allowedRoot,
          '--loading',
          'isolated',
          '--secret',
          allowedSecret,
          '--',
          '/usr/bin/cat',
          allowedSecret,
        ],
        { env: forcedEnvironment },
      ),
    ).resolves.toMatchObject({ stdout: 'allowed\n' });
    await expect(
      execFileAsync(
        helper,
        [
          '--root',
          allowedRoot,
          '--cwd',
          allowedRoot,
          '--loading',
          'isolated',
          '--secret',
          allowedSecret,
          '--',
          '/bin/bash',
          '-c',
          'exec 9<"$1"; /usr/bin/diff <(cat /dev/fd/9) <(printf "allowed\\n")',
          'bash',
          allowedSecret,
        ],
        { env: forcedEnvironment },
      ),
    ).resolves.toBeDefined();
    await expect(
      execFileAsync(
        helper,
        [
          '--root',
          allowedRoot,
          '--cwd',
          allowedRoot,
          '--loading',
          'isolated',
          '--',
          '/usr/bin/cat',
          join(allowedRoot, 'escaped'),
        ],
        { env: forcedEnvironment },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync('/usr/bin/unshare', [
        '--user',
        '--map-root-user',
        '--mount',
        '/bin/sh',
        '-eu',
        '-c',
        [
          'mount -t tmpfs -o mode=0700,size=1m tmpfs "$2"',
          'touch "$3"',
          'rm "$3"',
          'VERITY_SCRIPT_SANDBOX_FORCE_MOUNT_NAMESPACE=1 exec "$1" --root "$4" --cwd "$4" --loading isolated --write-isolated -- /bin/sh -c \'touch "$1"; result=$?; rm -f "$1"; exit "$result"\' sh "$3"',
        ].join('\n'),
        'sh',
        helper,
        nestedMount,
        nestedMountWrite,
        allowedRoot,
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Read-only file system') });
    await rm(root, { recursive: true, force: true });
  });

  it('follows wrappers to a non-executable script handed to an interpreter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-wrapped-interp-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', '/usr/bin/env', 'sh', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('activates an absolute interpreter nested behind a wrapper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-absolute-interp-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', '/bin/sh', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a relative script handed directly to an interpreter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-relative-interp-'));
    await writeFile(join(root, 'payload.sh'), 'echo hi\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments('/bin/sh', ['./payload.sh'], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('recognizes an interpreter through an executable alias', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-interpreter-alias-'));
    const alias = join(root, 'rbash');
    const script = join(root, 'payload.sh');
    await symlink('/bin/bash', alias);
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments(alias, ['payload.sh'], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('fails closed when an interpreter script operand does not exist yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-missing-interp-'));
    await expect(validateTrustedCliArguments('/bin/sh', ['./payload.sh'], root)).rejects.toThrow(
      /operand does not exist/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('follows wrappers to a relative interpreter script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-relative-wrapper-'));
    await writeFile(join(root, 'payload.sh'), 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/timeout',
        ['240s', '/usr/bin/env', 'sh', 'payload.sh'],
        root,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an agent-owned executable resolved through an env PATH assignment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-env-path-'));
    const payload = join(root, 'payload');
    await writeFile(payload, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        [`PATH=${root}`, 'payload'],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an agent-writable inherited PATH used by an unrecognized dispatcher', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-dispatcher-path-'));
    const payload = join(root, 'payload');
    await writeFile(payload, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments('/usr/bin/xargs', ['payload'], '/', root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('resolves a bare nested interpreter through the effective PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-bare-interpreter-'));
    const python = join(root, 'python3');
    await writeFile(python, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        [`PATH=${root}`, 'python3', 'script.py'],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects env split-string because it hides executed argv in one token', async () => {
    await expect(
      validateTrustedCliArguments('/usr/bin/env', ['-S', 'sh /work/payload.sh'], '/work'),
    ).rejects.toThrow(/env option execution is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/timeout',
        ['240s', '/usr/bin/env', '--split-string', 'sh /work/payload.sh'],
        '/work',
      ),
    ).rejects.toThrow(/env option execution is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['--chdir=/work/subdir', 'sh', 'payload.sh'],
        '/work',
      ),
    ).rejects.toThrow(/env option execution is not immutable/u);
  });

  it('stops parsing env before ordinary command options begin', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['EXAMPLE_CONFIG=/etc/passwd', '/usr/bin/printf', '--namespace', 'default'],
        '/work',
      ),
    ).resolves.toBeUndefined();
  });

  it('validates an existing cwd-relative operand even when it is a bare value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-bare-data-'));
    await writeFile(join(root, 'items'), 'mutable ordinary value collision\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments('/usr/local/bin/example-cli', ['get', 'items'], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  // Inline code may hand the materialized secret on — the operator read that
  // code before approving it — but it relabels nothing else: every other
  // mutable file stays refused, whatever the inline code would do with it.
  // The bound is the path, which is why both spellings now decide alike; the
  // spelling never bound anything, since `"${1#file:}"` undoes it in the code.
  it('does not let inline interpreter code relabel a mutable file as data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-inline-data-'));
    const secret = join(root, 'EXAMPLE_CONFIG');
    const other = join(root, 'OTHER');
    await writeFile(secret, 'apiVersion: v1\n', { mode: 0o600 });
    await writeFile(other, 'apiVersion: v1\n', { mode: 0o600 });
    for (const operand of [secret, `file:${secret}`]) {
      await expect(
        validateTrustedCliArguments(
          '/bin/sh',
          ['-c', 'example-cli --config "${1#file:}"', 'sh', operand],
          root,
          IMMUTABLE_EXECUTABLE_PATH,
          [secret],
        ),
      ).resolves.toBeUndefined();
    }
    for (const operand of [other, `file:${other}`]) {
      await expect(
        validateTrustedCliArguments(
          '/bin/sh',
          ['-c', 'example-cli --config "${1#file:}"', 'sh', operand],
          root,
          IMMUTABLE_EXECUTABLE_PATH,
          [secret],
        ),
      ).rejects.toThrow(/root-owned and immutable/u);
    }
    await rm(root, { recursive: true, force: true });
  });

  it('rejects interpreter module lookup because it cannot bind the module bytes', async () => {
    await expect(
      validateTrustedCliArguments('/usr/bin/python3', ['-m', 'mutable_module'], '/work'),
    ).rejects.toThrow(/module execution is not immutable/u);
    await expect(
      validateTrustedCliArguments('/usr/bin/python3', ['-mmutable_module'], '/work'),
    ).rejects.toThrow(/module execution is not immutable/u);
  });

  it('allows combined shell inline flags as visible one-time code', async () => {
    await expect(
      validateTrustedCliArguments('/bin/sh', ['-ec', 'echo hi'], '/work'),
    ).resolves.toBeUndefined();
  });

  it('rejects interpreter preload options that name mutable code', async () => {
    await expect(
      validateTrustedCliArguments('/usr/bin/node', ['--require=./mutable.js'], '/work'),
    ).rejects.toThrow(/interpreter option execution is not immutable/u);
    await expect(
      validateTrustedCliArguments('/usr/bin/ruby', ['-r./mutable.rb'], '/work'),
    ).rejects.toThrow(/interpreter option execution is not immutable/u);
  });

  it('recognizes versioned, awk, and busybox interpreters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-loader-families-'));
    const script = join(root, 'payload');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments('/usr/bin/python3.12', [script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await expect(validateTrustedCliArguments('/usr/bin/ruby3.3', [script], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await expect(validateTrustedCliArguments('/usr/bin/awk', ['-f', script], root)).rejects.toThrow(
      /interpreter option execution is not immutable/u,
    );
    await expect(
      validateTrustedCliArguments('/usr/bin/busybox', ['ash', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('validates mutable file arguments without knowing the runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-unknown-loader-'));
    const script = join(root, 'payload.lua');
    await writeFile(script, 'print("hi")\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments('/usr/bin/lua', [script], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await expect(
      validateTrustedCliArguments('/usr/bin/env', [`LD_PRELOAD=${script}`, '/usr/bin/curl'], root),
    ).rejects.toThrow(/code-loading environment is not immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects code-loading env and unresolved path assignments', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['NODE_OPTIONS=--require=./mutable.js', 'node'],
        '/work',
      ),
    ).rejects.toThrow(/code-loading environment is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['LD_LIBRARY_PATH=/work/lib:/usr/lib', '/usr/bin/curl'],
        '/work',
      ),
    ).rejects.toThrow(/code-loading environment is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['EXAMPLE_CONFIG=/run/config', '/usr/local/bin/example-cli', 'get', 'items'],
        '/work',
      ),
    ).rejects.toThrow(/file operand does not exist/u);
  });

  it('rejects a missing path that could be created after validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-missing-file-'));
    await expect(
      validateTrustedCliArguments('/usr/bin/xargs', ['./payload'], root),
    ).rejects.toThrow(/file operand does not exist/u);
    await rm(root, { recursive: true, force: true });
  });

  it('does not confuse URLs or slash-bearing resource identifiers with file operands', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/printf',
        ['https://api.example.com/v1', 'items/name'],
        '/work',
      ),
    ).resolves.toBeUndefined();
  });

  // Verity created this exact path from the server-side provider value for this
  // launch, so it is the one mutable file whose provenance is trustworthy.
  it('allows the exact Verity-materialized secret file in an explicit file operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-data-'));
    const data = join(root, 'EXAMPLE_CONFIG');
    await writeFile(data, 'apiVersion: v1\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', `--secret=file:${data}`],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [data],
      ),
    ).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  // What a flag calls its file operand is the tool's choice, not the agent's:
  // `--secret=file:<path>` and `--secret-file <path>` reach the same entry.
  // Deciding on the spelling locked file injection to tools offering the first.
  it('allows the materialized secret however the flag spells its path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-plain-'));
    const data = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    await writeFile(data, 'tskey-auth-example\n', { mode: 0o600 });
    for (const args of [
      ['up', '--secret-file', data],
      ['up', `--secret-file=${data}`],
      ['get', 'items', `--config=${data}`],
    ]) {
      await expect(
        validateTrustedCliArguments(
          '/usr/local/bin/example-cli',
          args,
          root,
          IMMUTABLE_EXECUTABLE_PATH,
          [data],
        ),
      ).resolves.toBeUndefined();
    }
    await rm(root, { recursive: true, force: true });
  });

  // The secret is written after validation, so the path it will occupy is
  // absent exactly when it is checked. Nothing else absent becomes admissible.
  it('allows the secret path before it is written, and nothing else absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-pending-'));
    const pending = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', '--secret-file', pending],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [pending],
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', '--secret-file', join(root, 'OTHER')],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [pending],
      ),
    ).rejects.toThrow(/file operand does not exist/u);
    await rm(root, { recursive: true, force: true });
  });

  // Naming the path is the whole point; executing what lands there is not.
  it('refuses the materialized secret as an interpreter script operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-secret-script-'));
    const pending = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    await expect(
      validateTrustedCliArguments('/usr/bin/sh', [pending], root, '/usr/bin:/bin', [pending]),
    ).rejects.toThrow(/interpreter operand does not exist/u);
    await writeFile(pending, 'echo hi\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments('/usr/bin/sh', [pending], root, '/usr/bin:/bin', [pending]),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  // The refusal has to carry what the next attempt needs, or the agent retries
  // the same argv: the token that failed, and the path that would have passed.
  it('names the failing operand and the admissible secret path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-message-'));
    const pending = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    // No shell expands argv here, so `$VAR` reaches the broker literally.
    const unexpanded = () =>
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', '--secret=file:$EXAMPLE_NETWORK_AUTH_FILE'],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [pending],
      );
    await expect(unexpanded()).rejects.toThrow(/file:\$EXAMPLE_NETWORK_AUTH_FILE/u);
    await expect(unexpanded()).rejects.toThrow(pending);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects ordinary mutable data because configuration can activate code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-mutable-config-'));
    const config = join(root, 'EXAMPLE_CONFIG');
    await writeFile(config, 'users: [{ exec: { command: ./payload } }]\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['--config', config, 'get', 'items'],
        root,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('allows root-owned immutable non-executable data', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/curl',
        ['--cacert', '/etc/ssl/certs/ca-certificates.crt'],
        '/work',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a special-file interpreter operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-special-file-'));
    const fifo = join(root, 'payload');
    await new Promise<void>((resolvePromise, reject) => {
      execFile('/usr/bin/mkfifo', [fifo], (error) =>
        error ? reject(new Error(error.message, { cause: error })) : resolvePromise(),
      );
    });
    await expect(validateTrustedCliArguments('/bin/sh', [fifo], root)).rejects.toThrow(
      /regular file/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  // A socket is not content. What sits behind the name is a live peer, decided
  // when the node was bound — and only root can bind one in a directory the rule
  // already requires to be root-owned and unwritable. Refusing it for its node
  // type put every CLI whose flag names a daemon endpoint out of reach, starting
  // with `example-cli --socket=…`, which is where this was found.
  //
  // So it answers to ownership like any other operand, and an agent-owned socket
  // is still refused — what moved is the reason, and that is the whole of the
  // change. Asserting the reason is the only way to see it here: the accepting
  // half needs a root-owned socket, which no unprivileged test process can
  // create. `scripts/probes/trusted-cli-socket-operand.mjs` measures that half.
  it('judges a socket operand by ownership rather than by its node type', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-socket-'));
    const socketPath = join(root, 'example-daemon.sock');
    const daemon = createServer();
    await new Promise<void>((listening) => daemon.listen(socketPath, listening));
    try {
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/example-cli',
          [`--socket=${socketPath}`, 'status'],
          root,
        ),
      ).rejects.toThrow(/root-owned and immutable/u);
      // Except in the one position where a script belongs: an interpreter reads
      // its operand for bytes, so a special file there stays refused outright,
      // exactly as the FIFO above is.
      await expect(validateTrustedCliArguments('/bin/sh', [socketPath], root)).rejects.toThrow(
        /regular file/u,
      );
    } finally {
      daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
