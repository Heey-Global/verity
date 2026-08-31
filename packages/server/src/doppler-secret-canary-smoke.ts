import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BrokeredToolCall } from './brokered-http-tool.js';

import { runAgentSpawnBroker } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { runTrustedCliViaBroker } from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import { resolveDopplerProjectSecret } from './doppler-secret-resolver.js';
import { createBrokeredHttpTool } from './brokered-http-tool.js';
import { createTrustedCliTool } from './trusted-cli-tool.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
};

const token = required('VERITY_SECRET_CANARY_DOPPLER_TOKEN');
const dopplerProject = required('VERITY_SECRET_CANARY_DOPPLER_PROJECT');
const dopplerConfig = required('VERITY_SECRET_CANARY_DOPPLER_CONFIG');
const secretAlias = required('VERITY_SECRET_CANARY_ALIAS');
const expectedHash = required('VERITY_SECRET_CANARY_SHA256');
const binding = { dopplerProject, dopplerConfig };
const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const runtimeDir = await mkdtemp(join(tmpdir(), 'verity-secret-canary-'));
const secretDir = join(runtimeDir, 'trusted-cli-secrets');
const envHashEntryPath = resolve('packages/server/dist/doppler-secret-canary-env-hash.js');
const envHashEntrySha256 = sha256(await readFile(envHashEntryPath));
const resolveSecret = (input: {
  projectId: string;
  dopplerProject: string;
  dopplerConfig: string;
  secretName: string;
}) => resolveDopplerProjectSecret({ ...input, token: Buffer.from(token, 'utf8') });

const httpTool = createBrokeredHttpTool({
  getProjectBinding: () => Promise.resolve(binding),
  resolveSecret,
  consumeApproval: () => Promise.resolve(true),
  transport: async (request) => {
    await request.authorizeRequest();
    const authorization = request.headers.authorization;
    if (
      authorization === undefined ||
      sha256(authorization.replace(/^Bearer /u, '')) !== expectedHash
    ) {
      throw new Error('HTTP canary hash mismatch');
    }
    return { status: 204, body: null };
  },
});

const cliTool = createTrustedCliTool({
  getProjectBinding: () => Promise.resolve(binding),
  resolveSecret,
  consumeApproval: () => Promise.resolve(true),
});
const httpCall: BrokeredToolCall = {
  id: 'canary-http',
  name: 'verity_http_request',
  input: {
    method: 'GET',
    url: 'https://canary.invalid/health',
    secretAlias,
    auth: { header: 'authorization', scheme: 'Bearer' },
  },
};
const cliCall = (id: string, injection: 'env' | 'file'): BrokeredToolCall => ({
  id,
  name: 'verity_secret_run',
  input: {
    command:
      injection === 'env'
        ? ['/usr/bin/node', envHashEntryPath]
        : ['/usr/bin/sha256sum', join(secretDir, 'CANARY_FILE')],
    ...(injection === 'env'
      ? {
          entryScript: {
            path: envHashEntryPath,
            projectPath: 'packages/server/dist/doppler-secret-canary-env-hash.js',
            sha256: envHashEntrySha256,
            loading: 'isolated',
          },
        }
      : {}),
    secrets: [{ secretAlias, env: `CANARY_${injection.toUpperCase()}`, injection }],
  },
});

const turnDir = join(runtimeDir, 'turns', 'canary-turn');
await mkdir(turnDir, { recursive: true });
await writeFile(
  join(turnDir, 'request.json'),
  `${JSON.stringify({
    turnId: 'canary-turn',
    cwd: process.cwd(),
    backend: 'codex-acp',
    trustedCliExecution: true,
  })}\n`,
);
const broker = await runAgentSpawnBroker({
  runtimeDir,
  enforceRoot: true,
  agentUid: Number(process.env.SUDO_UID ?? 1000),
  agentGid: Number(process.env.SUDO_GID ?? 1000),
  worktreeRoot: process.cwd(),
  secretDir,
});
try {
  const execute = async (input: {
    turnId: string;
    secrets: readonly {
      secretAlias: string;
      env: string;
      injection?: 'env' | 'file';
      secret: string;
    }[];
    command: readonly string[];
  }) => {
    const result = await runTrustedCliViaBroker(
      { ...input, secrets: [...input.secrets], command: [...input.command] },
      { runtimeDir, brokerSocket: broker.socketPath },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.timedOut === true ? { timedOut: true as const } : {}),
      ...(result.truncated === true ? { truncated: true as const } : {}),
    };
  };
  const [http, env, file] = await Promise.all([
    httpTool('canary-project', 'canary-session', 'canary-turn', httpCall),
    cliTool(
      'canary-project',
      'canary-session',
      'canary-turn',
      cliCall('canary-env', 'env'),
      execute,
    ),
    cliTool(
      'canary-project',
      'canary-session',
      'canary-turn',
      cliCall('canary-file', 'file'),
      execute,
    ),
  ]);
  const fileHash = file.stdout.trim().split(/\s+/u)[0];
  if (
    http.status !== 204 ||
    env.exitCode !== 0 ||
    env.stdout.trim() !== expectedHash ||
    file.exitCode !== 0 ||
    fileHash !== expectedHash
  ) {
    throw new Error('secret canary returned an unexpected result');
  }
  process.stdout.write('brokered secret canary passed (hash verified)\n');
} finally {
  await broker.close();
  await rm(runtimeDir, { recursive: true, force: true });
}
