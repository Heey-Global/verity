import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'features/verity-sandbox-toolkit/bin/verity-node-modules-install';
const LAUNCHER = 'features/verity-sandbox-toolkit/bin/verity-runner-stack-start';

/** A /work stand-in plus an `npm` on PATH that records how it was called and
 *  behaves like `npm ci`: it empties node_modules first, then installs. */
function sandbox(opts: { lockfile: boolean; npmExit?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'verity-nm-install-'));
  const work = join(root, 'work');
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  mkdirSync(join(work, 'node_modules'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(work, 'package.json'), '{}');
  if (opts.lockfile) writeFileSync(join(work, 'package-lock.json'), '{}');
  const calls = join(root, 'npm-calls');
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/usr/bin/env bash',
      `printf '%s|%s\\n' "$PWD" "$*" >>'${calls}'`,
      'find node_modules -mindepth 1 -delete',
      'echo installing',
      `if [ ${String(opts.npmExit ?? 0)} -ne 0 ]; then exit ${String(opts.npmExit ?? 0)}; fi`,
      'touch node_modules/.package-lock.json',
    ].join('\n'),
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    VERITY_NODE_MODULES_WORK: work,
    VERITY_NODE_MODULES_STATE_DIR: state,
  };
  const run = () => execFileSync('bash', [SCRIPT], { env });
  /** Runs the script while another holder already has its lock. */
  const runLocked = () => {
    mkdirSync(state, { recursive: true });
    execFileSync('flock', [join(state, 'lock'), 'bash', SCRIPT], { env });
  };
  const status = () => readFileSync(join(state, 'status'), 'utf8').trim();
  const npmCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { work, state, run, runLocked, status, npmCalls };
}

describe('verity-node-modules-install', () => {
  it('installs an npm project whose dependency volume is empty, reproducibly', () => {
    const box = sandbox({ lockfile: true });
    box.run();
    // `ci`, never `install`: install may rewrite the tracked lockfile, leaving the
    // agent a dirty tree it never touched.
    expect(box.npmCalls()).toEqual([`${box.work}|ci --no-audit --no-fund`]);
    expect(box.status()).toBe('ready');
    // `npm ci` empties node_modules, dotfiles included, before installing. A status
    // or log kept in there would be deleted by the very install it reports on.
    expect(existsSync(join(box.state, 'install.log'))).toBe(true);
    expect(readFileSync(join(box.state, 'install.log'), 'utf8')).toContain('installing');
  });

  it('leaves a finished install alone on every later start', () => {
    const box = sandbox({ lockfile: true });
    box.run();
    box.run();
    expect(box.npmCalls()).toHaveLength(1);
    expect(box.status()).toBe('ready');
  });

  it('never runs a second install beside one already in progress', () => {
    // A wake and a Server restart both re-run the launcher. Two concurrent `npm ci`
    // runs each start by emptying the tree the other is writing.
    const box = sandbox({ lockfile: true });
    box.runLocked();
    expect(box.npmCalls()).toEqual([]);
  });

  it('starts over after an install that never finished', () => {
    // A recreate mid-install leaves packages but no npm hidden lockfile; treating
    // "not empty" as "installed" would strand the project on a partial tree.
    const box = sandbox({ lockfile: true });
    mkdirSync(join(box.work, 'node_modules', 'left-pad'));
    box.run();
    expect(box.npmCalls()).toHaveLength(1);
    expect(box.status()).toBe('ready');
  });

  it('says so instead of guessing when there is no npm lockfile', () => {
    const box = sandbox({ lockfile: false });
    box.run();
    expect(box.npmCalls()).toEqual([]);
    expect(box.status()).toMatch(/^manual: no package-lock\.json/);
  });

  it('reports a failed install with where to look', () => {
    const box = sandbox({ lockfile: true, npmExit: 1 });
    box.run();
    expect(box.status()).toMatch(/^failed: .*install\.log/);
  });
});

describe('verity-runner-stack-start node_modules hand-over', () => {
  const launcher = readFileSync(LAUNCHER, 'utf8');
  const block = launcher.slice(
    launcher.indexOf('NODE_MODULES_DIR='),
    launcher.indexOf('BROKER_RUNTIME='),
  );

  it('only chowns a mount point, and never through a symlink', () => {
    // Without the volume, /work/node_modules is an agent-writable path. A root
    // chown keyed on mere existence would follow a symlink the agent planted there.
    expect(block).toContain('/proc/self/mountinfo');
    expect(block).toMatch(/\[ ! -L "\$NODE_MODULES_DIR" \]/);
    expect(block).toMatch(/chown -h "\$AGENT_UID:\$AGENT_GID" "\$NODE_MODULES_DIR"/);
  });

  it('installs as the agent, detached, without being able to fail the stack start', () => {
    const start = block.split('\n').find((line) => line.includes('verity-node-modules-install'));
    // As root, the install would leave a tree the agent cannot update; attached,
    // it would outlive the 12 s exec deadline and fail the whole Runner start.
    expect(start).toMatch(/^\s*as_agent nohup /);
    expect(start).toMatch(/<\/dev\/null >\/dev\/null 2>&1 &$/);
  });

  it('is installed wherever the launcher is', () => {
    for (const installer of ['features/verity-sandbox-toolkit/install.sh', 'deploy/Dockerfile']) {
      expect(readFileSync(installer, 'utf8')).toContain(
        '/usr/local/bin/verity-node-modules-install',
      );
    }
  });
});
