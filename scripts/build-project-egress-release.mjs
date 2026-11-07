/** Assemble the fixed host payload from release-built artifacts, never host downloads. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [destination, objects, node = process.execPath] = process.argv.slice(2);
const augment = objects === '--protected-toolchain';
if (!destination || !objects)
  throw new Error(
    'Usage: build-project-egress-release.mjs DESTINATION BPF_OBJECT_DIRECTORY [NODE]',
  );
const files = augment
  ? new Map([
      [
        'devcontainer.js',
        await realpath(
          node === process.execPath ? '/usr/local/bin/devcontainer' : join(node, 'devcontainer.js'),
        ),
      ],
      [
        'docker-buildx',
        node === process.execPath
          ? '/usr/local/lib/docker/cli-plugins/docker-buildx'
          : join(node, 'docker-buildx'),
      ],
      [
        'protected-build-attempt',
        node === process.execPath
          ? '/opt/verity-install/deploy/buildkit/protected-build-attempt'
          : join(node, 'protected-build-attempt'),
      ],
    ])
  : new Map([
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
if (augment) {
  /** @type {unknown} */
  const existing = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
  if (!existing || typeof existing !== 'object' || Array.isArray(existing))
    throw new Error('Invalid release manifest');
  for (const [name, digest] of Object.entries(existing)) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error(`Invalid release artifact digest: ${name}`);
    manifest[name] = digest;
  }
}
for (const [name, source] of files) {
  if (!(await lstat(source)).isFile())
    throw new Error(`Expected regular release artifact: ${name}`);
  const target = resolve(destination, name);
  await copyFile(source, target);
  await chmod(
    target,
    ['node', 'docker-buildx', 'protected-build-attempt'].includes(name) ? 0o555 : 0o444,
  );
  manifest[name] = createHash('sha256')
    .update(await readFile(target))
    .digest('hex');
}
if (augment) {
  const toolkit = process.env.VERITY_BUNDLED_PROTECTED_TOOLKIT_FEATURE ?? '';
  if (
    toolkit &&
    !/^ghcr\.io\/heey-global\/verity\/verity-sandbox-toolkit@sha256:[a-f0-9]{64}$/.test(toolkit)
  )
    throw new Error('Protected toolkit must be a release-owned digest');
  const policy = Buffer.from(
    JSON.stringify({
      nodeFeature:
        'ghcr.io/devcontainers/features/node@sha256:8c0de46939b61958041700ee89e3493f3b2e4131a06dc46b4d9423427d06e5f6',
      additionalFeatures: toolkit ? [toolkit] : [],
      nodeOptions: { version: '26.13.0' },
      toolkitOptions: { installRunnerSupervisor: true },
    }) + '\n',
  );
  await writeFile(join(destination, 'protected-build-toolchain.json'), policy, { mode: 0o444 });
  manifest['protected-build-toolchain.json'] = createHash('sha256').update(policy).digest('hex');
}
await writeFile(join(destination, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n', {
  mode: 0o444,
});

await rename(join(destination, 'manifest.json.tmp'), join(destination, 'manifest.json'));
