import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from '/app/node_modules/pg/lib/index.js';
import {
  createPostgresDb,
  migrateToLatest,
  generateSalt,
  deriveKeyFromPassword,
  createKeyVerifier,
  createSecretCipher,
} from '/app/packages/store/dist/index.js';
import { createDockerClient } from '/app/packages/server/dist/docker.js';
import { captureInstallation } from '/app/packages/server/dist/backup/capture.js';
import { writeBackupIdentityFixture } from '/app/packages/server/dist/backup/testing.js';
import { generateBackupKeys, recoverHostKeys } from '/app/packages/server/dist/backup/crypto.js';
import { BackupDestination } from '/app/packages/server/dist/backup/destination.js';
import { BackupRepository } from '/app/packages/server/dist/backup/repository.js';
import { BackupLifecycleCoordinator } from '/app/packages/server/dist/backup/lifecycle.js';
import { BackupRevocationJournal } from '/app/packages/server/dist/backup/revocations.js';
import { InstallerRestoreJob } from '/app/packages/server/dist/backup/restore-job.js';
import { createRestoreLifecycle } from '/app/packages/server/dist/backup/restore-lifecycle.js';
import { createInstallerRestoreInitializer } from '/app/packages/server/dist/backup/restore-installer-main.js';
import { reviewRestoreDevices } from '/app/packages/server/dist/backup/restore-review-client.js';
import { restoreDatabaseResources } from '/app/packages/server/dist/backup/restore-database-runtime.js';
import { withCanonicalRestoreClient } from '/app/packages/server/dist/backup/restore-canonical-runtime.js';
import * as provenance from '/app/packages/server/dist/self-update/release-channel-verify.js';

// Destructive tests must prove that the socket names the disposable daemon authorized by CI.
assert.equal(process.env.VERITY_RESTORE_DOCKER_ACCEPTANCE, '1');
const exec = promisify(execFile);
const daemon = (await exec('docker', ['info', '--format', '{{.ID}}'])).stdout.trim();
assert.ok(daemon && daemon === process.env.VERITY_RESTORE_TEST_DAEMON_ID);
const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
const image = process.env.VERITY_RESTORE_TEST_IMAGE;
assert.match(image ?? '', /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/);
const root = '/opt/verity-restore-fixture';
const hostRoot = join(root, 'host');
const stateRoot = join(hostRoot, 'restore');
const action = process.argv[2];
assert.equal(process.arch, 'x64');
const signal = new AbortController().signal;

