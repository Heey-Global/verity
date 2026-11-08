#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { error as reportError } from 'node:console';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { delimiter, resolve } from 'node:path';
import { URL } from 'node:url';
import { configurePackageArtifacts } from './verity-package-artifacts.mjs';
import {
  npmInstallPlan,
  npmLockedPackages,
  npmProjectRoot,
  lockNpmProject,
  preserveNpmDependencies,
} from './verity-npm-preflight.mjs';
import {
  classifyInstall,
  configureReleaseDelay,
  detectReleaseDelay,
  effectiveInstallDirectory,
  supportsReleaseDelay,
} from './verity-package-policy.mjs';

const [manager, ...originalArgs] = process.argv.slice(2);
const verifyOnly = originalArgs.includes('--verity-verify-only');
const args = originalArgs.filter((arg) => arg !== '--verity-verify-only');

function run(executable, childArgs, environment, lockFd) {
  return new Promise((done, reject) => {
    const child = spawn(executable, childArgs, {
      stdio: lockFd === undefined ? 'inherit' : ['inherit', 'inherit', 'inherit', lockFd],
      env: environment,
    });
    const signals = ['SIGINT', 'SIGTERM'];
    let cancelled;
    const handlers = signals.map((signal) => () => {
      cancelled = signal;
      child.kill(signal);
    });
    signals.forEach((signal, index) => process.on(signal, handlers[index]));
    const cleanup = () =>
      signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      done({ code, signal: cancelled ?? signal });
    });
  });
}

function realBinary() {
  const own = realpathSync(process.argv[1]);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, manager);
    try {
      accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (real === own || real.startsWith('/opt/verity/package-managers/')) continue;
      return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`${manager} is not installed`);
}

