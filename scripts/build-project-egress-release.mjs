/** Assemble the fixed host payload from release-built artifacts, never host downloads. */
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [destination, objects, node = process.execPath] = process.argv.slice(2);
if (!destination || !objects)
  throw new Error(
    'Usage: build-project-egress-release.mjs DESTINATION BPF_OBJECT_DIRECTORY [NODE]',
  );
const files = new Map([
  ['native-runtime-pins.env', 'deploy/gvisor/versions.env'],
  ['project-egress-host-main.mjs', 'packages/server/dist/project-egress-host-main.mjs'],
  ['project-egress-deadline.py', 'deploy/egress/project-egress-deadline.py'],
  ['project-egress-deadline.bpf.o', join(objects, 'project-egress-deadline.bpf.o')],
  ['project-egress-renew.bpf.o', join(objects, 'project-egress-renew.bpf.o')],
  ['verity-egress-bootstrap.service', 'deploy/egress/verity-egress-bootstrap.service'],
  ['verity-egress-host.service', 'deploy/egress/verity-egress-host.service'],
  ['docker-egress.conf', 'deploy/egress/docker-egress.conf'],
  ['node', node],
]);
await mkdir(destination, { recursive: true });
/** @type {Record<string, string>} */
const manifest = {};
for (const [name, source] of files) {
  if (!(await lstat(source)).isFile())
    throw new Error(`Expected regular release artifact: ${name}`);
  const target = resolve(destination, name);
  await copyFile(source, target);
  await chmod(target, name === 'node' ? 0o555 : 0o444);
  manifest[name] = createHash('sha256')
    .update(await readFile(target))
    .digest('hex');
}
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
  mode: 0o444,
});
