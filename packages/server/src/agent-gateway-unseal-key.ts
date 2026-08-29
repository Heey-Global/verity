import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Default control-socket path. The gateway process already defaults to exactly this
 *  (see `agent-gateway-main.ts`), so a deployment only sets the env var for a
 *  non-standard topology. */
export const DEFAULT_AGENT_GATEWAY_CONTROL_SOCKET = '/run/verity-agent-gateway/control.sock';

const UNSEAL_KEY_RELATIVE_PATH = join('agent-gateway', 'unseal-key');
/** 32 bytes hex — the same shape a host-provisioned `openssl rand -hex 32` produced. */
const UNSEAL_KEY_BYTES = 32;
const UNSEAL_KEY_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Resolve the Agent Gateway unseal key, generating and persisting one on first use.
 *
 * The unseal material is held only by the Server and handed to the gateway over the
 * private control socket, so the Server is the natural owner: no deployment needs to
 * pre-provision a secret it never reads. An explicit `VERITY_AGENT_GATEWAY_UNSEAL_KEY`
 * still wins, so existing host-provisioned deployments keep their key.
 *
 * It MUST be stable across restarts: the gateway is a separate container that outlives
 * a Server recreate, and re-generating on every boot would leave it holding a key the
 * Server no longer knows. So the generated value is persisted on the data volume
 * (0600) and reused. A corrupt/truncated file is replaced rather than trusted.
 */
export function resolveAgentGatewayUnsealKey(
  dataVolumeRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.VERITY_AGENT_GATEWAY_UNSEAL_KEY?.trim();
  if (configured !== undefined && configured.length > 0) return configured;

  const keyPath = join(dataVolumeRoot, UNSEAL_KEY_RELATIVE_PATH);
  try {
    const existing = readFileSync(keyPath, 'utf8').trim();
    if (UNSEAL_KEY_PATTERN.test(existing)) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(UNSEAL_KEY_BYTES).toString('hex');
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash mid-write cannot leave a truncated key behind, and
  // create the temp file 0600 so the secret is never briefly world-readable.
  const stagedPath = `${keyPath}.tmp`;
  writeFileSync(stagedPath, `${generated}\n`, { mode: 0o600 });
  chmodSync(stagedPath, 0o600);
  renameSync(stagedPath, keyPath);
  return generated;
}
