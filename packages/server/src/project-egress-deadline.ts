import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ProjectFenceBinding } from './project-egress-fence.js';

const UINT64_MAX = (1n << 64n) - 1n;
const decimal = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/u)
  .refine((value) => BigInt(value) <= UINT64_MAX, 'Clock exceeds kernel uint64 range');
const clockSchema = z.strictObject({
  bootId: z.uuid(),
  realNs: decimal,
  bootBeforeNs: decimal,
  bootAfterNs: decimal,
});
export type ProjectDeadlineClock = z.infer<typeof clockSchema>;
export interface ProjectDeadlineLease {
  readonly bootId: string;
  readonly binding: string;
  readonly revision: number;
  readonly nonce: string;
  readonly capturedBootNs: string;
  readonly bootDeadlineNs: string;
  readonly authorityExpiresAt: number | null;
}
const PROJECT_DEADLINE_MAX_NS = 1_000_000_000n;

/** A delayed executor receives absolute values, never a duration to restart. */
export function projectDeadlineLease(
  binding: ProjectFenceBinding,
  revision: number,
  authorityExpiresAt: number | null,
  sample: ProjectDeadlineClock,
): ProjectDeadlineLease {
  const clock = clockSchema.parse(sample);
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('Invalid deadline policy revision');
  if (
    authorityExpiresAt !== null &&
    (!Number.isSafeInteger(authorityExpiresAt) ||
      authorityExpiresAt < 0 ||
      BigInt(authorityExpiresAt) * 1_000_000n > UINT64_MAX)
  )
    throw new Error('Invalid authority expiry');
  const before = BigInt(clock.bootBeforeNs);
  const after = BigInt(clock.bootAfterNs);
  if (after < before || after - before > 1_000_000n)
    throw new Error('Deadline clock sample is not bounded');
  const remaining =
    authorityExpiresAt === null
      ? PROJECT_DEADLINE_MAX_NS
      : BigInt(authorityExpiresAt) * 1_000_000n - BigInt(clock.realNs);
  // The earlier BOOTTIME sample is conservative across the clock read itself.
  const duration = remaining < PROJECT_DEADLINE_MAX_NS ? remaining : PROJECT_DEADLINE_MAX_NS;
  if (duration > 0n && before + duration > UINT64_MAX)
    throw new Error('Deadline exceeds kernel uint64 range');
  return Object.freeze({
    bootId: clock.bootId,
    binding: createHash('sha256')
      .update(
        JSON.stringify([
          binding.projectId,
          binding.generation,
          binding.containerId,
          binding.networkId,
          binding.endpointId,
          binding.bridge,
          binding.ipv4,
          binding.ipv6,
        ]),
      )
      .digest('hex'),
    revision,
    nonce: randomBytes(16).toString('hex'),
    capturedBootNs: before.toString(),
    bootDeadlineNs: (duration > 0n ? before + duration : 0n).toString(),
    authorityExpiresAt,
  });
}

export interface ProjectDeadlineEnforcer {
  /** Attach and attest both software hooks in a denied state. */
  prepare(binding: ProjectFenceBinding): Promise<void>;
  clock(): Promise<ProjectDeadlineClock>;
  /** Must preserve the given absolute deadline even after arbitrarily late commit. */
  arm(binding: ProjectFenceBinding, lease: ProjectDeadlineLease): Promise<void>;
  revoke(binding: ProjectFenceBinding): Promise<void>;
}

/** Fixed root-owned helper; no executable or namespace comes from a project. */
export function hostProjectDeadlineEnforcer(): ProjectDeadlineEnforcer {
  const request = (input: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['/opt/verity-egress/project-egress-deadline.py'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5000,
        killSignal: 'SIGKILL',
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TZ: 'UTC' },
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 16384) {
          child.kill('SIGKILL');
          reject(new Error('Oversized host deadline response'));
        }
      });
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) return reject(new Error('Host packet deadline operation failed'));
        try {
          resolve(JSON.parse(output) as unknown);
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Invalid host deadline response'));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  const denied = z.strictObject({ state: z.literal('denied') });
  return {
    async prepare(binding) {
      denied.parse(await request({ operation: 'prepare', binding }));
    },
    async clock() {
      return clockSchema.parse(await request({ operation: 'clock' }));
    },
    async arm(binding, lease) {
      const result = z
        .strictObject({ state: z.literal('armed'), bootDeadlineNs: decimal })
        .parse(await request({ operation: 'arm', binding, lease }));
      if (result.bootDeadlineNs !== lease.bootDeadlineNs)
        throw new Error('Host changed immutable packet deadline');
    },
    async revoke(binding) {
      denied.parse(await request({ operation: 'revoke', binding }));
    },
  };
}
