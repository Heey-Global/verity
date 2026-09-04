// Behaviour tests for deploy/bin/verity-install.
//
// The installer is a privileged shell script whose decisions are all reads of host
// state, so these run the real script rather than a re-implementation of it. Two
// things stand in for the host:
//
//   - `unshare -r` maps the caller to uid 0 in a private user namespace, so the root
//     check, `install -d -o root` and the `stat` ownership checks see what they would
//     see on a real host. No test-only escape hatch is compiled into the script.
//   - a stub `docker` on PATH answers each query from a fixture, and a stub
//     `verity-compose` records the environment it was handed instead of migrating.
//
// What is deliberately NOT covered: the migration itself. `verity-compose managed-up`
// needs a real daemon, and that path is exercised by the Docker-in-Docker smoke in
// .github/workflows/self-update.yml.
//
// CI runs this from the `installer` job in .github/workflows/ci.yml, not from the
// sharded Vitest job: the runner containers carry Docker's default seccomp profile,
// which withholds unprivileged user namespaces, so `unshare -r` fails there and
// every case below would skip. That job does not run this suite on the runner
// either — it starts a throwaway container with `seccomp=unconfined` and runs it in
// there, so the exemption is scoped to this suite instead of granted to every job on
// the pool.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const DIGEST_A = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const DIGEST_B = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;

const userNamespaces = spawnSync('unshare', ['-r', 'true']);
const canFakeRoot = userNamespaces.status === 0;

/** Wraps a fixture value in single quotes so it can never break out of the stub. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

const workspaces = [];
after(() => {
  for (const dir of workspaces) spawnSync('rm', ['-rf', dir]);
});

/**
 * A throwaway host: a checkout containing the real installer, a state directory,
 * and stub executables that shadow the real docker/verity-compose.
 *
 * `docker` is answered from a table keyed by a substring of the argv, so a fixture
 * only has to describe the queries it cares about; anything unmatched answers empty.
 */
