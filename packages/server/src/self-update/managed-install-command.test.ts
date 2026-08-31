import { execFile, spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// `unshare -r` is how the installer suite reaches uid 0. Containers that withhold
// unprivileged user namespaces (the default Docker seccomp profile does, and the
// shared self-hosted CI runners are such containers) cannot run it at all, which is
// why CI's copy lives in the GitHub-hosted `installer` job instead of this one.
const canFakeRoot = spawnSync('unshare', ['-r', 'true']).status === 0;

// `deploy/bin/verity-install` is the host-side entry point that seals a managed
// deployment and then hands over to the guarded `verity-compose managed-up`
// migration. Its own behaviour suite is a node:test file, because it drives the
// real script under `unshare -r` rather than importing anything. This file asserts
// the contract that suite cannot see — the handover, and the CI wiring that runs it
// — and re-runs the suite itself wherever the namespace is available, so a developer
// running `npm test` still gets the finding before pushing.
describe('verity-install', () => {
  it('is an executable, syntactically valid shell script', async () => {
    const info = await stat('deploy/bin/verity-install');
    expect(info.mode & 0o111).not.toBe(0);

    await expect(execFileAsync('bash', ['-n', 'deploy/bin/verity-install'])).resolves.toMatchObject(
      { stderr: '' },
    );
  });

  it('hands the sealed inputs to the guarded migration rather than reimplementing it', async () => {
    const script = await readFile('deploy/bin/verity-install', 'utf8');

    // The installer must never start the managed Server itself: sealing, identity
    // conflict refusal and rollback all live in verity-compose managed-up.
    expect(script).toContain('./deploy/bin/verity-compose managed-up');
    expect(script).toContain('VERITY_MANAGED_DEPLOYMENT_ID');
    expect(script).toContain('VERITY_UPDATER_TOKEN_HOST_PATH');
    // A tag would let the sealed spec drift under the operator; only digests.
    expect(script).toContain('digest-pinned');
  });

  it('is wired into the CI changed-area detector and its own job', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('deploy/bin/verity-install|deploy/bin/verity-install.test.mjs');
    // The suite needs a user namespace the sharded `test` job cannot create, so the
    // `installer` job is the only place CI runs it — and the gate entry is what keeps
    // that job mandatory rather than decorative. The invocation is asserted without
    // its `run:` prefix because the job no longer runs it on the runner at all: it
    // starts a `seccomp=unconfined` container and runs it in there, so the command is
    // the tail of a `docker run` line. That the container is the right shape is
    // scripts/ci-workflow.test.ts's business; this only cares that the suite runs.
    expect(workflow).toContain('node --test deploy/bin/verity-install.test.mjs');
    expect(workflow).toContain('require_when_changed installer');
  });

  it.skipIf(!canFakeRoot)(
    'passes its behaviour suite',
    async () => {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync('node', [
          '--test',
          'deploy/bin/verity-install.test.mjs',
        ]));
      } catch (error) {
        // execFile's own message is "Command failed: node --test …" and nothing else,
        // which names no failing case. The child's report is the whole diagnosis.
        const failed = error as { stdout?: string; stderr?: string };
        throw new Error(`node --test failed:\n${failed.stdout ?? ''}${failed.stderr ?? ''}`, {
          cause: error,
        });
      }

      expect(stdout).toMatch(/fail 0$/m);
      // A suite that silently stopped registering cases still reports `fail 0`, so
      // the report has to be held against what the file declares. That used to be a
      // pinned total, which cannot survive here: it said 34 from #1474 until #1479
      // added a case without bumping it, and no CI job could report the drift — the
      // shared runners withhold the namespace, so `skipIf` above skips this test
      // there, and the GitHub-hosted `installer` job runs `node --test` directly with
      // nothing to compare against. The stale number only ever fired on a developer's
      // machine, as a false red.
      //
      // Names rather than a total: every case the file declares must appear as a
      // PASSING one in the report, which catches registration that stopped partway,
      // a case turned into `test.skip`, and one that ran without passing. A case
      // deleted outright leaves both sides, and no self-derived check can see that —
      // but a deletion is a visible diff, which is review's job, not this guard's.
      const suite = await readFile('deploy/bin/verity-install.test.mjs', 'utf8');
      // Up to the `if (!canFakeRoot)` fallback, which by definition does not register
      // on a host that got far enough to reach this assertion.
      const body = suite.slice(0, suite.indexOf('if (!canFakeRoot)'));
      // `.skip`/`.todo` counts as declared too: a case parked that way still reads as
      // coverage of the installer's privileged behaviour without being any, and the
      // suite's own fallback refuses a green run on that same ground.
      const declared = [...body.matchAll(/^\s*test(?:\.\w+)?\('([^']+)'/gm)].map(
        (match) => match[1] as string,
      );

      // Reading names takes one spelling — single-quoted, on the registration's own
      // line. Every other spelling a registration could take (double quotes, a
      // template literal, a wrapped call) would drop out of `declared` and be waved
      // through as if it had run, so the two counts have to agree: an unreadable
      // registration is a hard failure here, not a quiet hole in "every declared case".
      const registrations = [...body.matchAll(/^\s*test\b/gm)].length;
      expect(registrations, 'could not read the declared cases out of the suite').toBeGreaterThan(
        30,
      );
      expect(
        declared.length,
        'a case is registered in a form this guard cannot read — keep the single-quoted ' +
          "`test('name', …)` spelling, or widen the pattern above with it",
      ).toBe(registrations);

      for (const name of declared) expect(stdout).toContain(`✔ ${name}`);
    },
    60_000,
  );
});
