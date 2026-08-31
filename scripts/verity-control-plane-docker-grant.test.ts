import { execFile } from 'node:child_process';
import { chmodSync, chownSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = join(process.cwd(), 'deploy/bin/verity-control-plane-docker-grant');

/**
 * The socket is created by the test process, so it is owned by that process's
 * own uid and primary gid — no `chown`, and no root, required. The comparisons
 * under test are then driven from the OTHER side, by varying the agent identity
 * the script is told about, and by `chmod` for the permission bits.
 *
 * Except as root, where BOTH of those numbers are 0 — and the script rejects 0
 * for either, because uid/gid 0 is not an identity it will reason about. Some CI
 * jobs do run as root (`test-runner-forgery-boundary.mjs` needs to), so the
 * fixture chowns the socket to synthetic non-zero ids there instead of skipping.
 * Every id below is derived from what the socket ACTUALLY ends up owned by, so
 * the assertions read the same in both environments.
 */
const RUNNING_AS_ROOT = (process.getuid?.() ?? 0) === 0;
const SOCKET_UID = RUNNING_AS_ROOT ? 4242 : (process.getuid?.() ?? 0);
const SOCKET_GID = RUNNING_AS_ROOT ? 4243 : (process.getgid?.() ?? 0);
const COLLIDING_AGENT_UID = String(SOCKET_UID);
const DISTINCT_AGENT_UID = String(SOCKET_UID + 7);
const COLLIDING_AGENT_GID = String(SOCKET_GID);
const DISTINCT_AGENT_GID = String(SOCKET_GID + 7);
// The Runner runtime gid, which owns every turn journal. Distinct from the
// socket's own group everywhere except the one test that is about that clash.
const RUNNER_GID = String(SOCKET_GID + 11);

let dir: string;
let socketPath: string;
let server: Server | null = null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'verity-docker-grant-'));
  socketPath = join(dir, 'docker.sock');
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(socketPath, resolve);
  });
  // Node's socket mode follows the umask, so pin it: these tests are ABOUT the
  // permission bits, and a CI umask of 0 would otherwise hand every case a
  // world-writable socket and make the refusals fire everywhere. Before the
  // chown, not after — some hardened sandboxes refuse `chmod` on a file the
  // caller no longer owns, even to root.
  chmodSync(socketPath, 0o660);
  if (RUNNING_AS_ROOT) chownSync(socketPath, SOCKET_UID, SOCKET_GID);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

