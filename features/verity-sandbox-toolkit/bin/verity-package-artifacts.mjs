import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

/** Select only the provisioned broker. This config grants no script network access. */
export function configurePackageArtifacts(manager, args, environment) {
  const base = environment.VERITY_PACKAGE_ARTIFACT_URL;
  if (!base) return { args, cleanup() {} };
  const url = new URL(base);
  const memory = new URL(environment.VERITY_PROJECT_MEMORY_URL ?? '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.origin !== memory.origin && url.origin !== 'http://verity-package-broker:8080') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/internal/package-artifacts'
  )
    throw new Error('Invalid provisioned package artifact broker.');
  if (!['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv'].includes(manager))
    throw new Error('This package manager has no protected artifact adapter yet.');
  const capability = readFileSync(
    environment.VERITY_GH_BROKER_CAPABILITY_FILE ?? '/run/verity/gh-token-capability',
    'utf8',
  ).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(capability)) throw new Error('Invalid package artifact capability.');
  if (manager === 'pip' || manager === 'uv') {
    const index = new URL(`${base}/pypi/simple/`);
    index.username = 'verity';
    index.password = capability;
    if (manager === 'pip') environment.PIP_INDEX_URL = index.href;
    else {
      environment.UV_INDEX_URL = index.href;
      environment.UV_DEFAULT_INDEX = index.href;
      environment.UV_CONCURRENT_DOWNLOADS = '1';
    }
    // No extra source inherits an exception through the broker.
    environment.PIP_EXTRA_INDEX_URL = '';
    environment.UV_EXTRA_INDEX_URL = '';
    if (url.protocol === 'http:') {
      if (manager === 'pip') environment.PIP_TRUSTED_HOST = url.hostname;
      else environment.UV_INSECURE_HOST = url.host;
    }
    return { args, cleanup() {} };
  }
  const registry = `${base}/npm/`;
  // A private temporary user config preserves existing npm options without
  // changing repository files or leaving the capability in a durable config.
  const directory = mkdtempSync(join(tmpdir(), 'verity-package-artifacts-'));
  try {
    const original =
      environment.npm_config_userconfig ??
      environment.NPM_CONFIG_USERCONFIG ??
      (environment.HOME ? join(environment.HOME, '.npmrc') : undefined);
    let config = '';
    if (original) {
      try {
        config = readFileSync(original, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const path = join(directory, 'npmrc');
    writeFileSync(
      path,
      `${config}\nregistry=${registry}\n//${url.host}${url.pathname}/:_authToken=${capability}\n`,
      { mode: 0o600 },
    );
    environment.NPM_CONFIG_USERCONFIG = path;
    environment.npm_config_userconfig = path;
    environment.npm_config_registry = registry;
    environment.npm_config_maxsockets = '1';
    environment.npm_config_network_concurrency = '1';
    if (manager === 'yarn') {
      environment.YARN_NPM_REGISTRY_SERVER = registry;
      environment.YARN_NPM_AUTH_TOKEN = capability;
      environment.YARN_NPM_ALWAYS_AUTH = 'true';
      environment.YARN_NETWORK_CONCURRENCY = '1';
      if (url.protocol === 'http:') environment.YARN_UNSAFE_HTTP_WHITELIST = url.hostname;
    }
    // npm-compatible CLI registries win over project config; custom sources that
    // still escape this adapter remain blocked by the external project fence.
    return {
      args:
        manager === 'yarn'
          ? args
          : (() => {
              const separator = args.indexOf('--');
              const at = separator < 0 ? args.length : separator;
              return [...args.slice(0, at), `--registry=${registry}`, ...args.slice(at)];
            })(),
      cleanup() {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
