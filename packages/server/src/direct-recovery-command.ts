import { execFile } from 'node:child_process';
import { open, readFile, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseServerCompat } from './self-update/compat.js';
import { planDirectRecovery } from './self-update/direct-recovery.js';
import { admitBridgeRecovery } from './self-update/bridge-recovery-admission.js';
import { readManagedDeployment } from './self-update/managed-deployment.js';
import {
  MANAGED_DEPLOYMENT_LABEL,
  MANAGED_ROLE_LABEL,
  MANAGED_SERVER_NAME,
} from './self-update/managed-server-owner.js';
import { createReleaseChannelVerifier } from './self-update/release-channel-verify.js';
import {
  readUpdaterDeployment,
  readUpdaterRecoveryCapability,
  requestUpdaterOperation,
} from './self-update/updater-status.js';

const exec = promisify(execFile);
const architecture = z.enum(['amd64', 'arm64']);
const imageDescription = z.object({ Id: z.string(), Architecture: architecture });
const containerDescription = z.object({
  Id: z.string(),
  Image: z.string(),
  State: z.object({ Running: z.literal(true) }),
  Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()) }),
});
const probe =
  "import { SERVER_COMPAT } from '/app/packages/server/dist/self-update/compat.js'; process.stdout.write(JSON.stringify(SERVER_COMPAT));";

async function docker(args: string[]): Promise<string> {
  try {
    const result = await exec('docker', ['--host=unix:///var/run/docker.sock', ...args], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    // Docker inspect may contain deployment secrets; never forward its captured output.
    throw new Error(`Local Docker ${args[0]} failed`);
  }
}

async function volume(name: string): Promise<string> {
  const volumes = z
    .array(z.object({ Name: z.literal(name), Driver: z.literal('local'), Mountpoint: z.string() }))
    .length(1)
    .parse(JSON.parse(await docker(['volume', 'inspect', name])));
  const path = volumes[0]!.Mountpoint;
  if (!path.startsWith('/') || (await realpath(path)) !== path)
    throw new Error('Docker volume path is not canonical');
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
    throw new Error('Docker volume is not a root-owned private directory');
  return path;
}

async function envelope(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(512 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size === bytes.length) throw new Error('Release envelope exceeds 512 KiB');
    return JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}

function parseDirectRecoveryArgs(args: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  const names = [
    '--target',
    '--updater-container',
    '--expected-current',
    '--expected-target',
    '--deployment-id',
    '--request-id',
  ];
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (Object.hasOwn(parsed, name)) throw new Error(`Duplicate argument ${name}`);
    if (name === '--apply' || name === '--check') {
      parsed[name] = 'true';
      continue;
    }
    if (!names.includes(name) || !args[i + 1] || args[i + 1]!.startsWith('--'))
      throw new Error(`Unknown or incomplete argument ${name}`);
    parsed[name] = args[++i]!;
  }
  if (!parsed['--target'] || !parsed['--updater-container'])
    throw new Error('--target signed envelope and --updater-container ID are required');
  if (parsed['--apply'] && parsed['--check']) throw new Error('Choose --check or --apply');
  if (
    parsed['--apply'] &&
    (!parsed['--expected-current'] ||
      !parsed['--expected-target'] ||
      !parsed['--deployment-id'] ||
      !parsed['--request-id'])
  )
    throw new Error(
      '--apply requires --expected-current, --expected-target, --deployment-id and --request-id from the reviewed recovery plan',
    );
  return parsed;
}

