import assert from 'node:assert/strict';
import {
  seedRestoreContent,
  assertRestoredFiles,
  assertRestoredDatabaseContent,
} from './backup-restore-content.mjs';
import { certificatePin, pinnedApi, verifyPairingProof } from './backup-restore-device-trust.mjs';
import { formatRestoreFailure, formatRestoreLog } from './backup-restore-diagnostics.mjs';
import { execFile } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from '/app/node_modules/pg/lib/index.js';
import {
  createPostgresDb,
  migrateToLatest,
  generateSalt,
  deriveKeyFromPassword,
  createKeyVerifier,
  createSecretCipher,
  createSealableSecretCipher,
} from '/app/packages/store/dist/index.js';
import { createDockerClient } from '/app/packages/server/dist/docker.js';
import { captureInstallation } from '/app/packages/server/dist/backup/capture.js';
import { readCaptureInventory } from '/app/packages/server/dist/backup/inventory.js';
import { writeBackupIdentityFixture } from '/app/packages/server/dist/backup/testing.js';
import { generateBackupKeys, recoverHostKeys } from '/app/packages/server/dist/backup/crypto.js';
import { BackupDestination } from '/app/packages/server/dist/backup/destination.js';
import { openCaIdentityReceipt } from '/app/packages/server/dist/backup/identity-receipt.js';
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
  const expectedContent = await seedRestoreContent(source, pool);
  const masterPassword = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const deniedTokens = Object.fromEntries(
    ['outbox-device', 'late-device', 'reviewed-late-device', 'unreviewed-device'].map((id) => [
      id,
      randomBytes(32).toString('base64url'),
    ]),
  );
  const salt = generateSalt();
  const key = await deriveKeyFromPassword(masterPassword, salt);
  await pool.query("INSERT INTO secret_key_meta(id,salt,verifier) VALUES ('global',$1,$2)", [
    salt,
    createKeyVerifier(key),
  ]);
  await pool.query(
    "INSERT INTO auth_tokens(id,token_hash) VALUES ('keep-device',$1),('outbox-device','outbox-hash'),('late-device','late-hash'),('reviewed-late-device','reviewed-late-hash')",
    [createHash('sha256').update(token).digest('hex')],
  );
  for (const [id, credential] of Object.entries(deniedTokens)) {
    await pool.query(
      'INSERT INTO auth_tokens(id,token_hash) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET token_hash=excluded.token_hash',
      [id, createHash('sha256').update(credential).digest('hex')],
    );
  }
  await pool.query(
    "INSERT INTO backup_revocation_outbox(id,device_id) VALUES ('before-capture','outbox-device'); INSERT INTO running_turns(session_id,prompt_seq) VALUES ('recovery-session',1)",
  );
  await pool.query(
    "INSERT INTO verity_settings(id,git_user_name,transcribe_api_key) VALUES ('global',$1,$2)",
    ['Recovery fixture', createSecretCipher(key).encrypt('recovered-synthetic-credential')],
  );
  const keys = await generateBackupKeys();
  const installationId = randomUUID();
  await writeBackupIdentityFixture(join(root, 'original-identity'), keys.host, installationId);
  const originalIdentityKey = createPublicKey(
    await readFile(join(root, 'original-identity/identity/pairing-identity.pem')),
  )
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const originalTrust = {
    pin: certificatePin(await readFile(join(root, 'original-identity/identity/tls-cert.pem'))),
    identityKey: originalIdentityKey,
    serverId:
      'srv_' +
      createHash('sha256')
        .update('verity.device-pairing.v1.server-id\0' + originalIdentityKey)
        .digest()
        .subarray(0, 16)
        .toString('base64url'),
  };
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
    inventory: (client) => readCaptureInventory(client, source, schema),
    repoKey: async (_project, path) => {
      if (!repoKeys.has(path)) repoKeys.set(path, randomUUID());
      return repoKeys.get(path);
    },
  };
  // A fresh process has no unlocked master cipher or recovery key in its inputs.
  const restartState = {
    url,
    source,
    targetId,
    repository,
    host: keys.host,
    installationId,
    schema,
  };
  assert.equal('masterPassword' in restartState || 'recoveryKey' in restartState, false);
  await writeFile(join(root, 'sealed-capture-state'), JSON.stringify(restartState), {
    mode: 0o600,
  });
  await exec(process.execPath, [process.argv[1], 'capture-sealed']);
  const manifest = JSON.parse(await readFile(join(root, 'sealed-capture-result'), 'utf8'));
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
      expectedContent,
      recoveryKey: keys.recoveryKey,
      masterPassword,
      token,
      deniedTokens,
      originalTrust,
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