async function capture() {
  const labels = await docker.inspectImageLabels(image);
  const postgres = labels['org.verity.postgres-image'];
  assert.match(postgres, /^postgres:.*@sha256:[a-f0-9]{64}$/);
  await docker.pullImage(postgres);
  await docker.ensureNetwork('verity-restore-capture');
  const password = randomBytes(32).toString('hex');
  const container = await docker.createContainer({
    image: postgres,
    name: 'verity-restore-source-postgres',
    network: 'verity-restore-capture',
    env: ['POSTGRES_USER=verity', 'POSTGRES_DB=verity', `POSTGRES_PASSWORD=${password}`],
    restartPolicy: 'no',
  });
  await docker.startContainer(container.id);
  const address = (await docker.inspectContainer(container.id)).networks['verity-restore-capture']
    .ipAddress;
  const url = `postgres://verity:${password}@${address}:5432/verity`;
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
  pool.on('error', () => {});
  for (let n = 0; ; n++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      if (n === 60) throw new Error('source database unavailable');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const database = createPostgresDb(url);
  await migrateToLatest(database);
  await database.destroy();
  const schema = (await pool.query('SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1'))
    .rows[0].name;
  const source = join(root, 'original');
  const project = join(source, 'workspaces/project');
  const worktree = join(source, 'sessions/project/session');
  await mkdir(project, { recursive: true });
  await mkdir(join(source, 'sessions/project'), { recursive: true });
  await mkdir(join(source, 'knowledge'), { recursive: true });
  await writeFile(join(project, 'tracked'), 'recovered Git history');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Recovery acceptance',
    GIT_COMMITTER_NAME: 'Recovery acceptance',
    GIT_AUTHOR_EMAIL: 'recovery@example.invalid',
    GIT_COMMITTER_EMAIL: 'recovery@example.invalid',
  };
  await exec('git', ['init', project], { env });
  await exec('git', ['-C', project, 'add', '.'], { env });
  await exec('git', ['-C', project, 'commit', '-m', 'Recovery fixture'], { env });
  await exec('git', ['-C', project, 'worktree', 'add', '-b', 'session', worktree], { env });
  await writeFile(join(project, '.env'), 'synthetic private worktree data');
  await writeFile(join(worktree, 'uncommitted'), 'session worktree data');
  await writeFile(join(source, 'knowledge/insight.md'), 'durable recovery knowledge');
  const masterPassword = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const salt = generateSalt();
  const key = await deriveKeyFromPassword(masterPassword, salt);
  await pool.query("INSERT INTO secret_key_meta(id,salt,verifier) VALUES ('global',$1,$2)", [
    salt,
    createKeyVerifier(key),
  ]);
  await pool.query(
    "INSERT INTO projects(id,owner,repo,container_name,state,kind) VALUES ('recovery-project','fixture','project','old-project','active','local')",
  );
  await pool.query(
    "INSERT INTO sessions(session_id,worktree,model,project_id) VALUES ('recovery-session',$1,'fixture','recovery-project')",
    [worktree],
  );
  await pool.query(
    "INSERT INTO auth_tokens(id,token_hash) VALUES ('keep-device',$1),('outbox-device','outbox-hash'),('late-device','late-hash'),('reviewed-late-device','reviewed-late-hash')",
    [createHash('sha256').update(token).digest('hex')],
  );
  await pool.query(
    "INSERT INTO backup_revocation_outbox(id,device_id) VALUES ('before-capture','outbox-device'); INSERT INTO running_turns(session_id,prompt_seq) VALUES ('recovery-session',1)",
  );
  await pool.query('UPDATE verity_settings SET git_user_name = $1, transcribe_api_key = $2', [
    'Recovery fixture',
    createSecretCipher(key).encrypt('recovered-synthetic-credential'),
  ]);
  const keys = await generateBackupKeys();
  const installationId = randomUUID();
  await writeBackupIdentityFixture(join(root, 'original-identity'), keys.host, installationId);
  const targetId = randomUUID();
  await mkdir(join(root, 'backup'));
  await writeFile(join(root, 'backup/.verity-backup-target'), targetId);
  const destination = await BackupDestination.open(join(root, 'backup'), targetId);
  const repository = installationId + '-r1';
  const localState = join(root, 'original-index');
  const writer = new BackupRepository(
    destination.path,
    localState,
    repository,
    keys.host,
    destination,
  );
  await writer.initialize();
  const repoKeys = new Map();
  const captureOptions = {
    root: source,
    identityRoot: join(root, 'original-identity/identity'),
    caCiphertext: join(root, 'original-identity/ca.age'),
    installationId,
    keyGeneration: 1,
    image,
    release: '99.0.0',
    schema,
    architecture: 'amd64',
    kind: 'manual',
    connect: () => pool.connect(),
    repository: writer,
    destination,
    lifecycle: new BackupLifecycleCoordinator(),
    signal,
    inventory: async () => ({
      activeTurns: ['recovery-session'],
      projects: [
        {
          id: 'recovery-project',
          state: 'active',
          archived: false,
          paths: ['workspaces/project', 'sessions/project/session'],
          warnings: [],
        },
      ],
    }),
    repoKey: async (_project, path) => {
      if (!repoKeys.has(path)) repoKeys.set(path, randomUUID());
      return repoKeys.get(path);
    },
  };
  const manifest = await captureInstallation(captureOptions);
  // A real second image lacks recovery capability but has valid signed release evidence.
  const unsupportedTag = 'ghcr.io/heey-global/verity/verity-server:restore-unsupported';
  const dockerfile = join(root, 'Unsupported.Dockerfile');
  await writeFile(dockerfile, 'FROM scratch\nLABEL org.verity.recovery=0\n');
  await exec('docker', ['build', '--file', dockerfile, '--tag', unsupportedTag, root]);
  await exec('docker', ['push', '--quiet', unsupportedTag]);
  const unsupportedImage = (
    await exec('docker', [
      'image',
      'inspect',
      '--format',
      '{{index .RepoDigests 0}}',
      unsupportedTag,
    ])
  ).stdout.trim();
  await exec('docker', ['save', '--output', join(root, 'unsupported-release.tar'), unsupportedTag]);
  const unsupportedManifest = await captureInstallation({
    ...captureOptions,
    image: unsupportedImage,
  });
  assert.equal(
    await new BackupRevocationJournal(destination, localState, installationId, 1, keys.host).queue(
      'late-device',
    ),
    true,
  );
  const signer = generateKeyPairSync('ed25519');
  const protocol = { min: 1, current: 1 };
  const envelopeFor = (serverImage) => {
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        version: manifest.release,
        revision: 'a'.repeat(40),
        architecture: 'amd64',
        serverImage,
        agentSeedImage: null,
        compatibility: {
          serverVersion: manifest.release,
          schema: { min: schema, current: schema, max: schema },
          runner: protocol,
          eventLog: protocol,
          gateway: protocol,
          updater: protocol,
        },
        publishedAt: new Date().toISOString(),
        generation: 'stable-99.0.0',
      }),
    );
    return {
      payload: payload.toString('base64'),
      signature: {
        kind: 'sigstore-bundle',
        bundle: Buffer.from(
          JSON.stringify({ signature: sign(null, payload, signer.privateKey).toString('base64') }),
        ).toString('base64'),
      },
    };
  };
  const envelope = envelopeFor(image);
  await writeFile(
    join(root, 'input'),
    JSON.stringify({
      recoveryKey: keys.recoveryKey,
      masterPassword,
      token,
      installationId,
      repository,
      sequence: manifest.sequence,
      schema,
      envelope,
      unsupported: {
        sequence: unsupportedManifest.sequence,
        envelope: envelopeFor(unsupportedImage),
      },
      releasePublicKey: signer.publicKey.export({ format: 'pem', type: 'spki' }),
      ca: (await readFile(join(root, 'original-identity/identity/tls-ca-cert.pem'))).toString(
        'base64',
      ),
    }),
    { mode: 0o600 },
  );
  await pool.end();
  await destination.close();
  console.log('Actual capture fixture and post-capture revocation published.');
}

