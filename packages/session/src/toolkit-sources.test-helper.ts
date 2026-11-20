import { readdir, readFile } from 'node:fs/promises';

/**
 * The source modules of a bundled toolkit binary, joined: the code of record.
 * The shipped `bin/` file is built from them, and the bundler rewrites quotes
 * and may rename, so literals asserted on must be read here.
 */
export async function toolkitSources(binary: 'runner-supervisor' | 'spawn-broker') {
  const dir = new URL(`../../../features/verity-sandbox-toolkit/src/${binary}/`, import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.mjs')).sort();
  return (await Promise.all(files.map((file) => readFile(new URL(file, dir), 'utf8')))).join('\n');
}