export async function runDirectRecoveryCommand(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: verity-recover-update --target ENVELOPE --updater-container ID [--check | --apply --expected-current DIGEST --expected-target DIGEST --deployment-id ID --request-id KEY]\n',
    );
    return;
  }
  const options = parseDirectRecoveryArgs(args);
  if (process.geteuid?.() !== 0)
    throw new Error('Direct recovery must run as root on the deployment host');
  const root = await volume('verity-managed-deployment');
  const control = await volume('verity-updater-control');
  const tokenPath = join(control, 'token');
  const tokenInfo = await lstat(tokenPath);
  if (
    !tokenInfo.isFile() ||
    tokenInfo.uid !== 0 ||
    tokenInfo.size > 4096 ||
    (tokenInfo.mode & 0o027) !== 0
  )
    throw new Error('Updater token has unsafe ownership or permissions');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token || token.length > 4096) throw new Error('Invalid updater token');
  const updater = { socketPath: join(control, 'updater.sock'), token };
  const state = await readUpdaterDeployment(updater);
  if (!state.managed) throw new Error('Updater does not report a managed deployment');
  const local = await readManagedDeployment(root);
  if (!isDeepStrictEqual(local, state))
    throw new Error('Local managed volume does not match the running Updater');
  const serverIds = (
    await docker([
      'ps',
      '--filter',
      `label=${MANAGED_DEPLOYMENT_LABEL}=${state.marker.deploymentId}`,
      '--filter',
      `label=${MANAGED_ROLE_LABEL}=server`,
      '--format',
      '{{.ID}}',
    ])
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (serverIds.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(serverIds[0]!))
    throw new Error('Direct recovery requires exactly one running managed Server');
  const running = z
    .array(containerDescription)
    .length(1)
    .parse(JSON.parse(await docker(['inspect', '--type=container', serverIds[0]!])))[0]!;
  const name = await docker(['inspect', '--format', '{{.Name}}', running.Id]);
  if (!new RegExp(`^/${MANAGED_SERVER_NAME}(?:-g[1-9][0-9]{0,9})?\\n?$`, 'u').test(name))
    throw new Error('Running managed Server has an invalid identity');
  const currentImage = z
    .array(imageDescription)
    .length(1)
    .parse(JSON.parse(await docker(['inspect', '--type=image', state.spec.image])))[0]!;
  if (
    running.Config.Image !== state.spec.image ||
    running.Image !== currentImage.Id ||
    running.Config.Labels[MANAGED_DEPLOYMENT_LABEL] !== state.marker.deploymentId ||
    running.Config.Labels[MANAGED_ROLE_LABEL] !== 'server'
  )
    throw new Error('Running Server does not match the sealed deployment image');
  const current = parseServerCompat(
    JSON.parse(await docker(['exec', running.Id, 'node', '--input-type=module', '--eval', probe])),
  );
  if (current === null) throw new Error('Running Server has invalid compatibility metadata');
  const plan = await planDirectRecovery({
    current: {
      deploymentId: state.marker.deploymentId,
      image: state.spec.image,
      architecture: currentImage.Architecture,
      compatibility: current,
    },
    target: await envelope(options['--target']!),
    verify: createReleaseChannelVerifier({ tufCachePath: '/var/cache/verity/direct-recovery-tuf' }),
    inspectTarget: async (image) => {
      await docker(['pull', '--platform', `linux/${currentImage.Architecture}`, image]);
      const description = z
        .array(imageDescription)
        .length(1)
        .parse(JSON.parse(await docker(['inspect', '--type=image', image])))[0]!;
      const compatibility = parseServerCompat(
        JSON.parse(
          await docker([
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--pids-limit=64',
            '--user=1000:1000',
            '--entrypoint=node',
            description.Id,
            '--input-type=module',
            '--eval',
            probe,
          ]),
        ),
      );
      if (compatibility === null)
        throw new Error('Target image has invalid compatibility metadata');
      return { architecture: description.Architecture, compatibility };
    },
  });
  const updaterId = options['--updater-container']!;
  if (!/^[a-f0-9]{12,64}$/.test(updaterId)) throw new Error('Updater container ID is invalid');
  const assertUpdater = async (): Promise<void> => {
    const raw = z
      .array(
        z.object({
          Id: z.string(),
          Image: z.string(),
          State: z.object({ Running: z.literal(true) }),
          Config: z.object({
            Image: z.string(),
            Cmd: z.array(z.string()),
            Env: z.array(z.string()),
          }),
          Mounts: z.array(
            z.object({ Source: z.string(), Destination: z.string(), RW: z.boolean() }),
          ),
        }),
      )
      .length(1)
      .parse(JSON.parse(await docker(['inspect', '--type=container', updaterId])))[0]!;
    const target = z
      .array(imageDescription)
      .length(1)
      .parse(JSON.parse(await docker(['inspect', '--type=image', plan.targetImage])))[0]!;
    if (
      raw.Config.Image !== plan.targetImage ||
      raw.Image !== target.Id ||
      raw.Config.Cmd.length !== 1 ||
      raw.Config.Cmd[0] !== 'managed-updater' ||
      raw.Mounts.some(
        (m) =>
          m.Destination === '/' || m.Destination === '/app' || m.Destination.startsWith('/app/'),
      ) ||
      !raw.Config.Env.includes(`VERITY_MANAGED_DEPLOYMENT_ID=${plan.deploymentId}`) ||
      !raw.Mounts.some(
        (m) =>
          m.Source === root &&
          m.Destination === '/var/lib/verity/updater/managed-deployment' &&
          m.RW,
      ) ||
      !raw.Mounts.some(
        (m) => m.Source === control && m.Destination === '/run/verity-updater/control' && m.RW,
      )
    )
      throw new Error(
        'Install the verified target Updater for this deployment before direct recovery',
      );
    const capability = await docker([
      'exec',
      raw.Id,
      'node',
      '--input-type=module',
      '--eval',
      "import { FORWARD_UPDATE_RECOVERY_VERSION } from '/app/packages/server/dist/self-update/compat.js'; process.stdout.write(String(FORWARD_UPDATE_RECOVERY_VERSION));",
    ]);
    if (capability.trim() !== '1') throw new Error('Updater lacks forward-update recovery safety');
    // A newly started container can share the volume while the old process still
    // owns its socket. Verify the process accepting the actual request as well.
    if ((await readUpdaterRecoveryCapability(updater)) !== 1)
      throw new Error('Updater control socket lacks forward-update recovery safety');
  };
  let updaterReady = false;
  try {
    await assertUpdater();
    updaterReady = true;
  } catch (error) {
    if (options['--apply']) throw error;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        action: options['--apply'] ? 'apply' : 'check',
        ...plan,
        updaterReady,
        requiredAction: updaterReady
          ? 'Apply the reviewed plan'
          : 'Install the verified target Updater, then repeat --check before applying',
      },
      null,
      2,
    )}\n`,
  );
  if (!options['--apply']) return;
  if (
    options['--expected-current'] !== plan.previousImage ||
    options['--expected-target'] !== plan.targetImage ||
    options['--deployment-id'] !== plan.deploymentId
  )
    throw new Error(
      'Recovery plan does not match the explicitly approved deployment and predecessor',
    );
  await assertUpdater();
  await admitBridgeRecovery({
    root,
    expectedDeploymentId: plan.deploymentId,
    expectedImage: plan.previousImage,
    targetDigest: plan.targetImage,
    idempotencyKey: options['--request-id']!,
  });
  const operation = await requestUpdaterOperation({
    ...updater,
    targetDigest: plan.targetImage,
    idempotencyKey: options['--request-id']!,
  });
  process.stdout.write(`${JSON.stringify({ operation })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDirectRecoveryCommand(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Direct recovery failed');
    process.exitCode = 1;
  });
}