async function broker(body) {
  const memory = process.env.VERITY_PROJECT_MEMORY_URL ?? '';
  if (!/\/internal\/project\/memory$/u.test(memory))
    throw new Error(
      'Package installation requires the project broker; restore sandbox provisioning.',
    );
  const capability = readFileSync(
    process.env.VERITY_GH_BROKER_CAPABILITY_FILE ?? '/run/verity/gh-token-capability',
    'utf8',
  ).trim();
  if (!capability) throw new Error('The package broker capability is empty.');
  const url = new URL(memory.replace(/\/internal\/project\/memory$/u, '/internal/package-install'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid package broker URL.');
  const payload = JSON.stringify({ ...body, sessionId: process.env.VERITY_SESSION_ID });
  // Human decisions use the relay's permission deadline, rather than fetch's
  // five-minute response-header timeout.
  return new Promise((resolveResponse, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${capability}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
          if (data.length > 65_536)
            request.destroy(new Error('Package broker response is too large.'));
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(data);
            if ((response.statusCode ?? 500) >= 400)
              throw new Error(result.error ?? `Package broker returned ${response.statusCode}`);
            resolveResponse(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

function displayCommand(manager, args) {
  let hideNext = false;
  const safe = args.map((arg) => {
    if (hideNext) {
      hideNext = false;
      return '[redacted]';
    }
    if (/^--[^=]*(?:token|password|credential|auth)[^=]*(?:=|$)/iu.test(arg)) {
      if (arg.includes('=')) return arg.slice(0, arg.indexOf('=') + 1) + '[redacted]';
      hideNext = true;
      return arg;
    }
    return arg.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, '$1[redacted]@');
  });
  return [manager, ...safe].join(' ');
}

async function main() {
  if (verifyOnly && (manager !== 'npm' || !process.env.VERITY_SESSION_ID || args[0] !== 'ci'))
    throw new Error('Read-only verification requires a managed npm ci invocation.');
  const executable = realBinary();
  const environment = { ...process.env };
  // Tokens are issued for one checked command, never inherited by another install.
  delete environment.VERITY_PACKAGE_INSTALL_TOKEN;
  let invocation = args;
  let installInput;
  let npmPlan;
  let npmDirectory;
  let minimumAgeDays = 3;
  // Image builds and interactive shells have no session to raise a card on.
  if (process.env.VERITY_SESSION_ID && classifyInstall(manager, args)) {
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    let supported = version.status === 0 && supportsReleaseDelay(manager, version.stdout.trim());
    const directory = effectiveInstallDirectory(manager, args, process.cwd());
    if (manager === 'npm') {
      for (let i = 0; i < args.length && args[i] !== '--'; i++) {
        const [key, inline] = args[i].split('=', 2);
        if (key === '--userconfig' || key === '--globalconfig') {
          const value = inline ?? args[++i];
          if (!value) throw new Error(`Missing value for ${key}.`);
          const name = key === '--userconfig' ? 'npm_config_userconfig' : 'npm_config_globalconfig';
          environment[name] = resolve(process.cwd(), value);
          environment[name.toUpperCase()] = environment[name];
        }
      }
      npmPlan = npmInstallPlan(args, directory, environment);
      npmDirectory = directory;
      npmPlan.root = npmProjectRoot(executable, directory, environment, args);
    }
    if (manager === 'bun') {
      delete environment.VERITY_BUN_CONFIG_FILE;
      for (let i = 0; i < args.length && args[i] !== '--'; i++) {
        const [flag, inline] = args[i].split('=', 2);
        if (flag === '--config' || flag === '-c') {
          const value = inline ?? args[++i];
          if (!value) throw new Error('Missing Bun configuration path.');
          environment.VERITY_BUN_CONFIG_FILE = resolve(directory, value);
        }
      }
    }
    if (manager === 'uv') {
      delete environment.VERITY_UV_CONFIG_FILE;
      for (let i = 0; i < args.length && args[i] !== '--'; i++) {
        const [flag, inline] = args[i].split('=', 2);
        if (flag === '--config-file') {
          const value = inline ?? args[++i];
          if (!value) throw new Error('Missing uv configuration path.');
          environment.VERITY_UV_CONFIG_FILE = resolve(directory, value);
        }
      }
    }
    if (supported && ['npm', 'pnpm', 'yarn'].includes(manager)) {
      const key = { npm: 'min-release-age', pnpm: 'minimumReleaseAge', yarn: 'npmMinimalAgeGate' }[
        manager
      ];
      const config = spawnSync(executable, ['config', 'get', key], {
        cwd: directory,
        env: environment,
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (config.status !== 0)
        throw new Error('Could not read effective package-manager configuration.');
      environment.VERITY_NATIVE_RELEASE_AGE = config.stdout.trim();
    }
    // Keep pip's default registry and credential configuration in place. Selecting
    // a new PIP_CONFIG_FILE would suppress its existing user configuration.
    if (supported && manager === 'pip' && !environment.PIP_UPLOADED_PRIOR_TO) {
      const config = spawnSync(executable, ['config', 'list'], {
        cwd: directory,
        env: environment,
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (config.status !== 0) throw new Error('Could not read effective pip configuration.');
      const ages = new Map();
      for (const line of config.stdout.split('\n')) {
        const match = line.match(/^(global|install|:env:)\.uploaded-prior-to=(.*)$/u);
        if (match) ages.set(match[1], match[2].replace(/^(['"])(.*)\1$/u, '$2'));
      }
      const nativeAge = ages.get(':env:') ?? ages.get('install') ?? ages.get('global');
      if (nativeAge !== undefined) environment.PIP_UPLOADED_PRIOR_TO = nativeAge;
    }
    let detection = detectReleaseDelay(manager, directory, environment, version.stdout.trim());
    supported = supported && detection.setupSupported !== false;
    const input = {
      manager,
      command: displayCommand(manager, args),
      supported,
      protected: supported && detection.protected,
      configFile: detection.path,
    };
    const decision = verifyOnly
      ? { action: 'continue' }
      : await broker({ action: 'check', ...input });
    if (decision.action === 'cancel') throw new Error('Dependency installation cancelled.');
    if (!['continue', 'configure'].includes(decision.action))
      throw new Error('Invalid package installation decision.');
    if (decision.action === 'configure') {
      detection = configureReleaseDelay(manager, directory, version.stdout.trim(), environment);
      if (!detection.protected)
        throw new Error('Could not verify the 3-day delay; installation remains blocked.');
      const confirmed = await broker({
        action: 'configured',
        ...input,
        protected: true,
        configFile: detection.path,
        setupToken: decision.setupToken,
      });
      if (confirmed.action !== 'continue')
        throw new Error('Package protection could not be confirmed.');
    }
    // Apply the project file's age without hiding pip's other configuration files.
    const configuredValue = detection.value?.replace(/^(['"])(.*)\1$/u, '$2');
    if (supported && manager === 'pip' && detection.protected)
      environment.PIP_UPLOADED_PRIOR_TO = configuredValue;
    if (supported && manager === 'npm' && detection.protected)
      environment.npm_config_min_release_age = configuredValue;
    if (supported && manager === 'yarn' && detection.protected)
      environment.YARN_NPM_MINIMAL_AGE_GATE = configuredValue;
    if (supported && manager === 'pnpm' && detection.protected)
      environment.npm_config_minimum_release_age = configuredValue;
    if (supported && manager === 'uv' && detection.protected)
      environment.UV_EXCLUDE_NEWER = configuredValue;
    if (manager === 'npm') {
      installInput = { ...input, protected: supported && detection.protected };
      // Native defaults and project policy may be stricter than three days.
      minimumAgeDays = Math.max(3, Number(configuredValue) || 0);
      for (let i = 0; i < args.length; i++) {
        const [key, value] = args[i].split('=', 2);
        if (key === '--min-release-age')
          minimumAgeDays = Math.max(minimumAgeDays, Number(value ?? args[++i]) || 0);
      }
      environment.npm_config_min_release_age = String(minimumAgeDays);
    }
  }
  let installToken;
  const installationLock = npmPlan ? await lockNpmProject(npmPlan.root, environment) : undefined;
  delete environment.VERITY_NPM_LOCK_FD;
  try {
    if (npmPlan) {
      if (npmPlan.resolveArgs) {
        reportError(
          'verity: resolving npm lockfile without installing packages or running scripts…',
        );
        const resolutionEnvironment = { ...environment };
        const resolution = configurePackageArtifacts(
          manager,
          npmPlan.resolveArgs,
          resolutionEnvironment,
        );
        let result;
        try {
          result = await run(
            executable,
            resolution.args,
            resolutionEnvironment,
            installationLock?.fd,
          );
        } finally {
          resolution.cleanup();
        }
        if (result.code !== 0 || result.signal) {
          process.exitCode =
            result.signal === 'SIGINT' ? 130 : result.signal ? 143 : (result.code ?? 1);
          return;
        }
      }
      if (npmProjectRoot(executable, npmDirectory, environment, args) !== npmPlan.root)
        throw new Error(
          'npm project root changed during resolution; retry with the current project.',
        );
      const lock = npmLockedPackages(npmPlan.root);
      reportError(
        `verity: checking publication dates for ${lock.packages.length} pinned npm versions (including cached packages)…`,
      );
      const checked = await broker({
        action: 'verify',
        ...installInput,
        packages: lock.packages,
        minimumAgeDays,
      });
      if (checked.action !== 'continue' || typeof checked.installToken !== 'string')
        throw new Error(
          'npm release-age verification was not approved; installation remains blocked.',
        );
      installToken = checked.installToken;
      environment.VERITY_PACKAGE_INSTALL_TOKEN = installToken;
      if (readFileSync(lock.path, 'utf8') !== lock.source)
        throw new Error(
          'npm lockfile changed during verification; retry with the current lockfile.',
        );
      if (verifyOnly || !npmPlan.installArgs) return;
      invocation = npmPlan.installArgs;
      if (!args.some((arg) => arg === '--dry-run' || arg === '--dry-run=true')) {
        const recovery = preserveNpmDependencies(npmPlan.root);
        if (recovery)
          reportError(
            `verity: preserved existing dependency files at ${recovery} before installing the frozen tree.`,
          );
      }
    }
    const artifacts = configurePackageArtifacts(manager, invocation, environment);
    process.once('exit', artifacts.cleanup);
    let result;
    try {
      result = await run(executable, artifacts.args, environment, installationLock?.fd);
    } finally {
      artifacts.cleanup();
      process.removeListener('exit', artifacts.cleanup);
    }
    process.exitCode = result.signal === 'SIGINT' ? 130 : result.signal ? 143 : (result.code ?? 1);
  } finally {
    try {
      if (installToken) {
        const completed = await broker({ action: 'complete', ...installInput, installToken });
        if (completed.action !== 'complete') {
          reportError('Could not close the npm installation grant.');
          process.exitCode ||= 1;
        }
      }
    } catch (error) {
      reportError(`Could not close the npm installation grant: ${error.message}`);
      process.exitCode ||= 1;
    } finally {
      installationLock?.release();
    }
  }
}

main().catch((error) => {
  reportError(`verity: ${error.message}`);
  process.exitCode = 1;
});