async function captureSealed() {
  const state = JSON.parse(await readFile(join(root, 'sealed-capture-state'), 'utf8'));
  assert.equal('recoveryKey' in state || 'masterPassword' in state, false);
  const sealed = createSealableSecretCipher();
  assert.equal(sealed.isSealed(), true);
  const pool = new pg.Pool({ connectionString: state.url, max: 1 });
  const destination = await BackupDestination.open(join(root, 'backup'), state.targetId);
  try {
    const settings = (await pool.query('SELECT transcribe_api_key FROM verity_settings')).rows[0];
    assert.throws(() => sealed.decrypt(settings.transcribe_api_key));
    const repository = new BackupRepository(
      destination.path,
      join(root, 'original-index'),
      state.repository,
      state.host,
      destination,
    );
    const repoKeys = new Map();
    const manifest = await captureInstallation({
      root: state.source,
      identityRoot: join(root, 'original-identity/identity'),
      caCiphertext: join(root, 'original-identity/ca.age'),
      installationId: state.installationId,
      keyGeneration: 1,
      image,
      release: '99.0.0',
      schema: state.schema,
      architecture: 'amd64',
      kind: 'manual',
      connect: () => pool.connect(),
      repository,
      destination,
      lifecycle: new BackupLifecycleCoordinator(),
      signal,
      inventory: (client) => readCaptureInventory(client, state.source, state.schema),
      repoKey: async (_project, path) => {
        if (!repoKeys.has(path)) repoKeys.set(path, randomUUID());
        return repoKeys.get(path);
      },
    });
    assert.equal(sealed.isSealed(), true);
    await writeFile(join(root, 'sealed-capture-result'), JSON.stringify(manifest), { mode: 0o600 });
  } finally {
    await pool.end();
    await destination.close();
  }
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
  if (fault) assert.notEqual(process.pid, 1, 'Interruption driver requires a container init');
  if (fault === 'rollback-resume') {
    const start = docker.startContainer;
    docker.startContainer = async (id) => {
      await start(id);
      const current = JSON.parse(await readFile(join(stateRoot, 'job'), 'utf8'));
      const promotion = JSON.parse(
        await readFile(join(stateRoot, current.id, 'promotion'), 'utf8'),
      );
      if (
        promotion.phase === 'rolling-back' &&
        promotion.previous.containers.some((container) => container.id === id)
      )
        process.kill(process.pid, 'SIGKILL');
    };
  } else if (fault) {
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
  if (action === 'seed-compose') {
    assert.equal(job, null);
    await docker.ensureVolume('verity-data');
    await docker.ensureVolume('verity-recovery-compose_verity-db');
    await exec('docker', [
      'run',
      '--rm',
      '--user',
      '0:0',
      '--volume',
      'verity-data:/data',
      '--volume',
      'verity-recovery-compose_verity-db:/database',
      '--entrypoint',
      'sh',
      image,
      '-c',
      'printf previous-data > /data/previous-sentinel; printf previous-database > /database/previous-sentinel',
    ]);
    const compose = join(root, 'previous-compose.json');
    await writeFile(
      compose,
      JSON.stringify({
        services: {
          server: {
            image,
            user: '0:0',
            entrypoint: ['sh', '-c', 'while :; do sleep 60; done'],
            volumes: ['verity-data:/srv/verity'],
            restart: 'unless-stopped',
          },
          database: {
            image,
            user: '0:0',
            entrypoint: ['sh', '-c', 'while :; do sleep 60; done'],
            volumes: ['verity-recovery-compose_verity-db:/var/lib/postgresql'],
            restart: 'unless-stopped',
          },
        },
        volumes: {
          'verity-data': { external: true },
          'verity-recovery-compose_verity-db': { external: true },
        },
      }),
    );
    await exec('docker', [
      'compose',
      '--project-name',
      'verity-recovery-compose',
      '--file',
      compose,
      'up',
      '--detach',
    ]);
    await writeFile(join(hostRoot, 'compose-project'), 'verity-recovery-compose');
    console.log('Existing Compose runtime and volume sentinels prepared.');
    return;
  }
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
  } else if (action === 'retired-identity') {
    job = await manager.begin({
      source: join(root, 'backup'),
      repository: input.repository,
      sequence: input.sequence,
      kind: 'manual',
      newIdentity: false,
    });
    await assert.rejects(
      manager.advance(job.id, input.recoveryKey, signal),
      /identity was retired/,
    );
    assert.equal((await manager.status()).phase, 'verifying');
    await manager.abort(job.id, signal);
  } else if (action === 'advance') job = await manager.advance(job.id, input.recoveryKey, signal);
  else if (action === 'abort') job = await manager.abort(job.id, signal);
  else if (action === 'wrong-key')
    await assert.rejects(manager.advance(job.id, 'wrong-recovery-key', signal));
  else if (action === 'wrong-password')
    await assert.rejects(
      reviewRestoreDevices({ root: stateRoot, jobId: job.id, masterPassword: 'wrong' }),
    );
  else if (action === 'inspect-missing-history') {
    const inventory = await reviewRestoreDevices({
      root: stateRoot,
      jobId: job.id,
      masterPassword: input.masterPassword,
    });
    assert.ok(inventory.findings.includes('revocation-journal-missing'));
    const review = JSON.parse(
      await readFile(join(stateRoot, job.id, 'trial/device-review'), 'utf8'),
    );
    assert.equal(review.status, 'pending');
    assert.deepEqual(review.keptIds, []);
    assert.ok(review.devices.includes('keep-device'));
  } else if (action === 'review')
    await reviewRestoreDevices({
      root: stateRoot,
      jobId: job.id,
      masterPassword: input.masterPassword,
      keepIds: job.selection.newIdentity ? [] : ['keep-device', 'reviewed-late-device'],
    });
  else if (action === 'assert-restored') {
    assert.equal(job.phase, 'promoted');
    await assertRestoredFiles('/srv/verity', input.expectedContent);
    const ca = await readFile(join(hostRoot, 'tls-ca-cert.pem'));
    assert.equal(ca.equals(Buffer.from(input.ca, 'base64')), !job.selection.newIdentity);
    assert.notEqual(
      (await readFile(join(hostRoot, 'installation-id'), 'utf8')).trim(),
      input.installationId,
    );
    await withCanonicalRestoreClient(
      { docker, root: stateRoot, job, network: restoreDatabaseResources(job).prefix, signal },
      async (client) => {
        await assertRestoredDatabaseContent(client, '/srv/verity', input.expectedContent);
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
  } else if (action === 'assert-aborted') {
    assert.equal(job.phase, 'aborted');
    const previous = JSON.parse(
      await readFile(join(stateRoot, job.id, 'previous-runtime'), 'utf8'),
    ).previous;
    assert.ok(previous.containers.some((container) => container.running));
    if (previous.containers.length === 2) {
      const result = await exec('docker', [
        'run',
        '--rm',
        '--volume',
        'verity-data:/data:ro',
        '--volume',
        'verity-recovery-compose_verity-db:/database:ro',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'cat /data/previous-sentinel /database/previous-sentinel',
      ]);
      assert.equal(result.stdout, 'previous-dataprevious-database');
    }
    for (const container of previous.containers)
      assert.equal((await docker.inspectContainer(container.id)).running, container.running);
  } else if (action === 'prepare-exposure-original' || action === 'prepare-exposure') {
    const current = JSON.parse(await readFile('/srv/verity/backup-state/state', 'utf8'));
    if (action === 'prepare-exposure-original') {
      await mkdir(join(root, 'identity-requests'), { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, 'identity-requests/recipient.json'),
        JSON.stringify({
          recipient: current.host.recipient,
          keyGeneration: current.keyGeneration,
        }),
        { mode: 0o600 },
      );
      return;
    }
    openCaIdentityReceipt(
      await readFile(
        join(
          root,
          'new-backups/identity',
          `${current.installationId}-ca-key-k${current.keyGeneration}`,
        ),
      ),
      await readFile(join(hostRoot, 'tls-ca-cert.pem')),
      current.installationId,
      current.keyGeneration,
      current.host.recipient,
    );
    const replacement = await generateBackupKeys();
    await mkdir(join(root, 'identity-requests'), { recursive: true, mode: 0o700 });
    const request = {
      recipient: replacement.host.recipient,
      keyGeneration: current.keyGeneration + 1,
      retireGeneration: current.keyGeneration,
    };
    await writeFile(join(root, 'identity-requests/recipient.json'), JSON.stringify(request), {
      mode: 0o600,
    });
    await writeFile(
      join(root, 'exposure-public-state'),
      JSON.stringify({ installationId: current.installationId, request }),
      { mode: 0o600 },
    );
    await writeFile(join(root, 'new-backups/identity/unrelated-sentinel'), 'preserve-unrelated');
  } else if (action === 'assert-exposure') {
    const exposure = JSON.parse(await readFile(join(root, 'exposure-public-state'), 'utf8'));
    const directory = join(root, 'new-backups/identity');
    assert.equal(
      await exists(
        join(directory, `${exposure.installationId}-ca-key-k${exposure.request.retireGeneration}`),
      ),
      false,
    );
    assert.equal(
      await readFile(join(directory, 'unrelated-sentinel'), 'utf8'),
      'preserve-unrelated',
    );
    assert.ok(
      (
        await readFile(
          join(
            directory,
            `${exposure.installationId}-ca-retired-k${exposure.request.retireGeneration}`,
          ),
        )
      ).length > 0,
    );
    const receipt = await readFile(
      join(directory, `${exposure.installationId}-ca-key-k${exposure.request.keyGeneration}`),
    );
    openCaIdentityReceipt(
      receipt,
      await readFile(join(hostRoot, 'tls-ca-cert.pem')),
      exposure.installationId,
      exposure.request.keyGeneration,
      exposure.request.recipient,
    );
  } else if (action === 'verify-api' || action === 'verify-rotated-api') {
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
    const pin = certificatePin(await readFile(join(hostRoot, 'tls-cert.pem')));
    const changedIdentity = job.selection.newIdentity || action === 'verify-rotated-api';
    assert.equal(
      pin === input.originalTrust.pin,
      !changedIdentity,
      'preserved identity must retain the mobile TLS pin',
    );
    const transport = pinnedApi({ address, ca, pin });
    const api = (path, body, token = input.token, headers) => transport(path, body, token, headers);
    for (let attempt = 0; ; attempt++) {
      try {
        assert.equal((await transport('/health')).status, 200);
        break;
      } catch (error) {
        if (attempt === 120) throw error;
        await delay(250);
      }
    }
    if (!changedIdentity) await verifyPairingProof(transport, input.originalTrust);
    else {
      await assert.rejects(
        pinnedApi({ address, ca, pin: input.originalTrust.pin })(
          '/pair/identity?challenge=' + randomBytes(32).toString('base64url'),
        ),
        /TLS pin mismatch/,
      );
      const identityKey = createPublicKey(await readFile(join(hostRoot, 'pairing-identity.pem')))
        .export({ format: 'der', type: 'spki' })
        .toString('base64url');
      assert.notEqual(identityKey, input.originalTrust.identityKey);
      await verifyPairingProof(transport, {
        identityKey,
        serverId:
          'srv_' +
          createHash('sha256')
            .update('verity.device-pairing.v1.server-id\0' + identityKey)
            .digest()
            .subarray(0, 16)
            .toString('base64url'),
      });
    }
    for (const denied of Object.values(input.deniedTokens))
      assert.equal((await api('/auth/session', undefined, denied)).status, 401);
    assert.equal((await api('/secret/status')).body.status, 'sealed');
    if (changedIdentity) {
      assert.equal((await api('/settings')).status, 401);
      // Emulate explicit installer issuance only after acceptance; startup's expired code grants nothing.
      const code = randomBytes(32).toString('hex');
      await writeFile(join(hostRoot, 'pairing-code'), code, { mode: 0o600 });
      await writeFile(
        join(hostRoot, 'pairing-expires-at'),
        new Date(Date.now() + 300000).toISOString(),
        { mode: 0o600 },
      );
      const redeemed = await transport('/pair/redeem', { code });
      assert.equal(redeemed.status, 200);
      const unlocked = await transport(
        '/secret/unlock',
        { password: input.masterPassword, deviceLabel: 'New identity acceptance' },
        undefined,
        { 'x-verity-pairing': redeemed.body.bootstrapToken },
      );
      assert.equal(unlocked.status, 200);
      assert.equal(typeof unlocked.body.token, 'string');
      assert.equal((await transport('/settings', undefined, unlocked.body.token)).status, 200);
      assert.equal((await transport('/auth/session', undefined, input.token)).status, 401);
    } else {
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
async function diagnoseActivation(emit = console.error) {
  emit(formatRestoreLog(await readFile(join(root, 'install.log'), 'utf8').catch(() => '')));
  const roles = new Map([
    ['server', 'server'],
    ['gateway', 'gateway'],
    ['postgres', 'postgres'],
    ['updater', 'updater'],
    ['verity', 'server'],
    ['verity-managed-gateway', 'gateway'],
    ['verity-updater', 'updater'],
  ]);
  for (const container of await docker.listContainers()) {
    const role =
      container.labels?.['verity.managed-role'] ?? container.labels?.['com.docker.compose.service'];
    if (!roles.has(role)) continue;
    const state = await docker.inspectContainer(container.id);
    const processState = await exec(
      'docker',
      ['inspect', '--format', '{{json .State}}', container.id],
      {
        maxBuffer: 16384,
        timeout: 5000,
      },
    )
      .then(({ stdout }) => JSON.parse(stdout))
      .catch(() => ({}));
    emit(
      'Restore runtime diagnostic: ' +
        JSON.stringify({
          role,
          running: state.running,
          restarts: state.restartCount,
          exitCode: Number.isSafeInteger(processState.ExitCode) ? processState.ExitCode : null,
          oomKilled: processState.OOMKilled === true,
          processError: typeof processState.Error === 'string' && processState.Error.length > 0,
        }),
    );
    try {
      emit(formatRestoreLog(await docker.containerLogs(container.id, 100)));
    } catch (error) {
      emit('Restore log diagnostic: ' + formatRestoreFailure(error));
      // The CLI is an independent fallback if the bounded API decoder cannot read the log.
      const logs = await exec('docker', ['logs', '--tail', '100', container.id], {
        maxBuffer: 128 * 1024,
        timeout: 5000,
      }).catch(() => ({ stdout: '', stderr: '' }));
      emit(formatRestoreLog(logs.stdout + logs.stderr));
    }
  }
}
async function monitorActivation() {
  const seen = new Set();
  const emit = (line) => {
    if (!seen.has(line)) {
      seen.add(line);
      console.error(line);
    }
  };
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && !(await exists(join(root, 'activation-monitor-stop')))) {
    await diagnoseActivation(emit).catch(() => {});
    await delay(1000);
  }
}
try {
  if (action === 'monitor-activation') await monitorActivation();
  else if (action === 'diagnose-activation') await diagnoseActivation();
  else if (action === 'capture') await capture();
  else if (action === 'capture-sealed') await captureSealed();
  else await restore();
} catch (error) {
  if (action === 'verify-api') await diagnoseActivation().catch(() => {});
  process.stderr.write(formatRestoreFailure(error) + '\n', () => process.exit(1));
}
