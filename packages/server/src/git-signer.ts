import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Server-side SSH commit-signing broker (audit finding H1). Today the fleet
 * signing PRIVATE key is mounted into every sandbox, so a compromised package
 * can `cat` it and forge "verified" commits across every repo, permanently. This
 * broker keeps the private key server-side: the sandbox's `git commit -S` calls a
 * `gpg.ssh.program` wrapper that forwards the payload here; we sign it and return
 * only the signature. That turns key THEFT (permanent, portable) into signing-
 * ORACLE use (only while the container runs, non-exfiltratable) — the H1 win.
 *
 * git invokes the signing program as `-Y sign -n git -f <pubkey> <bufferfile>`
 * and reads back `<bufferfile>.sig`; the wrapper reproduces that `.sig` from this
 * broker's response. Only the `git` namespace is allowed — a sandbox must not be
 * able to coax the broker into signing SSH auth challenges or other namespaces.
 */

/** The only signing namespace the broker will produce. git uses `git` for both
 *  commit and tag signatures. */
export const GIT_SIGN_NAMESPACE = 'git';
export const SIGNING_BROKER_TOKEN_FILE = '/run/verity/ssh/signing_broker_token';
export const SIGNING_BROKER_TOKEN_HASH_LABEL = 'dev.heey.verity.signing-broker-token-sha256';

/**
 * Injectable seam: run `ssh-keygen -Y sign -n <namespace> -f <keyPath>
 * <payloadPath>`, producing `<payloadPath>.sig`. The production runner shells out
 * to the real `ssh-keygen` (needs `openssh-client` in the image); tests inject a
 * fake so the unit suite never depends on the binary. On non-zero exit it MUST
 * reject.
 */
export type SshSignSpawner = (args: {
  keyPath: string;
  namespace: string;
  payloadPath: string;
}) => Promise<void>;

export const defaultSshSignSpawner: SshSignSpawner = async ({
  keyPath,
  namespace,
  payloadPath,
}) => {
  // `-Y sign` needs only the private key (it derives the public key); it writes
  // the armored signature to `<payloadPath>.sig`.
  await execFileAsync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', keyPath, payloadPath]);
};

export class GitSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitSignError';
  }
}

export function signingBrokerTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The effective fleet signing PRIVATE key for the broker, resolved from Verity
 * settings: prefer the DB-stored contents (`gitSshPrivateKey`, e.g. the in-app
 * generate flow), else fall back to reading the file at `gitSshPrivateKeyPath` —
 * how the fleet actually provisions the key (mounted into the server container).
 * Both the provisioner (which derives + injects the sandbox token) and the signing
 * endpoint (which validates it + signs) MUST resolve through here so they agree on
 * the exact key bytes. Returns null when neither yields a non-empty key (→ broker
 * off / 409), swallowing a read error rather than throwing. `readFile` is injected
 * in tests; production reads it synchronously from the server's own filesystem.
 */
export function resolveSigningPrivateKey(
  settings:
    { gitSshPrivateKey?: string | null; gitSshPrivateKeyPath?: string | null } | null | undefined,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | null {
  const contents = settings?.gitSshPrivateKey;
  if (contents !== undefined && contents !== null && contents.trim().length > 0) {
    return contents;
  }
  const path = settings?.gitSshPrivateKeyPath;
  if (path !== undefined && path !== null && path.trim().length > 0) {
    try {
      const fromFile = readFile(path);
      if (fromFile.trim().length > 0) return fromFile;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * SSH-sign a git commit/tag payload with the fleet signing private key and return
 * the armored `-----BEGIN SSH SIGNATURE-----` blob. The key + payload are written
 * to a 0700 temp dir (the key at 0600, as `ssh-keygen` requires) and the whole
 * dir is wiped in a `finally` — even on failure — so no private-key material
 * lingers on disk. Refuses any namespace other than `git`.
 */
export async function signGitPayload(
  privateKey: string,
  payload: Buffer,
  namespace: string,
  spawn: SshSignSpawner = defaultSshSignSpawner,
): Promise<string> {
  if (namespace !== GIT_SIGN_NAMESPACE) {
    throw new GitSignError(
      `refusing to sign in namespace '${namespace}' (only '${GIT_SIGN_NAMESPACE}')`,
    );
  }
  if (privateKey.trim().length === 0) {
    throw new GitSignError('no signing key is configured');
  }
  const dir = mkdtempSync(join(tmpdir(), 'verity-gitsign-'));
  const keyPath = join(dir, 'key');
  const payloadPath = join(dir, 'payload');
  try {
    writeFileSync(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
    });
    writeFileSync(payloadPath, payload);
    await spawn({ keyPath, namespace, payloadPath });
    const signature = readFileSync(`${payloadPath}.sig`, 'utf8');
    // Defensive: only ever hand back a real armored SSH signature. The default
    // spawner (ssh-keygen) writes the `.sig` only on success, but this guards any
    // alternate/faulty spawner from letting an empty or malformed blob through.
    if (!signature.includes('BEGIN SSH SIGNATURE')) {
      throw new GitSignError('signer produced no valid SSH signature');
    }
    return signature;
  } finally {
    // ALWAYS wipe — even on a spawner/read failure — so the private key never
    // survives the request. `force` no-ops if the dir is already gone.
    rmSync(dir, { recursive: true, force: true });
  }
}
