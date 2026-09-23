import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = 'deploy/bin/verity-project-check';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A Docker CLI serving one project Sandbox and its relay. `broken` names checks whose
 * `docker exec` fails the way a gVisor Sandbox without a resolver fails them.
 */
function run(broken: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'verity-project-check-'));
  roots.push(root);
  const docker = join(root, 'docker');
  writeFileSync(
    docker,
    `#!/bin/bash
case "$1" in
  version) echo 29.8.0 ;;
  info) echo 'runc runsc runsc-project' ;;
  ps)
    if [[ "$*" == *verity.component=project-relay* ]]; then echo verity-relay-p1
    else printf '%s\\n' verity-sandbox-p1 verity-relay-p1; fi ;;
  inspect)
    case "$*" in
      *verity.component*verity-relay-p1) echo project-relay ;;
      *verity.component*) echo '' ;;
      *verity.project-id*) echo p1 ;;
      *Runtime*) echo runsc-project ;;
    esac ;;
  exec)
    if [ -s "$(dirname "$0")/broken" ] && printf '%s\\n' "$*" | grep -qFf "$(dirname "$0")/broken"; then
      echo EAI_AGAIN; exit 1
    fi
    echo fine ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  writeFileSync(join(root, 'broken'), broken.map((check) => `${check}\n`).join(''));
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
  });
}

describe('verity-project-check', () => {
  it('passes a Sandbox where every check succeeds', () => {
    const result = run([]);
    expect(result.stdout).toContain('== verity-sandbox-p1 (project p1, runtime runsc-project)');
    expect(result.stdout).toContain('relay: verity-relay-p1');
    expect(result.stdout).not.toContain('FAIL');
    expect(result.stdout).toContain('all checks passed');
    expect(result.status).toBe(0);
  });

  // The v1.5.2 state on a systemd-resolved host: everything reachable but names. An operator
  // or a release check reading only the exit status has to see that as a failure.
  it('fails, and names each failed check, when the Sandbox cannot resolve', () => {
    const result = run(["lookup('registry.npmjs.org'", "lookup('github.com'"]);
    expect(result.stdout).toContain('FAIL  DNS registry.npmjs.org — EAI_AGAIN');
    expect(result.stdout).toContain('FAIL  DNS github.com — EAI_AGAIN');
    expect(result.stdout).toContain('2 check(s) failed');
    expect(result.status).toBe(1);
  });
});
