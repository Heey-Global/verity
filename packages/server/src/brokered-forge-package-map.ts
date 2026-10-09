import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** An administrator-owned mapping is separate from sandbox-writable repository files. */
export async function loadForgePackageMap(
  secretRoot: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  let raw: string;
  try {
    const file = join(secretRoot, 'forge-proxy', 'packages.json');
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error('untrusted forge package mapping');
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid forge package mapping');
  const result = new Map<string, readonly string[]>();
  for (const [project, names] of Object.entries(value)) {
    if (
      !project ||
      !Array.isArray(names) ||
      names.some(
        (name: unknown) =>
          typeof name !== 'string' ||
          !/^[a-z0-9][a-z0-9._/-]*$/.test(name) ||
          name.split('/').some((part) => !part || part === '.' || part === '..'),
      )
    )
      throw new Error('invalid forge package mapping');
    result.set(project, names as string[]);
  }
  return result;
}