async function restore() {
  assert.equal(await exists(join(root, 'original')), false, 'original host data must not exist');
  assert.equal(await exists(join(root, 'original-index')), false, 'local index must not exist');
  const input = JSON.parse(await readFile(join(root, 'input'), 'utf8'));
  if (action === 'unsupported') {
    input.sequence = input.unsupported.sequence;
    input.envelope = input.unsupported.envelope;
  }
  await mkdir(hostRoot, { recursive: true, mode: 0o755 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const previousComposeProject = (await exists(join(hostRoot, 'compose-project')))
    ? (await readFile(join(hostRoot, 'compose-project'), 'utf8')).trim()
    : 'verity';
  const config = {
    action: 'status',
    root: stateRoot,
    hostRoot,
    previousComposeProject,
    tufCachePath: join(stateRoot, 'tuf'),
    backupDirectory: join(root, 'new-backups'),
    addresses: ['127.0.0.1'],
  };
  const oid = (id, value) => ({
    oid: { id: id.split('.').map(Number) },
    value: Buffer.from([12, Buffer.byteLength(value), ...Buffer.from(value)]),
  });
  // CI supplies an isolated cryptographic trust root; production always uses the default Sigstore verifier.
  const release = {
    load: async () =>
      action === 'bad-release'
        ? { ...input.envelope, payload: Buffer.from('tampered').toString('base64') }
        : input.envelope,
    verification: {
      tufCachePath: config.tufCachePath,
      verifyBundle: async (bundle, payload) => {
        assert.equal(
          verify(null, payload, input.releasePublicKey, Buffer.from(bundle.signature, 'base64')),
          true,
        );
        return {
          identity: {
            subjectAlternativeName: provenance.OFFICIAL_RELEASE_WORKFLOW_IDENTITY,
            extensions: { issuer: provenance.OFFICIAL_CERTIFICATE_ISSUER },
            oids: [
              oid('1.3.6.1.4.1.57264.1.12', provenance.OFFICIAL_SOURCE_REPOSITORY),
              oid('1.3.6.1.4.1.57264.1.13', 'a'.repeat(40)),
              oid('1.3.6.1.4.1.57264.1.14', provenance.OFFICIAL_SOURCE_REF),
              oid('1.3.6.1.4.1.57264.1.15', provenance.OFFICIAL_SOURCE_REPOSITORY_ID),
            ],
          },
        };
      },
    },
  };
  const adapters = createRestoreLifecycle({
    docker,
    root: stateRoot,
    liveRoot: '/srv/verity',
    hostRoot,
    previousComposeProject,
    tufCachePath: config.tufCachePath,
    hostNetworking: true,
    host: { root: stateRoot, addresses: config.addresses, backupDirectory: config.backupDirectory },
    recoveryKey: input.recoveryKey,
    masterPassword: input.masterPassword,
    release,
    initialize: createInstallerRestoreInitializer(config, docker, signal),
  });
  const fault = process.env.VERITY_RESTORE_TEST_INTERRUPT;
  if (fault) {
    const run = adapters[fault];
    assert.equal(typeof run, 'function');
    adapters[fault] = async (...args) => {
      await run(...args);
      process.kill(process.pid, 'SIGKILL');
    };
  }
  const manager = new InstallerRestoreJob(stateRoot, adapters);
  let job = await manager.status();
  if (action === 'no-space' || action === 'unsupported')
    job = await manager.begin({
      source: join(root, 'backup'),
      repository: input.repository,
      sequence: input.sequence,
      kind: 'manual',
      newIdentity: false,
    });
  if (action === 'begin') {
    job = await manager.begin({
      source: join(root, 'backup'),
      repository: input.repository,
      sequence: input.sequence,
      kind: 'manual',
      newIdentity: process.env.VERITY_RESTORE_TEST_NEW_IDENTITY === '1',
    });
    await writeFile(join(root, 'job-id'), job.id);
  } else if (action === 'late-revoke') {
    const targetId = (await readFile(join(root, 'backup/.verity-backup-target'), 'utf8')).trim();
    const destination = await BackupDestination.open(join(root, 'backup'), targetId);
    try {
      const keys = await recoverHostKeys(
        input.recoveryKey,
        await readFile(join(root, 'backup/repositories', input.repository, 'keys')),
      );
      assert.equal(
        await new BackupRevocationJournal(
          destination,
          join(root, 'revocation-index'),
          input.installationId,
          1,
          keys,
        ).queue('reviewed-late-device'),
        true,
      );
    } finally {
      await destination.close();
    }
  } else if (
    action === 'bad-release' ||
    action === 'rejected-snapshot' ||
    action === 'no-space' ||
    action === 'unsupported'
  ) {
    await assert.rejects(manager.advance(job.id, input.recoveryKey, signal));
    assert.equal((await manager.status()).phase, 'verifying');
  } else if (action === 'advance') job = await manager.advance(job.id, input.recoveryKey, signal);
  else if (action === 'abort') job = await manager.abort(job.id, signal);
  else if (action === 'wrong-key')
    await assert.rejects(manager.advance(job.id, 'wrong-recovery-key', signal));
  else if (action === 'wrong-password')
    await assert.rejects(
      reviewRestoreDevices({ root: stateRoot, jobId: job.id, masterPassword: 'wrong' }),
    );
  else if (action === 'review')
    await reviewRestoreDevices({
      root: stateRoot,
      jobId: job.id,
      masterPassword: input.masterPassword,
      keepIds: job.selection.newIdentity ? [] : ['keep-device', 'reviewed-late-device'],
    });
  else if (action === 'assert-restored') {
    assert.equal(job.phase, 'promoted');
    assert.equal(
      await readFile('/restore-live/workspaces/project/.env', 'utf8'),
      'synthetic private worktree data',
    );
    assert.equal(
      await readFile('/restore-live/sessions/project/session/uncommitted', 'utf8'),
      'session worktree data',
    );
    assert.equal(
      await readFile('/restore-live/knowledge/insight.md', 'utf8'),
      'durable recovery knowledge',
    );
    await exec('git', [
      '-c',
      'safe.directory=*',
      '-C',
      '/srv/verity/sessions/project/session',
      'status',
      '--porcelain',
    ]);
    const ca = await readFile(join(hostRoot, 'tls-ca-cert.pem'));
    assert.equal(ca.equals(Buffer.from(input.ca, 'base64')), !job.selection.newIdentity);
    assert.notEqual(
      (await readFile(join(hostRoot, 'installation-id'), 'utf8')).trim(),
      input.installationId,
    );
    await withCanonicalRestoreClient(
      { docker, root: stateRoot, job, network: restoreDatabaseResources(job).prefix, signal },
      async (client) => {
        assert.deepEqual(
          (await client.query('SELECT id FROM auth_tokens ORDER BY id')).rows.map((row) => row.id),
          job.selection.newIdentity ? [] : ['keep-device'],
        );
        assert.equal(
          (await client.query("SELECT state FROM projects WHERE id='recovery-project'")).rows[0]
            .state,
          'absent',
        );
        assert.equal(
          (await client.query('SELECT count(*)::int AS n FROM running_turns')).rows[0].n,
          0,
        );
        const meta = (await client.query("SELECT salt FROM secret_key_meta WHERE id='global'"))
          .rows[0];
        const stored = (await client.query('SELECT transcribe_api_key FROM verity_settings'))
          .rows[0].transcribe_api_key;
        assert.equal(
          createSecretCipher(await deriveKeyFromPassword(input.masterPassword, meta.salt)).decrypt(
            stored,
          ),
          'recovered-synthetic-credential',
        );
      },
    );
  } else if (action === 'verify-api') {
    const previous = JSON.parse(
      await readFile(join(stateRoot, job.id, 'previous-runtime'), 'utf8'),
    ).previous;
    for (const container of previous.containers)
      assert.equal(
        (await docker.inspectContainer(container.id)).running,
        false,
        'previous container must remain retained and fenced',
      );
    const project = (await readFile(join(hostRoot, 'compose-project'), 'utf8')).trim();
    const gateway = (await docker.listContainers()).find(
      (container) =>
        container.labels?.['com.docker.compose.project'] === project &&
        container.labels?.['com.docker.compose.service'] === 'verity-managed-gateway',
    );
    assert.ok(gateway, 'accepted managed gateway missing');
    const inspected = await docker.inspectContainer(gateway.id);
    const address = Object.values(inspected.networks)
      .map((network) => network.ipAddress)
      .find(Boolean);
    const ca = await readFile(join(hostRoot, 'tls-ca-cert.pem'));
    const api = (path, body, token = input.token) =>
      new Promise((resolve, reject) => {
        const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = httpsRequest(
          {
            hostname: address,
            port: 8082,
            servername: 'localhost',
            ca,
            path,
            method: bytes ? 'POST' : 'GET',
            timeout: 30000,
            headers: {
              Authorization: 'Bearer ' + token,
              ...(bytes
                ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length }
                : {}),
            },
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              try {
                resolve({
                  status: response.statusCode,
                  body: JSON.parse(Buffer.concat(chunks).toString()),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('API timeout')));
        req.end(bytes);
      });
    assert.equal((await api('/secret/status')).body.status, 'sealed');
    if (job.selection.newIdentity) assert.equal((await api('/settings')).status, 401);
    else {
      const unlocked = await api('/secret/unlock', {
        password: input.masterPassword,
        deviceLabel: 'Restored device acceptance',
      });
      assert.equal(unlocked.status, 200);
      assert.equal(unlocked.body.status, 'unlocked');
      const settings = await api('/settings');
      assert.equal(settings.status, 200, 'the original reviewed device token must reconnect');
      assert.equal(settings.body.settings.gitUserName, 'Recovery fixture');
    }
  } else if (action !== 'status') throw new Error('Unknown acceptance action');
  console.log(`Restore ${action}: ${job.phase}`);
}
async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'EISDIR') return true;
    throw error;
  }
}
if (action === 'capture') await capture();
else await restore();
