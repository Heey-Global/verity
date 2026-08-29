import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, rename, unlink, writeFile } from 'node:fs/promises';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;

/**
 * The Updater-owned control directory both sides of the gate agree on.
 *
 * Exported because the marker only works if the volume mounted here by the
 * sealed deployment spec is the same directory this module writes into. Two
 * literals would let those drift silently — the writer would succeed and the
 * waiting Server would block forever on a path nothing publishes to.
 */
export const ACTIVATION_GATE_DIRECTORY = '/run/verity-updater/control';

export function activationGatePath(operationId: string): string {
  if (!ID.test(operationId)) throw new Error('activation gate operation id is invalid');
  return `${ACTIVATION_GATE_DIRECTORY}/activate-${operationId}`;
}

export async function openActivationGate(operationId: string, peerGid: number): Promise<void> {
  if (!Number.isSafeInteger(peerGid) || peerGid < 0)
    throw new Error('activation gate peer gid is invalid');
  const path = activationGatePath(operationId);
  const validate = async (
    file: Awaited<ReturnType<typeof open>>,
    expectedGid: number,
  ): Promise<void> => {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.gid !== expectedGid ||
      (info.mode & 0o040) === 0 ||
      (info.mode & 0o027) !== 0
    )
      throw new Error('activation gate must be a private root-owned, peer-readable regular file');
    if ((await file.readFile('utf8')).trim() !== operationId)
      throw new Error('activation gate belongs to another operation');
  };
  try {
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await validate(existing, peerGid);
      return;
    } finally {
      await existing.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}.next`;
  try {
    await writeFile(temporary, `${operationId}\n`, { flag: 'wx', mode: 0o600 });
    const file = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== 0)
        throw new Error('activation gate must be a root-owned regular file');
      await file.chown(0, peerGid);
      await file.chmod(0o640);
      await validate(file, peerGid);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function waitForActivationGate(
  operationId: string,
  options: {
    readonly openFile?: (path: string) => Promise<{
      stat(): Promise<{ isFile(): boolean; uid: number; gid: number; mode: number }>;
      readFile(encoding: 'utf8'): Promise<string>;
      close(): Promise<void>;
    }>;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const path = activationGatePath(operationId);
  const openFile =
    options.openFile ??
    ((target: string) => open(target, constants.O_RDONLY | constants.O_NOFOLLOW));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    let file;
    try {
      file = await openFile(path);
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== 0 ||
        info.gid !== process.getegid?.() ||
        (info.mode & 0o040) === 0 ||
        (info.mode & 0o027) !== 0
      )
        throw new Error('activation gate must be a private root-owned, peer-readable regular file');
      if ((await file.readFile('utf8')).trim() !== operationId)
        throw new Error('activation gate belongs to another operation');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await sleep(250);
    } finally {
      await file?.close();
    }
  }
}
