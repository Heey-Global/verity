#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
  constants,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';

// A version alone does not establish an intact installation. Include the lock,
// installer (including hardening), runtime ABI and complete installed tree.
function treeDigest(root) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const visit = (relative) => {
    const file = path.join(root, relative);
    const stat = lstatSync(file);
    hash.update(
      JSON.stringify([relative, stat.mode, stat.uid, stat.gid, stat.isFile() ? stat.size : null]),
    );
    if (stat.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(file)));
    else if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        let length;
        while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          hash.update(buffer.subarray(0, length));
        }
      } finally {
        closeSync(fd);
      }
    } else throw new Error('Unsupported CLI installation entry');
  };
  visit('');
  return hash.digest('hex');
}

/** The ACP adapter must not reopen project policy when starting a thread. */
export function hardenCodexAcpSource(source) {
  const automaticTrust =
    /projects: Object\.fromEntries\(sessionRoots\.map\(\(root\) => \[root, \{\s*trust_level: "trusted"\s*\}\]\)\)/g;
  const matches = [...source.matchAll(automaticTrust)];
  if (matches.length !== 1)
    throw new Error('Unsupported Codex ACP project-trust code; refusing an unhardened adapter');
  return source.replace(automaticTrust, (match) => match.replace('"trusted"', '"untrusted"'));
}

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
  if (id === 'codex-acp' && version !== '2.3.0')
    throw new Error('Codex ACP security hardening requires audited adapter version 2.3.0');
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error('CLI version must be exact');
  }
  const npm = (args, cwd) => execFileSync('npm', args, { cwd, stdio: 'inherit' });
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
  const destination = path.join(globalRoot, '.verity-cli', id);
  const receipt = path.join(destination, 'verity-install.json');
  const identity = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(readFileSync(path.join(source, 'package.json')))
    .update(readFileSync(path.join(source, 'package-lock.json')))
    .update(JSON.stringify([process.version, process.platform, process.arch, prefix]))
    .digest('hex');
  // Claude's adapter receives further patches outside this installer. Always
  // rebuild that tree so changed external patches cannot be skipped by a receipt.
  const reusable = version === pinned && id !== 'claude-acp';
  if (reusable) {
    try {
      const saved = JSON.parse(readFileSync(receipt, 'utf8'));
      const packageDir = path.join(destination, 'node_modules', name);
      const installed = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      const bins =
        typeof installed.bin === 'string'
          ? { [name.split('/').at(-1)]: installed.bin }
          : (installed.bin ?? {});
      const linked = (link, target) =>
        lstatSync(link).isSymbolicLink() &&
        path.resolve(path.dirname(link), readlinkSync(link)) === target;
      if (
        saved.version === 1 &&
        saved.identity === identity &&
        installed.name === name &&
        installed.version === version &&
        saved.tree === treeDigest(path.join(destination, 'node_modules')) &&
        linked(path.join(globalRoot, name), packageDir) &&
        Object.entries(bins).every(([bin, relative]) => {
          const target = path.resolve(packageDir, relative);
          return (
            path.basename(bin) === bin &&
            target.startsWith(`${packageDir}${path.sep}`) &&
            linked(path.join(prefix, 'bin', bin), target) &&
            (lstatSync(target).mode & 0o111) !== 0
          );
        })
      ) {
        console.log(`Reusing verified CLI ${name}@${version}`);
        return;
      }
    } catch {
      /* An incomplete or modified tree is installed afresh below. */
    }
  }
  mkdirSync(destination, { recursive: true });
  rmSync(receipt, { force: true });
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
  // V2 changes package names but still owns the same `opencode` command.
  if (id === 'opencode')
    rmSync(path.join(globalRoot, 'opencode-ai'), { recursive: true, force: true });
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
  if (id === 'codex-acp') {
    const entry = path.join(packageDir, 'dist', 'index.js');
    writeFileSync(entry, hardenCodexAcpSource(readFileSync(entry, 'utf8')));
  }
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
  if (reusable)
    writeFileSync(
      receipt,
      JSON.stringify({
        version: 1,
        identity,
        tree: treeDigest(path.join(destination, 'node_modules')),
      }),
      { mode: 0o600 },
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installCli(process.argv[2], process.argv[3]);
}
