#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { error as reportError } from 'node:console';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { delimiter, resolve } from 'node:path';
import { URL } from 'node:url';
import {
  classifyInstall,
  configureReleaseDelay,
  detectReleaseDelay,
  effectiveInstallDirectory,
  supportsReleaseDelay,
} from './verity-package-policy.mjs';

const [manager, ...args] = process.argv.slice(2);

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
  const executable = realBinary();
  const environment = { ...process.env };
  // Image builds and interactive shells have no session to raise a card on.
  if (process.env.VERITY_SESSION_ID && classifyInstall(manager, args)) {
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    let supported = version.status === 0 && supportsReleaseDelay(manager, version.stdout.trim());
    const directory = effectiveInstallDirectory(manager, args, process.cwd());
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
    const decision = await broker({ action: 'check', ...input });
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
  }
  const child = spawn(executable, args, { stdio: 'inherit', env: environment });
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map((signal) => () => child.kill(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  child.on('error', (error) => {
    reportError(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    signals.forEach((entry, index) => process.removeListener(entry, handlers[index]));
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  reportError(`verity: ${error.message}`);
  process.exitCode = 1;
});
