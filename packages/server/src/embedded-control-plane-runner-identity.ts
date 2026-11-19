import { SealedError } from '@verity/store';
import { chmod, chown, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { ClaudeEgressIdentityService } from './claude-egress-identity.js';
import { projectDefaultSandboxUser } from './project-sandbox.js';
import { CONTROL_PLANE_PROJECT_ID as CONTROL_PLANE_RUNNER_PROJECT_ID } from './control-plane-project.js';

export function createEmbeddedRunnerIdentityPublisher(
  getRefresh: () => (() => Promise<void>) | undefined,
): (occasion: string) => Promise<boolean> {
  /**
   * Publish the control-plane Runner identity where a failure must cost at most a
   * turn. Three callers qualify, and each one learned it the hard way: at boot a
   * throw costs the listener — and with it the `/secret/unlock` needed to repair
   * anything; in the unlock callback it costs the unlock; in the handed-off-key
   * activation it costs the key handover, which is how a promoted Server came up
   * sealed after the 13.2.4 cutover because the identity volume was still missing
   * its setgid bit. None of that is worth a certificate the next turn re-publishes
   * anyway. The two turn paths deliberately do NOT use this: there the caller is a
   * single turn that must fail closed rather than run without egress identity.
   */
  return async (occasion: string): Promise<boolean> => {
    try {
      await getRefresh()?.();
      return true;
    } catch (error) {
      console.warn(
        error instanceof SealedError
          ? `verity: control-plane Runner identity deferred until unlock (${occasion})`
          : `verity: control-plane Runner identity deferred (${occasion}): ${String(error)}`,
      );
      return false;
    }
  };
}

export async function createEmbeddedControlPlaneRunnerIdentity({
  config,
  eventStore,
  claudeEgressIdentity,
}: {
  config: Pick<
    EmbeddedServerConfig,
    'controlPlaneRunnerIdentityDir' | 'runnerRuntimeGid' | 'dataVolumeRoot'
  >;
  eventStore: Parameters<typeof projectDefaultSandboxUser>[0];
  claudeEgressIdentity: Pick<ClaudeEgressIdentityService, 'sandboxMaterial'>;
}) {
  let controlPlaneIdentityRefreshTail: Promise<void> = Promise.resolve();
  const identityDir = config.controlPlaneRunnerIdentityDir;
  const runnerRuntimeGid = config.runnerRuntimeGid ?? 1101;
  if (identityDir === undefined || identityDir.trim() === '') {
    throw new Error('VERITY_CONTROL_PLANE_RUNNER requires its private identity volume.');
  }
  const identityStats = await lstat(identityDir);
  if (
    !identityStats.isDirectory() ||
    identityStats.isSymbolicLink() ||
    identityStats.uid !== 0 ||
    identityStats.gid !== runnerRuntimeGid ||
    (identityStats.mode & 0o777) !== 0o770
  ) {
    throw new Error('control-plane Runner identity volume has unsafe ownership');
  }
  // Publishing hands each file to the Runner through the volume's setgid bit,
  // because chown() cannot (see `publish` below). Say so at boot, where an
  // operator can still act on it — but deliberately do NOT make it fatal. This
  // Server is created by the Updater from the sealed spec while the bit is set
  // by control-runner-init through compose, so the two are not ordered, and a
  // Server that refuses to boot over state its own init container repairs a
  // moment later is precisely the outage this path just came out of. A missing
  // bit surfaces again, non-fatally and with the same wording, at publish time.
  if ((identityStats.mode & 0o2000) === 0) {
    console.warn(
      'verity: control-plane Runner identity volume is missing the setgid bit (chmod 2770) — published identity will not reach the Runner group',
    );
  }
  const publish = async (name: string, value: string, mode: number): Promise<void> => {
    const target = join(identityDir, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { mode });
    await chmod(temporary, mode);
    // The Runner reads this material as the configured Runner runtime GID,
    // and it gets that group from the identity volume's setgid bit (`chmod 2770`, control-runner-init): a
    // file created here inherits the directory's group, so no ownership change
    // is needed. Handing it over with chown() only works for a Server running
    // as root — `capAdd: ['CHOWN']` cannot grant it otherwise, because Docker
    // puts an added capability in the BOUNDING set only and a non-root process
    // never receives it into permitted/effective. Attempt it for the root case,
    // tolerate the EPERM, then assert what actually matters: that the Runner's
    // group can read the file. Failing here beats publishing material the
    // Runner cannot open, which surfaces only as its start-up timeout.
    await chown(temporary, 1101, runnerRuntimeGid).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    });
    const handedOver = await lstat(temporary);
    if (handedOver.gid !== runnerRuntimeGid) {
      await rm(temporary, { force: true });
      throw new Error(
        `control-plane Runner identity volume does not hand ${name} to the Runner group — it needs the setgid bit (chmod 2770)`,
      );
    }
    await rename(temporary, target);
  };
  const refreshIdentityOnce = async (): Promise<void> => {
    const material = await claudeEgressIdentity.sandboxMaterial({
      projectId: CONTROL_PLANE_RUNNER_PROJECT_ID,
      userId: await projectDefaultSandboxUser(eventStore, CONTROL_PLANE_RUNNER_PROJECT_ID),
    });
    // The private key is deliberately NOT read back. It goes out group-readable
    // only (see below), so this process — which owns it — cannot open it, and a
    // read that always fails would make the comparison always stale and
    // republish on every turn, bumping the generation the Runner acknowledges.
    // Currency is decided on the two public files, which is sound because the
    // certificate and the key are issued as one pair: the key never changes
    // without the certificate changing with it.
    const desired = [material.caCertPem, material.clientCertPem];
    const current = await Promise.all(
      ['ca.crt', 'client.crt'].map((name) =>
        readFile(join(identityDir, name), 'utf8').catch(() => undefined),
      ),
    );
    const generation = await readFile(join(identityDir, 'generation'), 'utf8').catch(
      () => undefined,
    );
    // Metadata, not contents — the point is that this process cannot read the
    // key. An installation upgraded from the previous 0640 carries a key that is
    // CURRENT in content but still owner-readable, and the Runner refuses it. On
    // content alone nothing would ever rewrite that file, so the deployment would
    // stay broken until the certificate happened to rotate. A missing key lands
    // here too, and is republished for the same reason.
    const keyMode = await lstat(join(identityDir, 'client.key'))
      .then((stats) => stats.mode & 0o777)
      .catch(() => undefined);
    // The key's own contents can no longer be compared, so its fingerprint is
    // published beside it — AFTER the key, so an interruption between the two
    // leaves a stale fingerprint and the next pass republishes. Without it a
    // crash between `client.crt` and `client.key` would leave a mismatched pair
    // that looks current forever: the certificates agree, the mode is right, and
    // the generation from the previous pass is merely non-empty.
    const keyFingerprint = createHash('sha256').update(material.clientKeyPem).digest('hex');
    const publishedFingerprint = await readFile(
      join(identityDir, 'client.key.sha256'),
      'utf8',
    ).catch(() => undefined);
    const keyCurrent = keyMode === 0o040 && publishedFingerprint?.trim() === keyFingerprint;
    const pemCurrent = desired.every((value, index) => value === current[index]);
    if (pemCurrent && keyCurrent && generation !== undefined && generation.trim() !== '') return;
    if (!pemCurrent || !keyCurrent) {
      await publish('ca.crt', material.caCertPem, 0o640);
      await publish('client.crt', material.clientCertPem, 0o640);
      // Group read ONLY. The Runner refuses a private key whose owner can
      // still read it ("must not be owner-readable unless owned by Runner or
      // root") — and it is right to: handing the key over by ownership is
      // impossible here, because chown() to the Runner needs a capability an
      // unprivileged process cannot hold. Clearing the owner bits is what makes
      // the file private to the Runner group despite being owned by the Server.
      await publish('client.key', material.clientKeyPem, 0o040);
      await publish('client.key.sha256', keyFingerprint, 0o640);
    }
    // Published last: the sidecar reconciler never observes a half-rotated
    // certificate/key pair merely because the three PEM renames are separate.
    await publish('generation', randomUUID(), 0o640);
  };
  const refreshControlPlaneRunnerIdentity = (): Promise<void> => {
    const refresh = controlPlaneIdentityRefreshTail.then(refreshIdentityOnce, refreshIdentityOnce);
    controlPlaneIdentityRefreshTail = refresh.catch(() => undefined);
    return refresh;
  };
  const awaitControlPlaneRunnerIdentity = async (): Promise<void> => {
    if (config.dataVolumeRoot === undefined) {
      throw new Error('control-plane Runner runtime is unavailable');
    }
    const expected = (await readFile(join(identityDir, 'generation'), 'utf8')).trim();
    const acknowledgment = join(
      config.dataVolumeRoot,
      'runners',
      CONTROL_PLANE_RUNNER_PROJECT_ID,
      'claude-egress-generation',
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const actual = await readFile(acknowledgment, 'utf8').catch(() => undefined);
      if (actual?.trim() === expected) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Claude control-plane Runner did not acknowledge its egress identity.');
  };

  return { refreshControlPlaneRunnerIdentity, awaitControlPlaneRunnerIdentity };
}
