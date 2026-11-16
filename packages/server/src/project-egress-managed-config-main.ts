/** Fixed release helper; credentials travel through private files/stdin only. */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { managedEgressConfiguration } from './project-egress-managed-config.js';
import { openProjectEgressHostStore } from './project-egress-host-runtime.js';
import { readEgressHostConfiguration } from './project-egress-host-authority.js';
import { protectedBuildRetainedImages } from './project-egress-build-retention.js';

const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Expected private output directory');
try {
  const network = process.env.VERITY_EGRESS_DEPLOYMENT_NETWORK;
  if (!network || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(network))
    throw new Error('Missing deployment network');
  const run = promisify(execFile);
  const ids = (
    await run(
      '/usr/local/bin/docker',
      [
        '--host=unix:///var/run/docker.sock',
        'ps',
        '--no-trunc',
        '-q',
        '--filter',
        'label=com.docker.compose.service=postgres',
        '--filter',
        `network=${network}`,
      ],
      { timeout: 10000, maxBuffer: 65536 },
    )
  ).stdout
    .trim()
    .split(/\s+/u);
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0]!))
    throw new Error('Ambiguous deployment database');
  const inspection = JSON.parse(
    (
      await run(
        '/usr/local/bin/docker',
        ['--host=unix:///var/run/docker.sock', 'inspect', ids[0]!],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      )
    ).stdout,
  ) as unknown;
  // Read the host resolver, not Docker's embedded DNS in the helper container.
  const resolv = await readFile(
    process.env.VERITY_EGRESS_HOST_RESOLV_CONF ?? '/host/etc/resolv.conf',
    'utf8',
  );
  const dnsServers = [...resolv.matchAll(/^\s*nameserver\s+(\S+)/gmu)]
    .map((match) => match[1]!)
    .filter((address) => isIP(address) && address !== '127.0.0.11')
    .slice(0, 3);
  const previousAuthority = await readEgressHostConfiguration(
    process.env.VERITY_EGRESS_EXISTING_AUTHORITY ?? '/host/etc/verity-egress/authority.json',
  );
  const previousRelay = await readEgressHostConfiguration(
    process.env.VERITY_EGRESS_EXISTING_RELAY ?? '/host/etc/verity-egress/relay.json',
  );
  const registry = await (
    await openProjectEgressHostStore('/var/lib/verity-egress', { preparePrivate: true })
  ).load();
  const activeRelayImages: string[] = [];
  for (const record of registry.records) {
    if (record.retired || record.containers.relay === undefined) continue;
    const inspected: unknown = JSON.parse(
      (
        await run(
          '/usr/local/bin/docker',
          ['--host=unix:///var/run/docker.sock', 'container', 'inspect', record.containers.relay],
          { timeout: 10000, maxBuffer: 1024 * 1024 },
        )
      ).stdout,
    );
    if (
      !Array.isArray(inspected) ||
      inspected.length !== 1 ||
      typeof (inspected[0] as { Config?: { Image?: unknown } }).Config?.Image !== 'string'
    )
      throw new Error('Protected relay inspection is incomplete');
    activeRelayImages.push((inspected[0] as { Config: { Image: string } }).Config.Image);
  }
  activeRelayImages.push(
    ...(await protectedBuildRetainedImages(async (id) => {
      const listed = (
        await run(
          '/usr/local/bin/docker',
          [
            '--host=unix:///var/run/docker.sock',
            'container',
            'ls',
            '--all',
            '--quiet',
            '--no-trunc',
            '--filter',
            `id=${id}`,
          ],
          { timeout: 10000, maxBuffer: 65536 },
        )
      ).stdout.trim();
      if (!listed) return undefined;
      if (listed !== id) throw new Error('Protected build retention identity mismatch');
      return (
        await run(
          '/usr/local/bin/docker',
          ['--host=unix:///var/run/docker.sock', 'container', 'inspect', id],
          { timeout: 10000, maxBuffer: 1024 * 1024 },
        )
      ).stdout;
    })),
  );
  const configuration = managedEgressConfiguration({
    env: process.env,
    databaseInspection: inspection,
    dnsServers,
    ...(previousAuthority === undefined ? {} : { previousAuthority }),
    ...(previousRelay === undefined ? {} : { previousRelay }),
    activeRelayImages,
  });
  await mkdir(output, { mode: 0o700 });
  // Reuse the installed authority's credential on upgrades; changing it here
  // would disconnect the controller before the host transaction commits.
  for (const [name, value] of [
    ['relay.json', configuration.relay],
    ['authority.json', configuration.authority],
    ['database.json', configuration.locator],
  ] as const)
    await writeFile(join(output, name), JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      '/usr/local/bin/docker',
      [
        '--host=unix:///var/run/docker.sock',
        'exec',
        '-i',
        ids[0]!,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'verity',
        '-d',
        configuration.locator.database,
      ],
      { stdio: ['pipe', 'ignore', 'ignore'], timeout: 15000 },
    );
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Database role provisioning failed')),
    );
    child.stdin.end(configuration.roleSql);
  });
} catch {
  // Docker/SQL/schema errors can contain private URLs, never print their text.
  process.stderr.write('Managed network protection configuration is unavailable.\n');
  process.exitCode = 1;
}