async function grant(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('deploy/bin/verity-control-plane-docker-grant', () => {
  it('grants the group it read off the mounted socket inode', async () => {
    const result = await grant([socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID]);
    expect(result.code).toBe(0);
    // The GID that comes out is the one on the inode, never a configured value:
    // a guessed GID yields a socket the agent cannot open, which is
    // indistinguishable from the feature not being deployed.
    expect(result.stdout.trim()).toBe(String(SOCKET_GID));
  });

  it('grants nothing when no socket is mounted', async () => {
    // The managed topology with the switch off, and every host that mounts no
    // daemon socket at all. Nothing to grant, and nothing to refuse.
    for (const value of ['1', '0']) {
      const result = await grant(
        [join(dir, 'absent.sock'), DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID],
        {
          VERITY_CONTROL_PLANE_RUNNER_DOCKER: value,
        },
      );
      expect(result.code, value).toBe(0);
      expect(result.stdout.trim(), value).toBe('');
    }
  });

  /**
   * One variable, two topologies, so the two parsers have to agree. The managed
   * reconciler (`dockerSocketEnabled`) trims and case-folds before comparing, and
   * a spelling that it reads as OFF while this script reads it as ON hands the
   * operator a denial on managed and a live socket on Compose — the same defect
   * as the refusal below, arriving through the parser instead of the permissions.
   */
  it('withholds the group when the kill switch is off, however it is spelled', async () => {
    for (const value of ['0', 'false', 'FALSE', 'False', ' false ', ' 0 ']) {
      const result = await grant([socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
        VERITY_CONTROL_PLANE_RUNNER_DOCKER: value,
      });
      expect(result.code, value).toBe(0);
      expect(result.stdout.trim(), value).toBe('');
    }
  });

  it('keeps the grant on for anything that is not an off spelling', async () => {
    // Unset, empty, and a typo all leave the diagnostics console working: a
    // fat-fingered value must not silently take the capability away.
    for (const value of ['', '1', 'true', 'no', 'off', 'disabled']) {
      const result = await grant([socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
        VERITY_CONTROL_PLANE_RUNNER_DOCKER: value,
      });
      expect(result.code, value).toBe(0);
      expect(result.stdout.trim(), value).toBe(String(SOCKET_GID));
    }
  });

  it('grants by default, and on the truthy spellings', async () => {
    // Opt-OUT: a diagnostics console that silently lacks its capability is the
    // failure this exists to end, so an unset variable means ON.
    for (const env of [{}, { VERITY_CONTROL_PLANE_RUNNER_DOCKER: '1' }]) {
      const result = await grant(
        [socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID],
        env,
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(String(SOCKET_GID));
    }
  });

  /**
   * The defect this refusal exists for.
   *
   * On the Compose topology the kill switch cannot drop the bind mount — Compose
   * has no way to remove one entry from a `volumes` list conditionally — so it
   * withholds the supplementary group instead and relies on permission bits. That
   * only denies anything while the socket's owning group is one the agent does
   * not already hold. If the socket is group-owned by the agent's PRIMARY gid,
   * the 0660 socket opens through the group bits with no supplementary group at
   * all: the switch reports success and withdraws nothing.
   *
   * Refuse the launch instead of delivering access that has been declared denied.
   */
  it('refuses to start when withholding the group would deny nothing', async () => {
    for (const value of ['0', 'false', 'FALSE', ' 0 ']) {
      const result = await grant(
        [socketPath, DISTINCT_AGENT_UID, COLLIDING_AGENT_GID, RUNNER_GID],
        {
          VERITY_CONTROL_PLANE_RUNNER_DOCKER: value,
        },
      );
      expect(result.code, value).toBe(1);
      expect(result.stdout.trim(), value).toBe('');
      // Name the condition, not just the failure: the operator has to be able to
      // tell this apart from a broken mount, and the message carries the three
      // ways out.
      expect(result.stderr, value).toContain("the agent's primary group");
      expect(result.stderr, value).toContain('VERITY_CONTROL_PLANE_RUNNER_DOCKER');
      expect(result.stderr, value).toContain(String(SOCKET_GID));
    }
  });

  /**
   * The group is only one of three ways the agent reaches a socket it has been
   * told it cannot. Connecting to a unix socket needs WRITE permission, and the
   * agent gets it from whichever class it falls into — so a withhold-only denial
   * has to clear all three, not just the group.
   */
  it('refuses when the socket is owned by the agent uid', async () => {
    // Rootless Docker puts the daemon socket in exactly this position: owned by
    // the human uid, which is the uid the agent runs as.
    const result = await grant([socketPath, COLLIDING_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
      VERITY_CONTROL_PLANE_RUNNER_DOCKER: '0',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("owned by the agent's uid");
  });

  it('refuses when the socket is world-writable', async () => {
    // `chmod 666 /var/run/docker.sock` is a common enough "fix" that the switch
    // has to survive meeting one.
    chmodSync(socketPath, 0o666);
    const result = await grant([socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
      VERITY_CONTROL_PLANE_RUNNER_DOCKER: '0',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('world-writable');
  });

  it('judges the agent by its own permission class, as the kernel does', async () => {
    // Exactly one class applies and there is no fall-through: an inode the agent
    // OWNS is judged by the owner bits even when `other` is more permissive. A
    // check that ORed the classes together would refuse here for access the
    // kernel does not actually grant — taking the control plane down over a
    // denial that was already in force.
    chmodSync(socketPath, 0o006);
    const result = await grant([socketPath, COLLIDING_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
      VERITY_CONTROL_PLANE_RUNNER_DOCKER: '0',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('refusing');
  });

  it('does not refuse for read-only access it cannot connect through', async () => {
    // The boundary of the check: connecting needs WRITE, so world-READABLE is not
    // a way in and must not brick a Runner whose operator asked for the denial.
    chmodSync(socketPath, 0o664);
    const result = await grant([socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
      VERITY_CONTROL_PLANE_RUNNER_DOCKER: '0',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('refusing');
  });

  /**
   * The other direction of the same check, and the reason it is a comparison
   * rather than a blanket refusal on the Compose path: the ordinary host, whose
   * docker group is not the agent's, must still start. A refusal that fired here
   * would take the control plane down on every deployment.
   */
  it('starts normally when the socket group is not the agent primary group', async () => {
    const result = await grant([socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
      VERITY_CONTROL_PLANE_RUNNER_DOCKER: '0',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('refusing');
  });

  /**
   * The collision only matters where the group is the whole of the denial. With
   * the grant ON the agent is meant to reach the socket, so a socket group that
   * happens to equal its primary gid is not a contradiction and must not brick
   * the Runner.
   */
  it('does not refuse a colliding gid while the grant is on', async () => {
    const result = await grant([socketPath, DISTINCT_AGENT_UID, COLLIDING_AGENT_GID, RUNNER_GID]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(String(SOCKET_GID));
  });

  /**
   * The one group that can never be granted, whatever the switch says.
   *
   * The runtime gid owns every turn's `events.jsonl`, its `control.sock` and
   * `supervisor.sock`, so the spawn broker throws on exactly this value
   * (`privilegeDropFlags`). Without this check a host whose Docker group happened
   * to be the runtime gid would deploy a Runner that looks perfectly healthy and
   * then fail EVERY agent launch deep inside the broker — the most expensive
   * place to find a provisioning mistake. Refuse at startup, and name it.
   */
  it('refuses a socket owned by the Runner runtime group', async () => {
    const result = await grant([
      socketPath,
      DISTINCT_AGENT_UID,
      DISTINCT_AGENT_GID,
      String(SOCKET_GID),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Runner runtime group');
  });

  it('refuses an agent primary gid it cannot compare', async () => {
    // Not a reason to skip the comparison — a value that cannot be compared would
    // silently retire the check above, which is the same class of defect.
    for (const bad of ['', '0', 'agent', '10.5']) {
      const result = await grant([socketPath, DISTINCT_AGENT_UID, bad, RUNNER_GID], {
        VERITY_CONTROL_PLANE_RUNNER_DOCKER: '0',
      });
      expect(result.code, bad).toBe(2);
    }
  });

  it('skips a socket whose group cannot be a grant', async () => {
    // Nothing is a member of group root, so gid 0 is not a grant; saying so once
    // beats leaving a silent EACCES for the agent to misdiagnose as a missing
    // daemon. Driven through a stubbed `stat`, since the test cannot chgrp.
    const stubDir = mkdtempSync(join(tmpdir(), 'verity-docker-grant-stat-'));
    try {
      const { writeFileSync, chmodSync } = await import('node:fs');
      const stub = join(stubDir, 'stat');
      writeFileSync(stub, '#!/usr/bin/env bash\necho 0\n');
      chmodSync(stub, 0o755);
      const result = await grant([socketPath, DISTINCT_AGENT_UID, DISTINCT_AGENT_GID, RUNNER_GID], {
        PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr).toContain('no usable group');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
