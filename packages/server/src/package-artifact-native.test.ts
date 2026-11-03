/** Native-client HTTP fixture proof only. This does not exercise Docker, relay or
 * kernel enforcement, and its provider transport serves only synthetic archives. */
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { markInternalConnections } from './internal-listener.js';
import { registerPackageArtifactRoutes } from './package-artifact-routes.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const capability = 'synthetic-native-package-capability';
const packageName = 'verity-artifact-fixture';
const binding = {
  projectId: 'fixture-project',
  containerGeneration: 'fixture-generation',
  owner: 'o',
  repo: 'r',
};
function npmCli(): string | undefined {
  const candidates = [
    process.env.npm_execpath?.replace(/npx-cli\.js$/u, 'npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  return candidates.find((path) => path?.endsWith('/npm-cli.js') && existsSync(path));
}
const npm = npmCli();
const pipAvailable =
  spawnSync('python3', ['-m', 'pip', '--version'], { encoding: 'utf8', timeout: 5000 }).status ===
  0;
function incoming(body: unknown): IncomingMessage {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return Object.assign(Readable.from([buffer]), {
    statusCode: 200,
    headers: { 'content-length': String(buffer.length) },
  }) as IncomingMessage;
}
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'verity-artifact-native-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function listener(transport: BrokeredHttpStreamTransport, port = 0) {
  const app = Fastify();
  const generation = new AbortController();
  markInternalConnections(app.server, binding, generation.signal);
  let origin = '';
  registerPackageArtifactRoutes(app, {
    capabilities: {
      resolve: async (token: string) => (token === capability ? binding : undefined),
    } as unknown as GhTokenCapabilityRegistry,
    transport,
    artifactBaseUrl: () => origin,
  });
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => app.close());
  return { app, origin, port: address.port, generation };
}

it.skipIf(!npm)(
  'native npm install/audit and frozen npm ci reuse selectors after broker reconstruction',
  async () => {
    const directory = await root();
    const source = join(directory, 'archive', 'package');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.0.0', main: 'index.js' }),
    );
    await writeFile(join(source, 'index.js'), 'module.exports = 42;\n');
    const archivePath = join(directory, 'fixture.tgz');
    await exec('tar', ['-czf', archivePath, '-C', dirname(source), 'package']);
    const archive = await readFile(archivePath);
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    const upstreamPaths: string[] = [];
    let publishedAt = '2020-01-01T00:00:00Z';
    const transport: BrokeredHttpStreamTransport = async (input) => {
      upstreamPaths.push(`${input.method} ${input.hostname}${input.path}`);
      expect(input.headers.authorization).toBeUndefined();
      if (input.method === 'POST' && input.path === '/-/npm/v1/security/advisories/bulk')
        return incoming({});
      if (input.method !== 'GET' || input.hostname !== 'registry.npmjs.org')
        throw new Error('Unexpected synthetic provider operation');
      if (input.path === `/${packageName}`)
        return incoming({
          name: packageName,
          versions: {
            '1.0.0': {
              name: packageName,
              version: '1.0.0',
              dist: {
                integrity,
                tarball: `https://registry.npmjs.org/${packageName}/-/${packageName}-1.0.0.tgz`,
              },
            },
          },
          'dist-tags': { latest: '1.0.0' },
          time: {
            created: '2020-01-01T00:00:00Z',
            modified: '2020-01-01T00:00:00Z',
            '1.0.0': publishedAt,
          },
        });
      if (input.path === `/${packageName}/-/${packageName}-1.0.0.tgz`) return incoming(archive);
      throw new Error(`Unexpected synthetic provider path: ${input.path}`);
    };
    const first = await listener(transport);
    const project = join(directory, 'project');
    await mkdir(project);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ name: 'fixture-consumer', version: '1.0.0', private: true }),
    );
    const config = join(directory, 'npmrc');
    await writeFile(
      config,
      `registry=${first.origin}/internal/package-artifacts/npm/\n//127.0.0.1:${first.port}/internal/package-artifacts/:_authToken=${capability}\nmin-release-age=3\nmaxsockets=1\n`,
    );
    const globalConfig = join(directory, 'global-npmrc');
    await writeFile(globalConfig, '');
    const environment = {
      ...process.env,
      npm_config_userconfig: config,
      npm_config_globalconfig: globalConfig,
      npm_config_cache: join(directory, 'initial-cache'),
      npm_config_audit: 'true',
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '5000',
      npm_config_ignore_scripts: 'false',
      npm_config_registry: `${first.origin}/internal/package-artifacts/npm/`,
      npm_config_offline: 'false',
    };
    const run = async (args: string[], env = environment) =>
      exec(process.execPath, [npm!, ...args], {
        cwd: project,
        env,
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      });
    await run(['install', `${packageName}@1.0.0`]);
    expect(await readFile(join(project, 'node_modules', packageName, 'index.js'), 'utf8')).toBe(
      'module.exports = 42;\n',
    );
    const lockfile = await readFile(join(project, 'package-lock.json'), 'utf8');
    expect(lockfile).toContain('/internal/package-artifacts/file/npm/');
    expect(
      upstreamPaths.some((path) =>
        path.startsWith('POST registry.npmjs.org/-/npm/v1/security/advisories/bulk'),
      ),
    ).toBe(true);
    first.generation.abort();
    await first.app.close();
    await listener(transport, first.port);
    await rm(join(project, 'node_modules'), { recursive: true });
    const before = upstreamPaths.length;
    await run(['ci'], { ...environment, npm_config_cache: join(directory, 'fresh-cache') });
    expect(await readFile(join(project, 'package-lock.json'), 'utf8')).toBe(lockfile);
    expect(await readFile(join(project, 'node_modules', packageName, 'index.js'), 'utf8')).toBe(
      'module.exports = 42;\n',
    );
    expect(upstreamPaths.slice(before)).toContain(`GET registry.npmjs.org/${packageName}`);
    expect(upstreamPaths.slice(before)).toContain(
      `GET registry.npmjs.org/${packageName}/-/${packageName}-1.0.0.tgz`,
    );
    // The proxy retains release times; npm's three-day check still rejects fresh releases.
    publishedAt = new Date().toISOString();
    const young = join(directory, 'young-consumer');
    await mkdir(young);
    await writeFile(
      join(young, 'package.json'),
      JSON.stringify({ name: 'young-consumer', version: '1.0.0', private: true }),
    );
    const priorDownloads = upstreamPaths.filter((path) => path.endsWith('.tgz')).length;
    await expect(
      run(['install', '--prefix', young, `${packageName}@1.0.0`], {
        ...environment,
        npm_config_cache: join(directory, 'age-check-cache'),
      }),
    ).rejects.toThrow(/ETARGET|No matching version/);
    expect(upstreamPaths.filter((path) => path.endsWith('.tgz'))).toHaveLength(priorDownloads);
  },
  45000,
);

