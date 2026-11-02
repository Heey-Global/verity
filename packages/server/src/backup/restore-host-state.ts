import { createHash, createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { validateReadableIdentity } from './restore-identity.js';
import { readBounded, writeDurable } from './repository.js';

const FILES = [
  'deployment-id',
  'pairing-identity.pem',
  'tls-key.pem',
  'tls-cert.pem',
  'tls-ca-key.pem',
  'tls-ca-cert.pem',
  'pairing-code',
  'pairing-expires-at',
  'pairing-uri',
  'compose-project',
  'updater-token',
  'postgres-password',
  'installation-id',
  'backup-dir',
  'backup-server-image',
  'backup-postgres-password',
] as const;
const fileSchema = z
  .object({
    name: z.enum(FILES),
    mode: z.number().int().min(0).max(0o777),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    size: z
      .number()
      .int()
      .min(0)
      .max(1024 * 1024),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const schema = z
  .object({
    format: z.literal(1),
    jobId: z.string().uuid(),
    files: z.array(fileSchema).max(FILES.length),
  })
  .strict()
  .refine((state) => new Set(state.files.map((file) => file.name)).size === state.files.length);
type SavedFile = z.infer<typeof fileSchema>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function readFile(
  root: string,
  name: string,
): Promise<{ metadata: SavedFile; bytes: Buffer }> {
  const file = await open(
    join(root, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw new Error('Invalid recovery host state file');
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== info.size) throw new Error('Recovery host state changed');
    } catch (error) {
      buffer.fill(0);
      throw error;
    }
    const bytes = buffer.subarray(0, offset);
    return {
      metadata: fileSchema.parse({
        name,
        mode: info.mode & 0o777,
        uid: info.uid,
        gid: info.gid,
        size: bytes.length,
        digest: digest(bytes),
      }),
      bytes,
    };
  } finally {
    await file.close();
  }
}
async function put(root: string, metadata: SavedFile, bytes: Buffer): Promise<void> {
  await writeDurable(join(root, metadata.name), bytes, false);
  await chmod(join(root, metadata.name), metadata.mode);
  await chown(join(root, metadata.name), metadata.uid, metadata.gid);
  const file = await open(join(root, metadata.name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function state(root: string, jobId: string) {
  const value = schema.parse(
    JSON.parse((await readBounded(join(root, 'host-manifest'), 32768)).toString()),
  );
  if (value.jobId !== jobId) throw new Error('Host checkpoint belongs to another restore');
  return value;
}

/** Record original presence, permissions and content digests before publishing any host configuration. */
export async function saveRestoreHostState(
  live: string,
  checkpoint: string,
  jobId: string,
): Promise<void> {
  z.string().uuid().parse(jobId);
  await mkdir(checkpoint, { recursive: true, mode: 0o700 });
  let saved: z.infer<typeof schema>;
  try {
    saved = await state(checkpoint, jobId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const files: SavedFile[] = [];
    for (const name of FILES) {
      try {
        const current = await readFile(live, name);
        files.push(current.metadata);
        current.bytes.fill(0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    saved = schema.parse({ format: 1, jobId, files });
    await writeDurable(join(checkpoint, 'host-manifest'), Buffer.from(JSON.stringify(saved)), true);
  }
  for (const metadata of saved.files) {
    try {
      const bytes = await readBounded(join(checkpoint, metadata.name), 1024 * 1024);
      try {
        if (digest(bytes) !== metadata.digest || bytes.length !== metadata.size)
          throw new Error('Saved host state mismatch');
      } finally {
        bytes.fill(0);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const current = await readFile(live, metadata.name);
      try {
        if (current.metadata.digest !== metadata.digest || current.metadata.size !== metadata.size)
          throw new Error('Host state changed since checkpoint intent', { cause: error });
        await put(checkpoint, metadata, current.bytes);
      } finally {
        current.bytes.fill(0);
      }
    }
  }
  await writeDurable(join(checkpoint, 'host-saved'), Buffer.from(jobId), false);
}

/** Validate the complete immutable source before replacing any live file. Retry repeats the same writes. */
export async function publishRestoreHostState(
  source: string,
  live: string,
  jobId?: string,
): Promise<void> {
  let files: SavedFile[];
  if (jobId) {
    if ((await readBounded(join(source, 'host-saved'), 128)).toString() !== jobId)
      throw new Error('Host checkpoint is incomplete');
    files = (await state(source, jobId)).files;
  } else {
    files = [];
    for (const name of FILES) {
      try {
        const current = await readFile(source, name);
        files.push(current.metadata);
        current.bytes.fill(0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const contents = new Map<string, Buffer>();
  try {
    for (const metadata of files) {
      const current = await readFile(source, metadata.name);
      if (current.metadata.digest !== metadata.digest || current.metadata.size !== metadata.size) {
        current.bytes.fill(0);
        throw new Error('Host publication source changed');
      }
      contents.set(metadata.name, current.bytes);
    }
    if (!jobId) {
      for (const name of [
        'deployment-id',
        'pairing-identity.pem',
        'tls-key.pem',
        'tls-cert.pem',
        'tls-ca-key.pem',
        'tls-ca-cert.pem',
        'installation-id',
        'updater-token',
        'postgres-password',
        'compose-project',
      ])
        if (!contents.has(name)) throw new Error('Prepared host configuration is incomplete');
      const identity = validateReadableIdentity(contents);
      if (!identity.ca.checkPrivateKey(createPrivateKey(contents.get('tls-ca-key.pem')!)))
        throw new Error('Prepared host CA key mismatch');
      z.string().uuid().parse(contents.get('installation-id')!.toString());
      for (const name of ['updater-token', 'postgres-password'])
        if (!/^[a-f0-9]{64}$/.test(contents.get(name)!.toString()))
          throw new Error('Prepared host credential invalid');
    }
    for (const name of FILES) {
      try {
        const info = await lstat(join(live, name));
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error('Invalid live host state file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const metadata of files) await put(live, metadata, contents.get(metadata.name)!);
    for (const name of FILES) if (!contents.has(name)) await rm(join(live, name), { force: true });
    const directory = await open(
      live,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    for (const bytes of contents.values()) bytes.fill(0);
  }
}
