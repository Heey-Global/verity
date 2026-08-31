import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Injectable spawner seam for server-side SSH signing-key generation (#320,
 * onboarding PR 2b). Given a comment and a target key path (the private key; the
 * public key lands at `<keyPath>.pub`), it runs `ssh-keygen -t ed25519` and
 * resolves on success. Kept injectable so unit tests never shell out to a real
 * `ssh-keygen` — the production runner provides {@link defaultSshKeygenSpawner},
 * which needs the `openssh-client` apt package present in the image.
 *
 * On a non-zero exit it MUST reject (the production runner surfaces a real
 * `ExecFileException` via `execFileAsync`).
 */
export type SshKeygenSpawner = (args: { comment: string; keyPath: string }) => Promise<void>;

/** Real `ssh-keygen` spawner: generates an unencrypted (`-N ''`) ed25519 keypair
 *  in OpenSSH format at `keyPath` (+ `keyPath.pub`). Not exercised by the unit
 *  suite (it shells out); the generation LOGIC is covered through an injected
 *  fake. `-N ''` = no passphrase (the private key is encrypted at rest by the
 *  Verity cipher, not by an SSH passphrase). */
export const defaultSshKeygenSpawner: SshKeygenSpawner = async ({ comment, keyPath }) => {
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath]);
};

/** An ed25519 signing keypair in OpenSSH format, plus the derived
 *  `allowed_signers` line. The private key is returned to the CALLER (the route)
 *  only so it can be persisted encrypted — it is NEVER put on the wire. */
export interface GeneratedSigningKey {
  /** OpenSSH-format private key (`-----BEGIN OPENSSH PRIVATE KEY-----`). */
  privateKey: string;
  /** OpenSSH public key line (`ssh-ed25519 AAAA... <comment>`). */
  publicKey: string;
  /** `<email> namespaces="git" <publicKey>` when an email is provided, else the
   *  namespace line WITHOUT a principal (`namespaces="git" <publicKey>`), which
   *  is not yet a complete allowed_signers entry — the caller signals that the
   *  email is still needed. */
  allowedSigners: string;
}

/**
 * Derive a git `allowed_signers` line for a signing pubkey. With an email it is
 * the canonical `<email> namespaces="git" <publicKey>`. Without one (the operator
 * hasn't set `gitUserEmail` yet) the principal is omitted — the caller returns
 * the pubkey anyway and notes the email is still required; a principal-less line
 * is never persisted as a working entry.
 */
export function deriveAllowedSigners(publicKey: string, email: string | null): string {
  const pub = publicKey.trim();
  const principal = email?.trim() ?? '';
  // A valid email carries no whitespace; reject one that does (e.g. an embedded
  // newline) rather than emit a malformed multi-line allowed_signers entry — fall
  // back to the principal-less form.
  const safePrincipal = principal.length > 0 && !/\s/.test(principal) ? principal : '';
  return safePrincipal ? `${safePrincipal} namespaces="git" ${pub}` : `namespaces="git" ${pub}`;
}

/**
 * Generate an ed25519 OpenSSH-format signing keypair in a private, ephemeral
 * temp dir and return both key materials + the derived allowed_signers line.
 *
 * The temp dir is created 0700 via {@link mkdtempSync} and ALWAYS removed in a
 * `finally` (even when the spawner throws) so the private key never lingers on
 * disk. The private key is read back and returned to the caller purely so it can
 * be encrypted at rest — this function does not log it and the route never puts
 * it on the wire.
 *
 * @param email  `gitUserEmail` for the allowed_signers principal + the key
 *               comment; `null`/absent → comment falls back to `verity` and the
 *               allowed_signers line omits the principal (see
 *               {@link deriveAllowedSigners}).
 * @param spawn  Injectable `ssh-keygen` seam (tests pass a fake).
 */
export async function generateSigningKey(
  email: string | null,
  spawn: SshKeygenSpawner = defaultSshKeygenSpawner,
): Promise<GeneratedSigningKey> {
  const comment = email && email.trim().length > 0 ? email.trim() : 'verity';
  // `mkdtemp` creates the directory with 0700 (owner-only) by default — the
  // private key never sits in a world-readable location.
  const dir = mkdtempSync(join(tmpdir(), 'verity-signkey-'));
  const keyPath = join(dir, 'key');
  try {
    await spawn({ comment, keyPath });
    const privateKey = readFileSync(keyPath, 'utf8');
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
    return {
      privateKey,
      publicKey,
      allowedSigners: deriveAllowedSigners(publicKey, email),
    };
  } finally {
    // ALWAYS wipe the temp dir — even on a spawner/read failure — so no private
    // key material is left behind. `force` makes it a no-op if the dir is gone.
    rmSync(dir, { recursive: true, force: true });
  }
}
