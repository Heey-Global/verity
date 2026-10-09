import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  handler: (body: Record<string, unknown>, reply: ServerResponse) => void,
  manager = 'npm',
  version = '11.19.0',
  nativeConfig = '',
) {
  const root = mkdtempSync(join(tmpdir(), 'verity-package-install-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const marker = join(root, 'executed.json');
  writeFileSync(
    join(bin, manager),
    `#!${process.execPath}\nconst fs = require('node:fs');\nif(process.argv[2] === '--version') console.log(${JSON.stringify(version)});\nelse if(process.argv[2] === 'config') console.log(${JSON.stringify(nativeConfig)});\nelse fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),pipConfig:process.env.PIP_CONFIG_FILE,pipAge:process.env.PIP_UPLOADED_PRIOR_TO,npmAge:process.env.npm_config_min_release_age}));\n`,
    { mode: 0o755 },
  );
  const capability = join(root, 'capability');
  writeFileSync(capability, 'test-capability');
  const calls: Record<string, unknown>[] = [];
  const server = createServer((request: IncomingMessage, reply) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      expect(request.url).toBe('/internal/package-install');
      expect(request.headers.authorization).toBe('Bearer test-capability');
      const parsed = JSON.parse(body) as Record<string, unknown>;
      calls.push(parsed);
      handler(parsed, reply);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const start = (args: string[], session = 'session-1') => {
    const child: ChildProcess = spawn(
      process.execPath,
      [resolve('features/verity-sandbox-toolkit/bin/verity-package-install.mjs'), manager, ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SESSION_ID: session,
          VERITY_PROJECT_MEMORY_URL: `http://127.0.0.1:${address.port}/internal/project/memory`,
          VERITY_GH_BROKER_CAPABILITY_FILE: capability,
          PIP_CONFIG_FILE: '',
          PIP_UPLOADED_PRIOR_TO: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    cleanups.push(() => {
      child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<{ code: number | null; stderr: string }>((done, reject) => {
      child.on('error', reject);
      child.on('close', (code) => done({ code, stderr }));
    });
    return { child, exited };
  };
  return { root, marker, calls, start };
}

const answer = (reply: ServerResponse, action: string) => {
  reply.setHeader('content-type', 'application/json');
  reply.end(JSON.stringify({ action }));
};

describe('package install wrapper', () => {
  it('preserves a native user npm floor without creating a weaker project setting', async () => {
    const f = await fixture(
      (body, reply) => {
        expect(body.protected).toBe(true);
        answer(reply, 'continue');
      },
      'npm',
      '11.19.0',
      '7',
    );
    expect((await f.start(['install', 'express']).exited).code).toBe(0);
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({ npmAge: '7' });
    expect(existsSync(join(f.root, '.npmrc'))).toBe(false);
  });
  it('allows explicit continuation for multiline Python configuration without modifying it', async () => {
    const f = await fixture(
      (body, reply) => {
        expect(body.supported).toBe(false);
        answer(reply, 'continue');
      },
      'uv',
      '0.9.17',
    );
    const path = join(f.root, 'pyproject.toml');
    const text = '[project]\ndescription = """hello\nworld"""\n';
    writeFileSync(path, text);
    expect((await f.start(['sync']).exited).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
  it.each([['--config', 'custom.toml'], ['--config=custom.toml']])(
    'uses Bun explicit configuration %s',
    async (...options) => {
      const f = await fixture(
        (body, reply) => {
          expect(body.configFile).toBe(join(f.root, 'custom.toml'));
          answer(reply, body.action === 'check' ? 'configure' : 'continue');
        },
        'bun',
        '1.3.0',
      );
      const custom = join(f.root, 'custom.toml');
      const standard = join(f.root, 'bunfig.toml');
      writeFileSync(custom, '[install]\nminimumReleaseAge = 0\n');
      const original = '[install]\nminimumReleaseAge = 604800\n';
      writeFileSync(standard, original);
      const args = [...options, 'install', 'example'];
      expect((await f.start(args).exited).code).toBe(0);
      expect(readFileSync(custom, 'utf8')).toContain('259200');
      expect(readFileSync(standard, 'utf8')).toBe(original);
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).args).toEqual(args);
    },
  );

  it.each(['https', 'socks5', 'socks5h', 'socks4', 'http'])(
    'redacts %s URL credentials while preserving execution arguments',
    async (scheme) => {
      const args = [
        'install',
        '--index-url',
        `${scheme}://user:private-token@registry.example/simple`,
        'example',
      ];
      const f = await fixture(
        (body, reply) => {
          expect(body.command).toContain(`${scheme}://[redacted]@registry.example/simple`);
          expect(JSON.stringify(body)).not.toContain('private-token');
          answer(reply, 'continue');
        },
        'pip',
        '26.2.1',
      );
      expect((await f.start(args).exited).code).toBe(0);
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).args).toEqual(args);
    },
  );
  it('passes an existing quoted npm floor as a numeric environment value', async () => {
    const f = await fixture((body, reply) => {
      expect(body.protected).toBe(true);
      answer(reply, 'continue');
    });
    writeFileSync(join(f.root, '.npmrc'), 'min-release-age="3"\n');
    expect((await f.start(['install', 'express']).exited).code).toBe(0);
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({ npmAge: '3' });
  });
  it('detects and retains a stricter native pip age without replacing its config files', async () => {
    const f = await fixture(
      (body, reply) => {
        expect(body.protected).toBe(true);
        answer(reply, 'continue');
      },
      'pip',
      '26.2.1',
      "global.uploaded-prior-to='P5D'",
    );
    expect((await f.start(['install', 'pandas']).exited).code).toBe(0);
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({
      pipAge: 'P5D',
      pipConfig: '',
    });
    expect(existsSync(join(f.root, 'pip.conf'))).toBe(false);
  });
  it('installs executable shims that preserve arguments from the toolkit installer', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-package-shims-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const source = readFileSync('features/verity-sandbox-toolkit/install.sh', 'utf8');
    const section = source.match(/install -d \/opt\/verity\/package-managers[\s\S]*?\ndone/u)?.[0];
    expect(
      section,
      'toolkit no longer installs the package-manager interception shims',
    ).toBeDefined();
    const managers = section?.match(/for PACKAGE_MANAGER in ([^;]+);/u)?.[1].split(' ');
    expect(managers).toEqual(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv']);
    const shimDirectory = join(root, 'shims');
    const libraryDirectory = join(root, 'lib');
    const script =
      section
        ?.replaceAll('/opt/verity/package-managers', shimDirectory)
        .replaceAll('/usr/local/lib/verity', libraryDirectory) ?? '';
    const installed = spawnSync('bash', ['-euc', script], {
      env: { ...process.env, FEATURE_DIR: resolve('features/verity-sandbox-toolkit') },
      encoding: 'utf8',
    });
    expect(installed.status, installed.stderr).toBe(0);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const manager of managers ?? []) {
      writeFileSync(
        join(bin, manager),
        `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o755 },
      );
      const args = ['run', 'literal $HOME; "quoted"'];
      const child = spawnSync(join(shimDirectory, manager), args, {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, VERITY_SESSION_ID: '' },
        encoding: 'utf8',
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(args);
    }
  });

  it('does not execute the real binary until the decision and verified configuration are confirmed', async () => {
    let waiting!: ServerResponse;
    let arrive!: () => void;
    const arrived = new Promise<void>((done) => {
      arrive = done;
    });
    const f = await fixture((body, reply) => {
      if (body.action === 'check') {
        waiting = reply;
        arrive();
      } else {
        expect(readFileSync(join(f.root, '.npmrc'), 'utf8')).toContain('min-release-age');
        expect(existsSync(f.marker)).toBe(false);
        expect(body.protected).toBe(true);
        answer(reply, 'continue');
      }
    });
    writeFileSync(join(f.root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    const run = f.start(['install', 'express']);
    await arrived;
    expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(join(f.root, '.npmrc'))).toBe(true);
    answer(waiting, 'configure');
    expect(await run.exited).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({
      args: ['install', 'express'],
    });
    expect(readFileSync(join(f.root, '.npmrc'), 'utf8')).toContain(
      'registry=https://registry.npmjs.org/',
    );
    expect(f.calls.map((call) => call.action)).toEqual(['check', 'configured']);
  });

  it.each(['cancel', 'unknown'])('keeps the real install blocked after %s', async (action) => {
    const f = await fixture((_body, reply) => answer(reply, action));
    expect((await f.start(['install', 'express']).exited).code).not.toBe(0);
    expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(join(f.root, '.npmrc'))).toBe(false);
  });

  it('passes through without a broker for non-install commands and non-session use', async () => {
    const f = await fixture((_body, reply) => answer(reply, 'cancel'));
    expect((await f.start(['run', 'build']).exited).code).toBe(0);
    expect((await f.start(['install', 'express'], '').exited).code).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it('applies the configured pip age while preserving native configuration discovery', async () => {
    const f = await fixture(
      (body, reply) => answer(reply, body.action === 'check' ? 'configure' : 'continue'),
      'pip',
      'pip 26.2.1 from /test (python 3.14)',
    );
    const result = await f.start(['install', 'pandas']).exited;
    expect(result).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({
      pipAge: 'P3D',
    });
    expect(readFileSync(join(f.root, 'pip.conf'), 'utf8')).toContain('P3D');
  });

  it('does not claim an existing option is protection on an old manager', async () => {
    const f = await fixture(
      (body, reply) => {
        expect(body.supported).toBe(false);
        expect(body.protected).toBe(false);
        answer(reply, 'continue');
      },
      'npm',
      '10.0.0',
    );
    writeFileSync(join(f.root, '.npmrc'), 'min-release-age=3\n');
    expect((await f.start(['install']).exited).code).toBe(0);
  });
});
