import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  realpathSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const installer = path.resolve('features/verity-sandbox-toolkit/bin/verity-cli-install.mjs');
const npm = realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
const root = mkdtempSync(path.join(tmpdir(), 'verity-cli-install-'));
const source = path.join(root, 'bundles', 'fixture');
let tarballs: Record<string, string>;

beforeAll(() => {
  tarballs = {};
  mkdirSync(source, { recursive: true });
  for (const version of ['1.0.0', '2.0.0']) {
    const directory = path.join(root, `package-${version}`);
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: 'verity-test-cli',
        version,
        bin: { 'verity-test-cli': 'cli.js' },
        scripts: { postinstall: "node -e \"require('fs').writeFileSync('installed', 'yes')\"" },
      }),
    );
    writeFileSync(
      path.join(directory, 'cli.js'),
      `#!/usr/bin/env node\nconsole.log('${version}');\n`,
    );
    const packed = spawnSync(
      process.execPath,
      [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root],
      { cwd: directory, encoding: 'utf8' },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const artifacts = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    tarballs[version] = path.join(root, artifacts[0]!.filename);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(version = '1.0.0') {
  const prefix = mkdtempSync(path.join(root, 'prefix-'));
  const tarball = path.join(prefix, 'package.tgz');
  copyFileSync(tarballs[version]!, tarball);
  const manifest = {
    name: 'verity-cli-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { 'verity-test-cli': version },
  };
  writeFileSync(path.join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(
    path.join(source, 'package-lock.json'),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: {
        '': manifest,
        'node_modules/verity-test-cli': {
          version,
          resolved: `file:${tarball}`,
          integrity: `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`,
          hasInstallScript: true,
          bin: { 'verity-test-cli': 'cli.js' },
        },
      },
    }),
  );
  const shim = path.join(prefix, 'shim');
  mkdirSync(shim);
  writeFileSync(
    path.join(shim, 'npm'),
    `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(prefix, 'calls'))}, JSON.stringify(args)+'\\n');
if(args[0]==='root') {console.log(${JSON.stringify(path.join(prefix, 'lib/node_modules'))});process.exit(0)}
if(args[0]==='prefix') {console.log(${JSON.stringify(prefix)});process.exit(0)}
if(args[0]==='install') args[args.indexOf('verity-test-cli@2.0.0')]=${JSON.stringify(tarballs['2.0.0'])};
const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(npm)},...args],{stdio:'inherit'});
if(result.status===0 && args[0]==='install') {
 for(const file of ['package.json','package-lock.json']) {
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  (data.packages ? data.packages[''] : data).dependencies['verity-test-cli']='2.0.0';
  fs.writeFileSync(file,JSON.stringify(data));
 }
}
process.exit(result.status ?? 1);
`,
  );
  chmodSync(path.join(shim, 'npm'), 0o755);
  return {
    prefix,
    tarball,
    run(override?: string) {
      return spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {installCli} from ${JSON.stringify(`file://${installer}`)}; installCli('fixture', ${JSON.stringify(override) ?? 'undefined'}, ${JSON.stringify(path.dirname(source))});`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${shim}:${process.env.PATH}`,
            npm_config_cache: path.join(prefix, 'cache'),
            npm_config_ignore_scripts: 'true',
          },
        },
      );
    },
  };
}

describe('locked CLI installation', () => {
  it('installs executable and global package links with required lifecycle scripts', () => {
    const item = fixture();
    const result = item.run();
    expect(result.status, result.stderr).toBe(0);
    const command = path.join(item.prefix, 'bin/verity-test-cli');
    expect(spawnSync(command, [], { encoding: 'utf8' }).stdout.trim()).toBe('1.0.0');
    const globalPackage = path.join(item.prefix, 'lib/node_modules/verity-test-cli');
    expect(realpathSync(globalPackage)).toContain('/.verity-cli/fixture/node_modules/');
    expect(readFileSync(path.join(globalPackage, 'installed'), 'utf8')).toBe('yes');
    const calls = readFileSync(path.join(item.prefix, 'calls'), 'utf8');
    expect(calls).toContain('"ci"');
    expect(calls).not.toContain('"install"');
    const repeat = item.run();
    expect(repeat.status, repeat.stderr).toBe(0);
  });

  it('rejects modified tarballs before exposing a CLI', () => {
    const item = fixture();
    copyFileSync(tarballs['2.0.0']!, item.tarball);
    const result = item.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EINTEGRITY');
    expect(existsSync(path.join(item.prefix, 'bin/verity-test-cli'))).toBe(false);
  });

  it('resolves an explicit exact override before installing from its new lock', () => {
    const item = fixture();
    const result = item.run('2.0.0');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('resolving a new lockfile');
    expect(
      spawnSync(path.join(item.prefix, 'bin/verity-test-cli'), [], {
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('2.0.0');
    const calls = readFileSync(path.join(item.prefix, 'calls'), 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as string[]);
    expect(
      calls.filter((args) => ['install', 'ci'].includes(args[0]!)).map((args) => args[0]),
    ).toEqual(['install', 'ci']);
  });

  it('fails closed on a missing lock or a non-exact override', () => {
    const item = fixture();
    rmSync(path.join(source, 'package-lock.json'));
    expect(item.run().status).not.toBe(0);
    expect(item.run('latest').stderr).toContain('CLI version must be exact');
  });
});