it.skipIf(!pipAvailable)(
  'native pip downloads a synthetic wheel through PyPI JSON and reuses its selector after restart',
  async () => {
    const directory = await root();
    const filename = 'verity_artifact_fixture-1.0.0-py3-none-any.whl';
    const wheelPath = join(directory, filename);
    await exec('python3', [
      '-c',
      `import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n z.writestr('verity_artifact_fixture/__init__.py', 'VALUE = 42\\n')\n z.writestr('verity_artifact_fixture-1.0.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: verity-artifact-fixture\\nVersion: 1.0.0\\n')\n z.writestr('verity_artifact_fixture-1.0.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: synthetic-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n z.writestr('verity_artifact_fixture-1.0.0.dist-info/RECORD', '')`,
      wheelPath,
    ]);
    const archive = await readFile(wheelPath);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const paths: string[] = [];
    const transport: BrokeredHttpStreamTransport = async (input) => {
      paths.push(`${input.hostname}${input.path}`);
      expect(input.headers.authorization).toBeUndefined();
      if (input.hostname === 'pypi.org' && input.path === `/simple/${packageName}/`)
        return incoming({
          meta: { 'api-version': '1.1' },
          name: packageName,
          files: [
            {
              filename,
              url: `https://files.pythonhosted.org/packages/aa/${filename}`,
              hashes: { sha256 },
              size: archive.length,
              'upload-time': '2020-01-01T00:00:00Z',
              'requires-python': '>=3.9',
            },
          ],
        });
      if (input.hostname === 'files.pythonhosted.org' && input.path === `/packages/aa/${filename}`)
        return incoming(archive);
      throw new Error('Unexpected synthetic PyPI provider operation');
    };
    const first = await listener(transport);
    const index = `${first.origin.replace('http://', `http://verity:${capability}@`)}/internal/package-artifacts/pypi/simple/`;
    const baseArgs = [
      '-m',
      'pip',
      'download',
      '--no-deps',
      '--no-cache-dir',
      '--disable-pip-version-check',
      '--index-url',
      index,
    ];
    const run = (args: string[]) =>
      exec('python3', args, {
        cwd: directory,
        env: {
          ...process.env,
          PIP_UPLOADED_PRIOR_TO: '2020-01-02T00:00:00Z',
          PIP_CONFIG_FILE: '/dev/null',
          PIP_EXTRA_INDEX_URL: '',
          PIP_FIND_LINKS: '',
        },
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
    await run([...baseArgs, '--dest', join(directory, 'initial'), `${packageName}==1.0.0`]);
    expect(await readFile(join(directory, 'initial', filename))).toEqual(archive);
    const metadata = await first.app.inject({
      method: 'GET',
      url: `/internal/package-artifacts/pypi/simple/${packageName}/`,
      headers: { authorization: `Bearer ${capability}` },
    });
    // inject is not a tagged network socket; fetch the same authenticated native URL instead.
    expect(metadata.statusCode).toBe(401);
    const response = await fetch(
      `${first.origin}/internal/package-artifacts/pypi/simple/${packageName}/`,
      { headers: { authorization: `Bearer ${capability}` } },
    );
    const body = (await response.json()) as { files: { url: string }[] };
    const selected = body.files[0]!.url;
    first.generation.abort();
    await first.app.close();
    await listener(transport, first.port);
    const before = paths.length;
    await run([...baseArgs, '--dest', join(directory, 'reused'), selected]);
    expect(await readFile(join(directory, 'reused', filename))).toEqual(archive);
    expect(paths.slice(before)).toContain(`pypi.org/simple/${packageName}/`);
    expect(paths.slice(before)).toContain(`files.pythonhosted.org/packages/aa/${filename}`);
  },
  40000,
);
