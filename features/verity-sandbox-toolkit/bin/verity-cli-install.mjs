#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';

// Keep each CLI's dependency tree isolated, while exposing the same global
// package and executable paths used by the adapter patches and spawn broker.
export function installCli(
  id,
  override,
  bundleRoot = fileURLToPath(new URL('../npm/', import.meta.url)),
) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid CLI bundle name');
  const source = path.join(bundleRoot, id);
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  const dependencies = Object.entries(manifest.dependencies);
  if (dependencies.length !== 1) throw new Error('CLI bundle must contain exactly one dependency');
  const [name, pinned] = dependencies[0];
  const version = override ?? pinned;
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error('CLI version must be exact');
  }
  const npm = (args, cwd) => execFileSync('npm', args, { cwd, stdio: 'inherit' });
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
  const destination = path.join(globalRoot, '.verity-cli', id);
  mkdirSync(destination, { recursive: true });
  // Remove links into this tree before npm replaces it during a repeat install.
  const binDirectory = path.join(prefix, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  for (const bin of readdirSync(binDirectory)) {
    const link = path.join(binDirectory, bin);
    if (
      lstatSync(link).isSymbolicLink() &&
      path.resolve(binDirectory, readlinkSync(link)).startsWith(`${destination}${path.sep}`)
    ) {
      rmSync(link);
    }
  }
  const previousGlobal = path.join(globalRoot, name);
  rmSync(previousGlobal, { recursive: true, force: true });
  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(path.join(source, file), path.join(destination, file));
  }
  if (version !== pinned) {
    console.error(
      `CLI override ${name}@${version}: resolving a new lockfile; the committed lock applies to ${pinned}`,
    );
    npm(
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--workspaces=false',
        `${name}@${version}`,
        '--save-exact',
      ],
      destination,
    );
  }
  npm(
    ['ci', '--ignore-scripts=false', '--omit=dev', '--no-audit', '--no-fund', '--workspaces=false'],
    destination,
  );
  const packageDir = path.join(destination, 'node_modules', name);
  const installed = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (installed.name !== name || installed.version !== version)
    throw new Error('Installed CLI does not match requested version');
  const globalPackage = path.join(globalRoot, name);
  mkdirSync(path.dirname(globalPackage), { recursive: true });
  rmSync(globalPackage, { recursive: true, force: true });
  symlinkSync(packageDir, globalPackage);
  const bins =
    typeof installed.bin === 'string'
      ? { [name.split('/').at(-1)]: installed.bin }
      : (installed.bin ?? {});
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  for (const [bin, relative] of Object.entries(bins)) {
    const target = path.resolve(packageDir, relative);
    if (path.basename(bin) !== bin || !target.startsWith(`${packageDir}${path.sep}`)) {
      throw new Error('Invalid CLI executable path');
    }
    chmodSync(target, 0o755);
    const link = path.join(prefix, 'bin', bin);
    rmSync(link, { force: true });
    symlinkSync(target, link);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installCli(process.argv[2], process.argv[3]);
}
