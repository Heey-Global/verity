import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_MANAGED_SERVER_ENVIRONMENT } from './managed-server-owner.js';

const root = resolve(import.meta.dirname, '../../../..');

describe('managed Compose ownership topology', () => {
  it('keeps managed infrastructure opt-in and removes the legacy Server in the overlay', async () => {
    const base = await readFile(resolve(root, 'deploy/docker-compose.yml'), 'utf8');
    const overlay = await readFile(resolve(root, 'deploy/docker-compose.managed.yml'), 'utf8');
    expect(base).toMatch(/verity-managed-gateway:\n\s+profiles: \[managed\]/);
    expect(base).toMatch(/verity-updater:\n\s+profiles: \[managed\]/);
    expect(overlay).toMatch(/verity:\n\s+profiles: \[legacy\]/);
  });

  it('leaves the control-plane Runner to the managed Server, not to Compose', async () => {
    // Both Runners mount `verity-control-runner-runtime` and the supervisor
    // claims a lock inside it with an flock that spans containers — on purpose,
    // so a second supervisor cannot start. So these two are not redundant, they
    // are mutually exclusive: the loser crash-loops on "runner supervisor is
    // already claimed" for as long as it exists. `verity-compose managed-up`
    // runs `--profile managed up -d` with no service list, so anything without a
    // profile is recreated on every converge — which is how the dev-server got
    // to 91 restarts and climbing while the managed Runner held the lock.
    //
    // The overlay used to keep this service and merely re-point its `depends_on`
    // at the managed gateway. That predates the Server taking ownership (see
    // managed-control-plane-runner.ts, "deliberately takes ownership away from
    // Compose"), and re-ordering cannot resolve an exclusive lock — one of the
    // two has to be gated out.
    const overlay = await readFile(resolve(root, 'deploy/docker-compose.managed.yml'), 'utf8');
    expect(overlay).toMatch(/verity-control-runner:\n\s+profiles: \[legacy\]/);
    expect(overlay).toMatch(/verity-control-runner-init:\n\s+profiles: \[legacy\]/);
    // A `depends_on` re-wiring here would mean the service is still in the
    // managed profile — the exact shape of the bug.
    expect(overlay).not.toMatch(/verity-control-runner:\n\s+depends_on:/);
  });

  it('gives the Gateway the public identity and only the Updater Docker authority', async () => {
    const compose = await readFile(resolve(root, 'deploy/docker-compose.yml'), 'utf8');
    const gateway = compose.slice(
      compose.indexOf('  verity-managed-gateway:'),
      compose.indexOf('  verity-updater:'),
    );
    const updater = compose.slice(
      compose.indexOf('  verity-updater:'),
      compose.indexOf('  # OPT-IN HARDENING:'),
    );
    expect(gateway).toContain("'${VERITY_API_HOST_PORT:-8082}:8082'");
    expect(gateway).toContain('aliases: [verity]');
    expect(gateway).not.toContain('docker.sock');
    expect(gateway).not.toContain('DATABASE_URL');
    expect(updater).toContain('network_mode: none');
    expect(updater).toContain(':/var/run/docker.sock');
    expect(updater).toContain(
      'verity-managed-deployment:/var/lib/verity/updater/managed-deployment',
    );
    expect(updater).not.toMatch(/ports:|aliases:/);
  });

  /**
   * The bug this exists for cost a real migration.
   *
   * `managed-bootstrap` seals every `VERITY_*` in its own environment as an env
   * SOURCE on the spec, minus a documented list of bootstrap inputs. The Updater
   * then has to resolve every one of those sources on every reconcile — out of its
   * own environment. `VERITY_RUNNER_RUNTIME_GID` was set on the bootstrap service,
   * absent from both the exclusion list and the Updater, and the result was
   * `managed Server environment source is missing: VERITY_RUNNER_RUNTIME_GID` on a
   * crash-looping Updater, a managed Gateway that never got a backend, and a
   * `managed-up` that rolled the deployment back after readiness timed out.
   *
   * Compared as OWN keys on both services: they merge the same
   * `&verity-server-environment` anchor, so anything in it is available to both and
   * cancels out — except where a service also sets it explicitly, which is why the
   * anchor's keys are subtracted rather than ignored.
   */
  it('leaves the Updater able to resolve every env source the bootstrap seals', async () => {
    const compose = await readFile(resolve(root, 'deploy/docker-compose.yml'), 'utf8');
    const slice = (from: string, to: string): string => {
      const start = compose.indexOf(from);
      expect(
        start,
        `docker-compose.yml no longer contains ${JSON.stringify(from)}`,
      ).toBeGreaterThan(-1);
      const end = compose.indexOf(to, start + from.length);
      expect(
        end,
        `${JSON.stringify(from)} is no longer followed by ${JSON.stringify(to)}`,
      ).toBeGreaterThan(start);
      return compose.slice(start, end);
    };
    const envKeys = (block: string): string[] => [
      ...new Set(
        [...block.matchAll(/^\s{6}((?:VERITY|CODEX)_[A-Z0-9_]+):/gm)].map(
          (match) => match[1] as string,
        ),
      ),
    ];

    const anchor = envKeys(slice('    environment: &verity-server-environment', '\n  verity-'));
    const bootstrap = envKeys(slice('\n  managed-bootstrap:', '\n  verity-managed-gateway:'));
    const updater = envKeys(slice('\n  verity-updater:', '\n  # OPT-IN HARDENING:'));

    // Read out of the source, not restated here. A hand-kept copy would leave this
    // guard blind in one direction — drop a name from the list in
    // `managed-bootstrap.ts` and the stale copy here still excuses it, which is the
    // shape of the outage above with the roles reversed.
    const source = await readFile(resolve(import.meta.dirname, 'managed-bootstrap.ts'), 'utf8');
    const excluded = /!\[([\s\S]*?)\]\.includes\(name\)/.exec(source)?.[1] ?? '';
    const bootstrapInputs = new Set(
      [...excluded.matchAll(/'(VERITY_[A-Z0-9_]+)'/g)].map((match) => match[1] as string),
    );
    expect(
      bootstrapInputs.size,
      'could not read the bootstrap-input exclusion list out of managed-bootstrap.ts',
    ).toBeGreaterThan(0);

    const mustResolve = bootstrap.filter(
      (name) => !bootstrapInputs.has(name) && !anchor.includes(name),
    );
    expect(mustResolve.length).toBeGreaterThan(0);
    for (const name of mustResolve) expect(updater).toContain(name);
  });

  it('forwards the configured Runner GID through every managed generation', async () => {
    const compose = await readFile(resolve(root, 'deploy/docker-compose.yml'), 'utf8');
    const anchor = compose.slice(
      compose.indexOf('environment: &verity-server-environment'),
      compose.indexOf('\n    volumes:'),
    );
    const updater = compose.slice(
      compose.indexOf('\n  verity-updater:'),
      compose.indexOf('  # OPT-IN HARDENING:'),
    );
    expect(anchor).toMatch(/^ {6}VERITY_RUNNER_RUNTIME_GID:/m);
    expect(updater).toMatch(/^ {6}VERITY_RUNNER_RUNTIME_GID:/m);

    const source = await readFile(resolve(import.meta.dirname, 'managed-bootstrap.ts'), 'utf8');
    const excluded = /!\[([\s\S]*?)\]\.includes\(name\)/.exec(source)?.[1] ?? '';
    expect(excluded).not.toContain("'VERITY_RUNNER_RUNTIME_GID'");
  });

  /**
   * The one thing that can go wrong with a recorded list of names the Updater will
   * build the Server WITHOUT: a name landing on it that the deployment still
   * supplies and the Server still reads. Then a genuine misconfiguration stops
   * being refused and the Server runs on defaults instead — the failure mode the
   * list exists to avoid, arrived at from the other side. Nothing infers
   * retirement, so it can only be checked against the two things that decide it:
   * the Compose file that says what a deployment supplies, here, and the shipped
   * source that says what the Server reads, in the test below.
   */
  it('never retires a variable the Compose server environment still supplies', async () => {
    const compose = await readFile(resolve(root, 'deploy/docker-compose.yml'), 'utf8');
    const server = compose.slice(
      compose.indexOf('environment: &verity-server-environment'),
      compose.indexOf('\n    volumes:'),
    );
    expect(server).toMatch(/^ {6}VERITY_PARAKEET_BASE_URL:/m);

    expect(RETIRED_MANAGED_SERVER_ENVIRONMENT.length).toBeGreaterThan(0);
    for (const name of RETIRED_MANAGED_SERVER_ENVIRONMENT) {
      expect(server, `${name} is retired but still set on the Server`).not.toMatch(
        new RegExp(`^ {6}${name}:`, 'm'),
      );
    }
  });

  /**
   * The half the Compose guard cannot see. Absent from Compose only says a current
   * deployment does not supply the variable; it says nothing about whether the code
   * still wants it. Retiring a name the Server still reads would make the Updater
   * omit configuration the Server needs and start it anyway — quietly, because the
   * refusal that used to be loud is exactly what this change removes.
   *
   * A whole-source scan rather than an "active variable" list, because a second
   * hand-kept list would need the same guard again. The declaration itself is the
   * record, not a use, so only that one file is exempt; a test may keep naming a
   * retired variable to assert it stayed gone.
   */
  it('never retires a variable the shipped Server still reads', async () => {
    const packages = resolve(root, 'packages');
    const entries = await readdir(packages, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter(
        (path) =>
          !path.includes('/node_modules/') &&
          !path.includes('/dist/') &&
          !/\.test\.tsx?$/.test(path) &&
          !path.endsWith('/self-update/managed-server-owner.ts'),
      );
    // Guards the scan itself: a filter that matched nothing would pass silently.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(resolve(packages, 'server/src/server.ts'));

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const name of RETIRED_MANAGED_SERVER_ENVIRONMENT) {
        if (source.includes(name)) offenders.push(`${name} in ${relative(root, file)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The bridge, and why it is not redundant with the list it mirrors.
   *
   * The list travels in the Server IMAGE, so it only helps an Updater that has
   * already been replaced — and the Updater this fixes cannot replace itself,
   * because resolving the missing source is what it dies doing. This file travels
   * in the operator's CHECKOUT, which reaches a host without a release and without
   * the updater working, so an empty value here is what lets that Updater start at
   * all. One half unblocks the host, the other keeps it unblocked.
   *
   * Driven off the list rather than a second hand-kept array, so a future
   * retirement cannot land with only one of the two halves. When the bridge is
   * eventually dropped — once no Updater image predates the list — this test goes
   * with it, deliberately and in the same commit.
   *
   * The form is pinned, not just the presence. `${NAME:-}` carries both halves the
   * bridge needs and a bare `''` carries only one: it defaults to empty, so a fresh
   * install is unchanged, AND it stays overridable, so a host whose running Server
   * predates the retirement can pin the value that Server was created with. That
   * host cannot converge any other way — `reconcileManagedServer` refuses a
   * mismatched container and never recreates it — so hardcoding either value here
   * would wedge one of the two populations. Asserting the exact interpolation is
   * what stops a future edit from quietly collapsing it back to a literal.
   */
  it('gives every retired source an overridable, empty-by-default Updater value the Server never sees', async () => {
    const compose = await readFile(resolve(root, 'deploy/docker-compose.yml'), 'utf8');
    const server = compose.slice(
      compose.indexOf('environment: &verity-server-environment'),
      compose.indexOf('\n    volumes:'),
    );
    const updater = compose.slice(
      compose.indexOf('\n  verity-updater:'),
      compose.indexOf('  # OPT-IN HARDENING:'),
    );
    // The Updater block is a different slice from the Server block, which is the
    // whole reason the bridge does not collide with the guard above: `server` says
    // what a current deployment gives the Server, `updater` says what an old seal
    // can still resolve. Assert they really are distinct before relying on it.
    expect(updater).toMatch(/^ {6}VERITY_UPDATER_TOKEN_FILE:/m);
    expect(server).not.toMatch(/^ {6}VERITY_UPDATER_TOKEN_FILE:/m);
    const retired = RETIRED_MANAGED_SERVER_ENVIRONMENT;
    expect(retired.length).toBeGreaterThan(0);

    for (const name of retired) {
      expect(server).not.toMatch(new RegExp(`^ {6}${name}:`, 'm'));
      expect(updater).toMatch(new RegExp(`^ {6}${name}: \\$\\{${name}:-\\}$`, 'm'));
    }
  });
});
