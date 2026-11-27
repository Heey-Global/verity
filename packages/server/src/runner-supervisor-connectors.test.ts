import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentLaunchSpec,
  probeAgentSpawnBroker,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import {
  execFileAsync,
  connectorLauncher,
  runAgentSpawnBroker,
} from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  it('does not project Claude credentials for an invalid connector URL', () => {
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'https://attacker.example',
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
        },
      },
    );
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(spec.spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('validates readable, canonical Runner-owned connector TLS material', async () => {
    const env = await connectorValidationEnv();
    await expect(
      execFileAsync(connectorLauncher, ['--validate-config'], { env }),
    ).resolves.toBeDefined();
  });

  it('rejects root identities and world-readable connector private keys', async () => {
    const env = await connectorValidationEnv();
    await expect(
      execFileAsync(connectorLauncher, ['--validate-config'], {
        env: { ...env, VERITY_RUNNER_RUNTIME_UID: '0' },
      }),
    ).rejects.toThrow(/non-root/u);
    await chmod(env.VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE, 0o644);
    await expect(execFileAsync(connectorLauncher, ['--validate-config'], { env })).rejects.toThrow(
      /other users/u,
    );
  });

  it('rejects connector TLS paths that traverse a symlink', async () => {
    const env = await connectorValidationEnv();
    const alias = join(runtimeDir, 'client-key-alias.pem');
    await symlink(env.VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE, alias);
    await expect(
      execFileAsync(connectorLauncher, ['--validate-config'], {
        env: { ...env, VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE: alias },
      }),
    ).rejects.toThrow(/TLS material/u);
  });

  it('changes the desired connector identity when TLS material rotates', async () => {
    const env = await connectorValidationEnv();
    const first = await execFileAsync(connectorLauncher, ['--config-fingerprint'], { env });
    await writeFile(env.VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE, 'rotated-test-key', { mode: 0o640 });
    const second = await execFileAsync(connectorLauncher, ['--config-fingerprint'], { env });
    expect(first.stdout).toMatch(/^[a-f0-9]{64}\n$/u);
    expect(second.stdout).toMatch(/^[a-f0-9]{64}\n$/u);
    expect(second.stdout).not.toBe(first.stdout);
  });

  it('starts the standalone connector with node resolved off the launch PATH', async () => {
    const env = await connectorValidationEnv();
    const controlDir = join(runtimeDir, 'connector-control');
    const nodeOnlyBin = join(runtimeDir, 'node-only-bin');
    await mkdir(nodeOnlyBin);
    await symlink(process.execPath, join(nodeOnlyBin, 'node'));
    const port = String(43000 + (process.pid % 20000));
    const startEnv = {
      ...env,
      // The interpreter is reachable ONLY via this extra PATH entry, mirroring
      // devcontainer images whose node lives outside the launcher's sanitized
      // /usr/local/bin:/usr/bin:/bin (the nvm Feature layout).
      PATH: `${nodeOnlyBin}:/usr/bin:/bin`,
      VERITY_CLAUDE_CONNECTOR_PORT: port,
      VERITY_CLAUDE_CONNECTOR_AUTHORITY: `127.0.0.1:${port}`,
      VERITY_CLAUDE_CONNECTOR_CONTROL_DIR: controlDir,
      VERITY_CLAUDE_CONNECTOR_BIN: resolve(
        'features/verity-sandbox-toolkit/bin/verity-egress-connector.mjs',
      ),
    };
    try {
      await execFileAsync(connectorLauncher, ['--standalone'], { env: startEnv });
      const ready = await fetch(`http://127.0.0.1:${port}/__verity/ready`);
      expect(((await ready.json()) as { ready?: boolean }).ready).toBe(true);
    } finally {
      const pidLine = await readFile(join(controlDir, 'egress-connector.pid'), 'utf8').catch(
        () => '',
      );
      const pid = Number(pidLine.split(' ')[0]);
      if (Number.isInteger(pid) && pid > 1) process.kill(pid);
    }
  });

  // The launcher hands the connector a sanitized environment (env -i plus an
  // explicit allowlist), so a variable the Sandbox carries reaches the process
  // only if this list names it. Both Codex variables were missing from it: the
  // Sandbox was provisioned with a Codex gateway, the connector came up without
  // one, and every Codex turn was answered with "Codex egress is not configured
  // for this Sandbox". No recreate could repair that, because the Sandbox env
  // was never the thing at fault.
  it('passes the Codex gateway through the sanitized launch environment', async () => {
    const env = await connectorValidationEnv();
    const controlDir = join(runtimeDir, 'codex-connector-control');
    // Below the default ephemeral range (32768–60999) so the listener cannot
    // collide with a socket the test host handed out on its own.
    const port = String(21000 + (process.pid % 10000));
    const startEnv = {
      ...env,
      VERITY_CLAUDE_CONNECTOR_PORT: port,
      VERITY_CLAUDE_CONNECTOR_AUTHORITY: `127.0.0.1:${port}`,
      VERITY_CLAUDE_CONNECTOR_CONTROL_DIR: controlDir,
      VERITY_CLAUDE_CONNECTOR_BIN: resolve(
        'features/verity-sandbox-toolkit/bin/verity-egress-connector.mjs',
      ),
      // Closed port rather than a hostname: the assertion is about which leg the
      // connector believes it has, so the failure has to be the gateway refusing
      // rather than a resolver the test host may or may not have.
      VERITY_CODEX_EGRESS_URL: 'https://127.0.0.1:1',
      VERITY_CODEX_EGRESS_AUTHORITY: 'codex-gateway.internal:8444',
    };
    try {
      await execFileAsync(connectorLauncher, ['--standalone'], { env: startEnv });
      const response = await fetch(`http://127.0.0.1:${port}/codex/responses`, {
        method: 'POST',
        body: '{}',
      });
      const body = await response.text();
      expect(response.status).toBe(502);
      // A configured leg fails at the gateway. An unconfigured one refuses before
      // it ever gets there, and that is the regression.
      expect(body).toContain('Codex egress unavailable');
      expect(body).not.toContain('not configured for this Sandbox');
    } finally {
      const pidLine = await readFile(join(controlDir, 'egress-connector.pid'), 'utf8').catch(
        () => '',
      );
      const pid = Number(pidLine.split(' ')[0]);
      // Cleanup must not mask a failed assertion: the process may already be
      // gone if the launcher never got it running.
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid);
        } catch {
          /* already exited */
        }
      }
    }
  });

  it('probes the privileged spawn broker without starting an agent', async () => {
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
    });
    await expect(probeAgentSpawnBroker(runtimeDir)).resolves.toBe(true);
    await broker.close();
    await expect(probeAgentSpawnBroker(runtimeDir, 50)).resolves.toBe(false);
  });

  it('rejects a missing worktree root before acquiring the broker lock', async () => {
    await expect(
      runAgentSpawnBroker({
        runtimeDir,
        enforceRoot: false,
        worktreeRoot: join(runtimeDir, 'missing-worktree'),
        agentUid: 1000,
        agentGid: 1000,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // A failed preflight must not strand a FileHandle for garbage collection.
    await expect(readFile(join(runtimeDir, 'agent-spawn-broker.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function connectorValidationEnv(): Promise<
  NodeJS.ProcessEnv & {
    VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE: string;
  }
> {
  const ca = join(runtimeDir, 'ca.pem');
  const cert = join(runtimeDir, 'client-cert.pem');
  const key = join(runtimeDir, 'client-key.pem');
  await Promise.all([
    writeFile(ca, 'test-ca'),
    writeFile(cert, 'test-cert'),
    writeFile(key, 'test-key', { mode: 0o640 }),
  ]);
  await chmod(key, 0o640);
  return {
    PATH: process.env.PATH,
    VERITY_RUNNER_RUNTIME_UID: String(process.getuid?.() ?? 1000),
    VERITY_RUNNER_RUNTIME_GID: String(process.getgid?.() ?? 1000),
    VERITY_CLAUDE_CONNECTOR_PORT: '47821',
    VERITY_CLAUDE_CONNECTOR_AUTHORITY: '127.0.0.1:47821',
    VERITY_CLAUDE_EGRESS_URL: 'https://gateway.internal:8443',
    VERITY_CLAUDE_EGRESS_AUTHORITY: 'gateway.internal:8443',
    VERITY_CLAUDE_EGRESS_CA: ca,
    VERITY_CLAUDE_EGRESS_CERT: cert,
    VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE: key,
  };
}