function makeHost({ docker = [], state = {} } = {}) {
  // Canonical, because the installer refuses a state directory whose path is not:
  // a symlinked TMPDIR would otherwise fail every case here for the wrong reason.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verity-install-')));
  workspaces.push(root);
  const checkout = join(root, 'checkout');
  const binDir = join(checkout, 'deploy', 'bin');
  const stubDir = join(root, 'stub');
  const stateDir = join(root, 'state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(join(binDir, 'verity-install'), readFileSync(join(here, 'verity-install')));
  chmodSync(join(binDir, 'verity-install'), 0o755);
  const pairingHandoff = join(root, 'pairing.env');
  // Pairing material has its own tests against the real OpenSSL implementation.
  // This installer suite runs in a deliberately minimal, network-isolated Node
  // image, so keep its fixture focused on the installer's handoff contract rather
  // than making every host-state scenario depend on OpenSSL being in that image.
  writeFileSync(
    join(binDir, 'verity-pairing-material'),
    `#!/usr/bin/env bash\nset -euo pipefail\n` +
      `state_dir="\${VERITY_STATE_DIR:?}"\n` +
      `printf 'VERITY_STATE_DIR=%s\\nVERITY_API_HOST_PORT=%s\\nVERITY_PAIRING_HOST=%s\\nVERITY_SERVER_UID=%s\\nVERITY_SERVER_GID=%s\\n' "$state_dir" "\${VERITY_API_HOST_PORT:?}" "\${VERITY_PAIRING_HOST-}" "\${VERITY_SERVER_UID:?}" "\${VERITY_SERVER_GID:?}" >${JSON.stringify(pairingHandoff)}\n` +
      `chmod 0711 "$state_dir"\n` +
      `printf '%s' 'test-identity' >"$state_dir/pairing-identity.pem"\n` +
      `printf '%s' 'test-key' >"$state_dir/tls-key.pem"\n` +
      `printf '%s' 'test-cert' >"$state_dir/tls-cert.pem"\n` +
      `printf '%s' 'test-code' >"$state_dir/pairing-code"\n` +
      `printf '%s' '2099-01-01T00:00:00.000Z' >"$state_dir/pairing-expires-at"\n` +
      `printf '%s' 'verity://pair?payload=test' >"$state_dir/pairing-uri"\n` +
      `chmod 0600 "$state_dir"/pairing-identity.pem "$state_dir"/tls-key.pem "$state_dir"/pairing-code "$state_dir"/pairing-expires-at "$state_dir"/pairing-uri\n` +
      `chmod 0644 "$state_dir/tls-cert.pem"\n` +
      `printf '%s\\n' 'verity://pair?payload=test'\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(checkout, 'deploy', 'docker-compose.yml'), 'services: {}\n');

  // Records the handover instead of performing it, so a test can assert on exactly
  // the variables verity-compose would have been given.
  const handover = join(root, 'handover.env');
  writeFileSync(
    join(binDir, 'verity-compose'),
    `#!/usr/bin/env bash\n{\n` +
      `  printf 'argv=%s\\n' "$*"\n` +
      `  for v in VERITY_SERVER_IMAGE VERITY_MANAGED_DEPLOYMENT_ID VERITY_UPDATER_TOKEN_HOST_PATH VERITY_RUNNER_SUPERVISOR VERITY_GVISOR_REQUIRED VERITY_PAIRING_STATE_HOST_PATH VERITY_POSTGRES_PASSWORD COMPOSE_PROJECT_NAME; do\n` +
      `    printf '%s=%s\\n' "$v" "\${!v-}"\n` +
      `  done\n} > ${JSON.stringify(handover)}\n`,
    { mode: 0o755 },
  );

  // One branch per fixture, matched as a substring of the joined argv. Written out as
  // literal shell rather than a table parsed at runtime, so a fixture stays readable in
  // the generated stub and cannot be mangled by quoting.
  const branches = docker
    .map(
      ({ match, out = '', status = 0 }) =>
        `if [[ $argv == *${shellQuote(match)}* ]]; then\n` +
        (out === '' ? '' : `  printf '%s\\n' ${shellQuote(out)}\n`) +
        `  exit ${status}\nfi\n`,
    )
    .join('');
  writeFileSync(
    join(stubDir, 'docker'),
    `#!/usr/bin/env bash\nargv="$*"\n` +
      `if [[ $argv == version* ]]; then echo '27.1.0'; exit 0; fi\n` +
      branches +
      `if [[ $argv == ps*label=com.docker.compose.service=postgres* ]]; then echo 'verity-postgres-1'; exit 0; fi\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );

  for (const [name, contents] of Object.entries(state)) {
    writeFileSync(join(stateDir, name), contents);
  }

  return { root, checkout, stateDir, stubDir, handover, pairingHandoff, binDir };
}

function run(host, args = [], env = {}) {
  const result = spawnSync('unshare', ['-r', join(host.binDir, 'verity-install'), ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${host.stubDir}:${process.env.PATH}`,
      HOME: host.root,
      VERITY_STATE_DIR: host.stateDir,
      // The fake root user namespace maps only uid/gid 0. Production defaults
      // to the Server image's 1000:1000 identity.
      VERITY_SERVER_UID: '0',
      VERITY_SERVER_GID: '0',
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function handoverEnv(host) {
  const parsed = {};
  for (const line of readFileSync(host.handover, 'utf8').trim().split('\n')) {
    const at = line.indexOf('=');
    parsed[line.slice(0, at)] = line.slice(at + 1);
  }
  return parsed;
}

function stateFile(host, name) {
  return readFileSync(join(host.stateDir, name), 'utf8').trim();
}

/**
 * `docker ps` fixtures in the shape the installer asks for: one `name<TAB>id` row per
 * container. `rows` are all containers on the host; `running: false` keeps a row out
 * of the `docker ps` answer while leaving it in `docker ps -a`.
 */
const managedPs = (rows) => {
  const render = (subset) => subset.map((r) => `${r.name}\t${r.id ?? ''}`).join('\n');
  return [
    {
      match: 'ps --filter name=^/verity-managed-server',
      out: render(rows.filter((r) => r.running !== false)),
    },
    { match: 'ps -a --filter name=^/verity-managed-server', out: render(rows) },
  ];
};

/**
 * The Compose-project lookup answer. A managed host no longer runs the legacy
 * `verity` service — the migration removes it as an orphan — so the project name
 * comes off the control plane.
 */
const composeProject = (project = 'verity', service = 'verity-managed-gateway') => ({
  match: 'ps -a --filter label=com.docker.compose.project',
  out: `${service}\t${project}`,
});

const runningServer = (name, id, caps = '[]', image = DIGEST_A) => [
  ...managedPs([{ name, id }]),
  composeProject(),
  { match: `inspect --format {{.Config.Image}}`, out: image },
  { match: `inspect --format {{json .HostConfig.CapAdd}}`, out: caps },
  { match: 'volume ls --quiet', out: 'verity-managed-deployment' },
];

describe('verity-install', { skip: canFakeRoot ? false : 'user namespaces unavailable' }, () => {
  test('refuses to run unprivileged', () => {
    const host = makeHost();
    const result = spawnSync(join(host.binDir, 'verity-install'), ['--check'], {
      encoding: 'utf8',
      env: { PATH: `${host.stubDir}:${process.env.PATH}`, VERITY_STATE_DIR: host.stateDir },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must run as root/);
  });

  test('rejects an unknown argument and a tag as --image', () => {
    const host = makeHost();
    assert.match(run(host, ['--bogus']).stderr, /unknown argument/);
    assert.match(
      run(host, ['--image', 'ghcr.io/heey-global/verity/verity-server:latest']).stderr,
      /digest-pinned/,
    );
  });

  test('refuses a host without the Compose v2 plugin before anything is written', () => {
    const host = makeHost({
      docker: [
        { match: 'compose version', status: 1 },
        { match: 'image inspect', out: DIGEST_A },
      ],
    });
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Docker Compose v2 plugin is required/);
    assert.throws(() => stateFile(host, 'deployment-id'));
    assert.throws(() => readFileSync(host.handover));
  });

  test('--check changes nothing and does not resolve an image', () => {
    const host = makeHost();
    const result = run(host, ['--check']);
    assert.equal(result.status, 0);
    assert.match(result.output, /mode +first install/);
    assert.match(result.output, /nothing was changed/);
    assert.throws(() => stateFile(host, 'deployment-id'));
    assert.throws(() => readFileSync(host.handover));
  });

  test('first install generates state and hands it to the migration', () => {
    const host = makeHost({
      docker: [{ match: 'image inspect', out: DIGEST_A }],
    });
    const result = run(host, [], { VERITY_RUNNER_SUPERVISOR: '1' });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Pairing code \(copy all\): verity:\/\/pair\?payload=test/);
    assert.match(stateFile(host, 'updater-token'), /^[a-f0-9]{64}$/);
    assert.equal(readFileSync(join(host.stateDir, 'updater-token'), 'utf8').length, 64);
    assert.equal(stateFile(host, 'compose-project'), 'verity');
    assert.equal(stateFile(host, 'runner-supervisor'), '1');
    assert.match(stateFile(host, 'postgres-password'), /^[a-f0-9]{64}$/);
    assert.equal(statSync(join(host.stateDir, 'postgres-password')).mode & 0o777, 0o600);

    const env = handoverEnv(host);
    assert.equal(env.argv, 'managed-up');
    assert.equal(env.VERITY_SERVER_IMAGE, DIGEST_A);
    assert.equal(env.VERITY_RUNNER_SUPERVISOR, '1');
    assert.equal(env.VERITY_POSTGRES_PASSWORD, stateFile(host, 'postgres-password'));
    assert.equal(env.COMPOSE_PROJECT_NAME, 'verity');
    const pairingEnv = Object.fromEntries(
      readFileSync(host.pairingHandoff, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=', 2)),
    );
    assert.deepEqual(
      { ...pairingEnv, VERITY_PAIRING_HOST: undefined },
      {
        VERITY_STATE_DIR: host.stateDir,
        VERITY_API_HOST_PORT: '8082',
        VERITY_PAIRING_HOST: undefined,
        VERITY_SERVER_UID: '0',
        VERITY_SERVER_GID: '0',
      },
    );
    // No controlling terminal means the pairing-material helper performs its
    // own automatic interface detection instead of attempting to prompt.
    assert.equal(pairingEnv.VERITY_PAIRING_HOST, '');
    assert.equal(env.VERITY_MANAGED_DEPLOYMENT_ID, stateFile(host, 'deployment-id'));
    assert.match(env.VERITY_MANAGED_DEPLOYMENT_ID, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });

  test('forwards an automated DNS selection to pairing material', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const result = run(host, [], { VERITY_PAIRING_HOST: 'verity.home.example' });
    assert.equal(result.status, 0, result.output);
    const pairingEnv = Object.fromEntries(
      readFileSync(host.pairingHandoff, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=', 2)),
    );
    assert.equal(pairingEnv.VERITY_PAIRING_HOST, 'verity.home.example');
  });

  test('fresh installs seal the ACP Runner supervisor by default', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const result = run(host, []);
    assert.equal(result.status, 0, result.output);
    assert.equal(stateFile(host, 'runner-supervisor'), '1');
    assert.equal(handoverEnv(host).VERITY_RUNNER_SUPERVISOR, '1');
  });

  test('normalises a non-numeric supervisor flag before sealing', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    assert.equal(run(host, [], { VERITY_RUNNER_SUPERVISOR: 'true' }).status, 0);
    // managed-bootstrap seals CHOWN on the literal '1' only.
    assert.equal(handoverEnv(host).VERITY_RUNNER_SUPERVISOR, '1');
  });

  test('rerun reuses persisted state and the running Server digest, not --tag', () => {
    const host = makeHost({
      docker: runningServer('verity-managed-server-g4', 'host-abc', '["CHOWN"]', DIGEST_B),
      state: {
        'deployment-id': 'host-abc\n',
        'compose-project': 'deploy\n',
        'runner-supervisor': '1\n',
        'gvisor-required': '1\n',
        'updater-token': 'f'.repeat(64),
      },
    });
    const result = run(host, []);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /mode +host-side upgrade/);

    const env = handoverEnv(host);
    assert.equal(env.VERITY_SERVER_IMAGE, DIGEST_B);
    assert.equal(env.VERITY_MANAGED_DEPLOYMENT_ID, 'host-abc');
    assert.equal(env.COMPOSE_PROJECT_NAME, 'deploy');
    // The finding this covers: a no-argument rerun used to reset the supervisor to 0.
    assert.equal(env.VERITY_RUNNER_SUPERVISOR, '1');
    // Same failure mode, different flag: dropping this one silently turns off the
    // brokered-secret runtime requirement, and the migration never objects.
    assert.equal(env.VERITY_GVISOR_REQUIRED, '1');
    assert.equal(stateFile(host, 'updater-token'), 'f'.repeat(64));
  });

  test('reuses the persisted PostgreSQL credential and rejects malformed state', () => {
    const password = 'a'.repeat(64);
    const host = makeHost({
      docker: [{ match: 'image inspect', out: DIGEST_A }],
      state: { 'postgres-password': `${password}\n` },
    });
    const result = run(host);
    assert.equal(result.status, 0, result.output);
    assert.equal(handoverEnv(host).VERITY_POSTGRES_PASSWORD, password);
    assert.equal(stateFile(host, 'postgres-password'), password);

    writeFileSync(join(host.stateDir, 'postgres-password'), 'not-a-password\n');
    const refused = run(host, ['--image', DIGEST_A]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /postgres-password is malformed/);
  });

  test('fails closed when the post-migration PostgreSQL container is ambiguous', () => {
    const host = makeHost({
      docker: [
        { match: 'image inspect', out: DIGEST_A },
        {
          match:
            'ps --filter label=com.docker.compose.project=verity --filter label=com.docker.compose.service=postgres',
          out: 'verity-postgres-1\nverity-postgres-2',
        },
      ],
    });
    const result = run(host);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected exactly one running PostgreSQL container.*found 2/);
  });

  test('fails closed when PostgreSQL discovery errors after managed-up', () => {
    const host = makeHost({
      docker: [
        { match: 'image inspect', out: DIGEST_A },
        {
          match:
            'ps --filter label=com.docker.compose.project=verity --filter label=com.docker.compose.service=postgres',
          status: 1,
        },
      ],
    });
    const result = run(host);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not ask Docker for the Compose PostgreSQL container/);
  });

  test('persists the gVisor requirement and reports a change to it', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    assert.equal(run(host, [], { VERITY_GVISOR_REQUIRED: 'yes' }).status, 0);
    assert.equal(stateFile(host, 'gvisor-required'), '1');
    assert.equal(handoverEnv(host).VERITY_GVISOR_REQUIRED, '1');

    // Reversible, unlike the sealed supervisor capability — but never silently.
    // --image because the deployment is sealed now and no container is left to read
    // the digest off; see the refusal covered below.
    const off = run(host, ['--image', DIGEST_A], { VERITY_GVISOR_REQUIRED: '0' });
    assert.match(off.output, /gVisor requirement changes from 1 to 0/);
    assert.equal(stateFile(host, 'gvisor-required'), '0');
  });

  test('recovers identity and image from a stopped Server when state is gone', () => {
    const host = makeHost({
      docker: [
        ...managedPs([{ name: 'verity-managed-server-g2', id: 'sealed-id', running: false }]),
        composeProject(),
        { match: 'inspect --format {{.Config.Image}}', out: DIGEST_B },
        { match: 'inspect --format {{json .HostConfig.CapAdd}}', out: '[]' },
        { match: 'volume ls --quiet', out: 'verity-managed-deployment' },
      ],
    });
    const result = run(host, []);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /image source +stopped verity-managed-server-g2/);
    const env = handoverEnv(host);
    assert.equal(env.VERITY_MANAGED_DEPLOYMENT_ID, 'sealed-id');
    assert.equal(env.VERITY_SERVER_IMAGE, DIGEST_B);
  });

  test('refuses to invent an identity for a sealed deployment it cannot recover', () => {
    const host = makeHost({
      docker: [{ match: 'volume ls --quiet', out: 'verity-managed-deployment' }],
    });
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no deployment identity left to recover/);
    assert.throws(() => stateFile(host, 'deployment-id'));
  });

  test('refuses to resolve a tag for a sealed deployment with no container left', () => {
    // The sealed spec pins a digest and bootstrap compares VERITY_SERVER_IMAGE
    // against it, so resolving `latest` here would look like recovery and then fail
    // inside the migration.
    const host = makeHost({
      docker: [
        { match: 'volume ls --quiet', out: 'verity-managed-deployment' },
        composeProject(),
        { match: 'image inspect', out: DIGEST_A },
      ],
      state: { 'deployment-id': 'sealed-id\n', 'updater-token': 'f'.repeat(64) },
    });
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pass --image with the digest this deployment was sealed at/);
    assert.throws(() => readFileSync(host.handover));

    // ...and --image is the documented way out of it.
    assert.equal(run(host, ['--image', DIGEST_B]).status, 0);
    assert.equal(handoverEnv(host).VERITY_SERVER_IMAGE, DIGEST_B);
  });

  test('ignores a container that merely shares the managed Server name prefix', () => {
    // Managed mode names the Server `verity-managed-server` or `-g<generation>` and
    // nothing else, so an operator's own container must not supply an identity, an
    // image, or a second entry that reads as a mid-flight cutover.
    const host = makeHost({
      docker: [
        ...managedPs([
          { name: 'verity-managed-server-backup', id: 'not-ours' },
          { name: 'verity-managed-server-g0', id: 'not-ours' },
          // Past the bound managed-gateway.ts:84 puts on a routable generation, so
          // the Gateway would never route to it either.
          { name: 'verity-managed-server-g2147483648', id: 'not-ours' },
        ]),
        { match: 'image inspect', out: DIGEST_A },
      ],
    });
    const result = run(host, []);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /mode +first install/);
    assert.notEqual(handoverEnv(host).VERITY_MANAGED_DEPLOYMENT_ID, 'not-ours');
  });

  test('accepts the highest routable generation name', () => {
    const host = makeHost({
      docker: runningServer('verity-managed-server-g2147483647', 'sealed-id'),
    });
    const result = run(host, []);
    assert.equal(result.status, 0, result.output);
    assert.equal(handoverEnv(host).VERITY_MANAGED_DEPLOYMENT_ID, 'sealed-id');
  });

  test('refuses a mid-flight cutover', () => {
    const host = makeHost({
      docker: managedPs([
        { name: 'verity-managed-server-g4', id: 'x' },
        { name: 'verity-managed-server-g5', id: 'x' },
      ]),
    });
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /update is mid-flight/);
  });

  test('refuses a cutover whose previous generation is already stopped', () => {
    // The observation-window topology: the candidate runs while the old generation is
    // stopped but retained for rollback. Counting only running containers would let the
    // installer migrate the candidate out from under the Updater.
    const host = makeHost({
      docker: managedPs([
        { name: 'verity-managed-server-g5', id: 'x' },
        { name: 'verity-managed-server-g4', id: 'x', running: false },
      ]),
    });
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /update is mid-flight/);
    assert.match(result.stderr, /running: verity-managed-server-g5/);
  });

  test('adopts the Compose project of a managed host that predates the state file', () => {
    // The legacy `verity` service is gone after the migration, so the project name is
    // read off the control plane. Defaulting to `verity` here would stand a second
    // Postgres, Gateway and Updater up beside the running deployment.
    const host = makeHost({
      docker: [
        ...managedPs([{ name: 'verity-managed-server-g3', id: 'sealed-id' }]),
        composeProject('prod', 'verity-updater'),
        { match: 'inspect --format {{.Config.Image}}', out: DIGEST_A },
        { match: 'inspect --format {{json .HostConfig.CapAdd}}', out: '[]' },
        { match: 'volume ls --quiet', out: 'verity-managed-deployment' },
      ],
    });
    const result = run(host, []);
    assert.equal(result.status, 0, result.output);
    assert.equal(handoverEnv(host).COMPOSE_PROJECT_NAME, 'prod');
    assert.equal(stateFile(host, 'compose-project'), 'prod');
  });

  test('refuses a Compose project name Compose itself would reject', () => {
    // The name is persisted before the migration runs, so a typo `docker compose`
    // rejects would otherwise be written down as this host's project — and every
    // corrected run afterwards refused for contradicting it.
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const result = run(host, ['--project', 'Verity Prod']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--project says the Compose project is 'Verity Prod'/);
    assert.throws(() => stateFile(host, 'compose-project'));
    assert.throws(() => readFileSync(host.handover));

    // Same check for a name that only reaches this run through the state file, which
    // resolve_project returns without ever comparing it to an override.
    const edited = makeHost({
      docker: [{ match: 'image inspect', out: DIGEST_A }],
      state: { 'compose-project': 'Verity Prod\n' },
    });
    assert.match(run(edited, []).stderr, /resolved the Compose project name 'Verity Prod'/);
  });

  test('refuses an override that contradicts the running Compose project', () => {
    // No state file to compare against, so the running containers are the only
    // evidence there is — and a typo here is a second Postgres, Gateway and Server.
    const host = makeHost({
      docker: [
        ...managedPs([{ name: 'verity-managed-server-g3', id: 'sealed-id' }]),
        composeProject('prod', 'verity-updater'),
        { match: 'inspect --format {{.Config.Image}}', out: DIGEST_A },
        { match: 'inspect --format {{json .HostConfig.CapAdd}}', out: '[]' },
        { match: 'volume ls --quiet', out: 'verity-managed-deployment' },
      ],
    });
    assert.match(run(host, ['--project', 'prd']).stderr, /--project says the Compose project/);
    assert.match(
      run(host, [], { COMPOSE_PROJECT_NAME: 'prd' }).stderr,
      /COMPOSE_PROJECT_NAME says the Compose project/,
    );
    assert.throws(() => readFileSync(host.handover));

    // Naming the project that is actually there is accepted.
    assert.equal(run(host, ['--project', 'prod']).status, 0);
    assert.equal(handoverEnv(host).COMPOSE_PROJECT_NAME, 'prod');
  });

  test('refuses to guess a Compose project for a sealed deployment', () => {
    const host = makeHost({
      docker: [
        ...managedPs([{ name: 'verity-managed-server-g3', id: 'sealed-id' }]),
        { match: 'inspect --format {{.Config.Image}}', out: DIGEST_A },
        { match: 'inspect --format {{json .HostConfig.CapAdd}}', out: '[]' },
        { match: 'volume ls --quiet', out: 'verity-managed-deployment' },
      ],
    });
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no Compose-labelled Verity container left/);
    assert.throws(() => readFileSync(host.handover));

    assert.equal(run(host, ['--project', 'prod']).status, 0);
    assert.equal(handoverEnv(host).COMPOSE_PROJECT_NAME, 'prod');
  });

  test('refuses a Compose project that contradicts the persisted one', () => {
    const host = makeHost({ state: { 'compose-project': 'deploy\n' } });
    assert.match(run(host, ['--project', 'other']).stderr, /installed under 'deploy'/);
    assert.match(
      run(host, [], { COMPOSE_PROJECT_NAME: 'other' }).stderr,
      /installed under 'deploy'/,
    );
  });

  test('refuses a --deployment-id that contradicts the sealed one', () => {
    const host = makeHost({ state: { 'deployment-id': 'host-abc\n' } });
    const result = run(host, ['--deployment-id', 'something-else']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflicts with the identity/);
  });

  test('refuses to enable the supervisor against a spec sealed without CHOWN', () => {
    const host = makeHost({
      docker: runningServer('verity-managed-server-g4', 'host-abc', '[]'),
      state: { 'deployment-id': 'host-abc\n', 'runner-supervisor': '0\n' },
    });
    const result = run(host, [], { VERITY_RUNNER_SUPERVISOR: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be turned on/);
  });

  test('allows re-enabling the supervisor when the seal carries CHOWN', () => {
    const host = makeHost({
      docker: runningServer('verity-managed-server-g4', 'host-abc', '["CHOWN"]'),
      state: { 'deployment-id': 'host-abc\n', 'runner-supervisor': '0\n' },
    });
    const result = run(host, [], { VERITY_RUNNER_SUPERVISOR: '1' });
    assert.equal(result.status, 0, result.output);
    assert.equal(handoverEnv(host).VERITY_RUNNER_SUPERVISOR, '1');
    assert.equal(stateFile(host, 'runner-supervisor'), '1');
  });

  test('stops on a Docker query that errors instead of reading it as a fresh host', () => {
    // Named per query, so this cannot pass because some later call happened to fail.
    for (const [match, what] of [
      ['ps --filter name=^/verity-managed-server', 'the running managed Server'],
      ['ps -a --filter name=^/verity-managed-server', 'the managed Server containers'],
      ['volume ls --quiet', 'the managed-deployment volume'],
    ]) {
      const host = makeHost({
        docker: [
          { match, out: '', status: 1 },
          { match: 'image inspect', out: DIGEST_A },
        ],
      });
      const result = run(host, []);
      assert.equal(result.status, 1, `${match}: ${result.output}`);
      assert.match(result.stderr, new RegExp(`could not ask Docker for ${what}`));
      assert.throws(() => stateFile(host, 'deployment-id'));
      assert.throws(() => readFileSync(host.handover));
    }
  });

  test('retries a first install whose migration failed without demanding --image', () => {
    // State is written before the migration runs, so a failed first install leaves an
    // identity behind with nothing sealed. Treating that as an existing deployment
    // would refuse the retry for want of a digest this host has never had.
    const host = makeHost({
      docker: [{ match: 'image inspect', out: DIGEST_A }],
      state: { 'deployment-id': 'half-installed\n', 'updater-token': 'f'.repeat(64) },
    });
    const result = run(host, []);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /mode +first install/);
    assert.equal(handoverEnv(host).VERITY_MANAGED_DEPLOYMENT_ID, 'half-installed');
    assert.equal(handoverEnv(host).VERITY_SERVER_IMAGE, DIGEST_A);
  });

  test('refuses a symlinked state file rather than reading through it', () => {
    const host = makeHost();
    const secret = join(host.root, 'secret');
    writeFileSync(secret, 'not-an-identity\n');
    symlinkSync(secret, join(host.stateDir, 'deployment-id'));
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is a symlink/);
    assert.equal(readFileSync(secret, 'utf8'), 'not-an-identity\n');
  });

  test('refuses a symlinked control token rather than chowning its target', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const target = join(host.root, 'target');
    writeFileSync(target, 'x');
    symlinkSync(target, join(host.stateDir, 'updater-token'));
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is a symlink/);
    assert.equal(readFileSync(target, 'utf8'), 'x');
  });

  test('rejects a control token that is not 64 hex characters', () => {
    const host = makeHost({
      docker: [{ match: 'image inspect', out: DIGEST_A }],
      state: { 'updater-token': `${'a'.repeat(64)}\n` },
    });
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be exactly 64/);
  });

  test('refuses a symlinked lock instead of truncating what it points at', () => {
    // Opening the lock is a redirection, and a redirection follows the link and
    // truncates its target — as root, before any of the checks below it run.
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const victim = join(host.root, 'victim');
    writeFileSync(victim, 'keep me\n');
    symlinkSync(victim, join(host.stateDir, '.verity-install.lock'));

    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.verity-install\.lock is a symlink/);
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n');
    assert.throws(() => readFileSync(host.handover));
  });

  test('serialises concurrent runs on the state directory', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const lock = join(host.stateDir, '.verity-install.lock');
    writeFileSync(lock, '');
    // Inside the namespace, so the installer gets past the root check and actually
    // reaches the lock rather than refusing for an unrelated reason.
    const blocked = spawnSync(
      'unshare',
      [
        '-r',
        'bash',
        '-c',
        `exec 7>${JSON.stringify(lock)}; flock -n 7 && ${JSON.stringify(join(host.binDir, 'verity-install'))}`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: `${host.stubDir}:${process.env.PATH}`,
          HOME: host.root,
          VERITY_STATE_DIR: host.stateDir,
        },
      },
    );
    // The outer shell holds the lock, so the installer it runs must not take it.
    assert.equal(blocked.status, 1);
    assert.match(`${blocked.stdout}${blocked.stderr}`, /another verity-install is already running/);
    assert.throws(() => readFileSync(host.handover));

    // The same run without a holder gets through, so the refusal above is the lock.
    assert.equal(run(host, []).status, 0);
  });

  test('refuses a group-writable state directory', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    // 0720 leaves the last octal digit at 0, which a trailing-digit check misses —
    // and another user could then race the control token this script is about to
    // create there.
    chmodSync(host.stateDir, 0o720);
    assert.match(run(host, ['--check']).stderr, /group or world write access is rejected/);

    // An install run must refuse it too rather than repairing the mode: whoever
    // could write there could have planted the updater token this run would adopt.
    const result = run(host, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /group or world write access is rejected/);
    assert.equal(statSync(host.stateDir).mode & 0o777, 0o720);
    assert.throws(() => stateFile(host, 'updater-token'));

    // ...and once the contents have been reviewed and the directory tightened, it
    // runs. Pairing material normalises it to execute-only for non-root users so
    // uid 1000 containers can traverse the bind mount without listing host state.
    chmodSync(host.stateDir, 0o750);
    assert.equal(run(host, []).status, 0);
    assert.equal(statSync(host.stateDir).mode & 0o777, 0o711);
    // The token is what has to be unreadable, and it is created that way regardless.
    assert.equal(statSync(join(host.stateDir, 'updater-token')).mode & 0o777, 0o600);
  });

  test('refuses a state directory owned by another user', () => {
    // Only reachable through a pre-existing directory — exactly the case `install -d`
    // would have chowned to root before anyone looked at it. Inside `unshare -r` only
    // the caller maps to uid 0, so any directory owned by someone else on the real
    // host (here /etc, which is root-owned and not group-writable) reads as foreign.
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const result = run(host, [], { VERITY_STATE_DIR: '/etc' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be owned by root/);
  });

  test('refuses a relative state directory rather than splitting state across two', () => {
    // The script `cd`s to the checkout before the handover, so a relative path would
    // have this run write state beside the caller and the migration read the token
    // beside the checkout — one of the two being empty, at root.
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const relative = '.verity-install-relative-state';
    const result = run(host, [], { VERITY_STATE_DIR: relative });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be an absolute path/);
    assert.throws(() => statSync(relative));
    assert.throws(() => readFileSync(host.handover));
  });

  test('refuses a state directory reached through a symlinked parent', () => {
    const host = makeHost({ docker: [{ match: 'image inspect', out: DIGEST_A }] });
    const alias = join(host.root, 'alias');
    symlinkSync(host.root, alias);
    const result = run(host, [], { VERITY_STATE_DIR: join(alias, 'state') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resolves to/);
    assert.throws(() => readFileSync(host.handover));
  });
});

if (!canFakeRoot) {
  test('user namespaces unavailable — installer behaviour not covered', () => {
    const detail = `\`unshare -r\` failed on this host: ${String(userNamespaces.stderr ?? '').trim() || `exit ${userNamespaces.status}`}`;
    // Fail closed under CI. A green run that exercised none of the installer's
    // privileged behaviour is worse than a red one, because it reads as coverage.
    // The `installer` job in ci.yml runs this inside a `seccomp=unconfined`
    // container precisely so this cannot be reached there; the Vitest bridge skips
    // instead of spawning the suite on a runner that has no namespace to give it.
    if (process.env.CI) assert.fail(`verity-install tests cannot run: ${detail}`);
    console.warn(`verity-install tests skipped: ${detail}`);
  });
}

// Pure-shell helpers are exercised through the script above; nothing is exported.
export {};
