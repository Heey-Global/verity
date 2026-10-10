import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Minimum versions refer to relative durations, so protection does not expire.
// Sources: npm/cli v11.10.0 changelog; pnpm settings/dependency-resolution;
// Yarn 4.10.0 release; Bun 1.3 release; pip 26.1 news; uv 0.9.17 changelog.
export const RELEASE_DELAY_POLICIES = {
  npm: {
    minimumVersion: '11.10.0',
    file: '.npmrc',
    key: 'min-release-age',
    value: '3',
    unit: 86400,
  },
  pnpm: {
    minimumVersion: '10.16.0',
    file: 'pnpm-workspace.yaml',
    key: 'minimumReleaseAge',
    value: '4320',
    unit: 60,
  },
  yarn: {
    minimumVersion: '4.10.0',
    file: '.yarnrc.yml',
    key: 'npmMinimalAgeGate',
    value: '4320',
    unit: 60,
  },
  bun: {
    minimumVersion: '1.3.0',
    file: 'bunfig.toml',
    section: 'install',
    key: 'minimumReleaseAge',
    value: '259200',
    unit: 1,
  },
  pip: {
    minimumVersion: '26.1.0',
    file: 'pip.conf',
    section: 'install',
    key: 'uploaded-prior-to',
    value: 'P3D',
  },
  uv: { minimumVersion: '0.9.17', file: 'uv.toml', key: 'exclude-newer', value: '"P3D"' },
};

export function supportsReleaseDelay(manager, version) {
  const policy = RELEASE_DELAY_POLICIES[manager];
  const match = String(version).match(/(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?(?=\s|$)/u);
  if (!policy || !match) return false;
  const actual = match.slice(1).map((part) => Number(part ?? 0));
  const minimum = policy.minimumVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

const INSTALL_COMMANDS = {
  npm: [
    'install',
    'i',
    'in',
    'ins',
    'inst',
    'insta',
    'instal',
    'add',
    'update',
    'up',
    'upgrade',
    'ci',
    'exec',
    'x',
  ],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'upgrade', 'dlx'],
  yarn: ['install', 'add', 'up', 'upgrade', 'upgrade-interactive', 'dlx'],
  bun: ['install', 'i', 'add', 'update', 'upgrade', 'x'],
  pip: ['install'],
  uv: ['add', 'sync', 'lock', 'run'],
};
const VALUE_OPTIONS = new Set([
  '--prefix',
  '--cwd',
  '--dir',
  '-C',
  '--directory',
  '--project',
  '--config',
  '--config-file',
  '--cache-dir',
  '--python',
  '--index-url',
  '--timeout',
  '--retries',
  '--proxy',
  '--cert',
  '--client-cert',
  '--log',
  '--registry',
  '--tag',
  '--cache',
  '--userconfig',
  '--globalconfig',
  '--location',
  '--keyring-provider',
  '--exists-action',
  '--trusted-host',
  '--use-feature',
  '--use-deprecated',
  '--resume-retries',
  '--cache-folder',
  '--mutex',
  '--filter',
]);

export function classifyInstall(manager, args) {
  if (!INSTALL_COMMANDS[manager]) return false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (
      VALUE_OPTIONS.has(args[i]) ||
      (manager === 'bun' && args[i] === '-c') ||
      (manager === 'npm' && ['-w', '--workspace'].includes(args[i]))
    ) {
      i++;
      continue;
    }
    if (args[i] === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (['--help', '-h'].includes(args[i])) return false;
    if (['--version', '-V'].includes(args[i]) && positional.length === 0) return false;
    if (args[i].startsWith('-')) continue;
    positional.push(args[i]);
  }
  if (manager === 'yarn' && positional.length === 0) return true;
  if (manager === 'npm' && positional[0] === 'audit') return positional[1] === 'fix';
  if (manager === 'uv' && ['pip', 'tool'].includes(positional[0])) {
    return (
      (positional[0] === 'pip' && ['install', 'sync'].includes(positional[1])) ||
      (positional[0] === 'tool' && ['install', 'upgrade', 'run'].includes(positional[1]))
    );
  }
  return INSTALL_COMMANDS[manager].includes(positional[0]);
}

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function effectiveInstallDirectory(manager, args, cwd) {
  const flags =
    manager === 'npm'
      ? ['--prefix', '-C']
      : manager === 'pnpm'
        ? ['--dir', '-C']
        : manager === 'yarn'
          ? ['--cwd']
          : ['uv', 'bun'].includes(manager)
            ? manager === 'uv'
              ? ['--directory', '-C', '--project']
              : ['--cwd']
            : [];
  let directory = resolve(cwd);
  let projectDirectory;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const [flag, inline] = args[i].split('=', 2);
    if (flags.includes(flag)) {
      const value = inline ?? args[++i];
      if (!value) throw new Error(`Missing directory for ${flag}`);
      if (manager === 'uv' && flag === '--project') projectDirectory = value;
      else directory = resolve(cwd, value);
    }
  }
  return projectDirectory ? resolve(directory, projectDirectory) : directory;
}

function configLocation(manager, cwd, env, version) {
  const policy = RELEASE_DELAY_POLICIES[manager];
  if (!policy) throw new Error(`Unsupported package manager: ${manager}`);
  if (manager === 'pip' && env?.PIP_CONFIG_FILE && env.PIP_CONFIG_FILE !== '/dev/null')
    return { ...policy, path: resolve(cwd, env.PIP_CONFIG_FILE) };
  if (manager === 'uv' && env?.VERITY_UV_CONFIG_FILE)
    return { ...policy, path: env.VERITY_UV_CONFIG_FILE };
  if (manager === 'bun')
    return { ...policy, path: env?.VERITY_BUN_CONFIG_FILE ?? join(resolve(cwd), policy.file) };
  // Match package managers' ancestor discovery instead of silently creating a
  // second config in a package of an existing workspace.
  let directory = resolve(cwd);
  for (;;) {
    const path = join(directory, policy.file);
    if (
      manager === 'pnpm' &&
      (!version || Number(version.match(/\d+/u)?.[0]) < 11) &&
      existsSync(join(directory, '.npmrc'))
    ) {
      const legacy = { ...policy, path: join(directory, '.npmrc'), key: 'minimum-release-age' };
      if (
        entries(read(legacy.path), legacy).result.length > 0 &&
        entries(read(path), { ...policy, path }).result.length === 0
      )
        return legacy;
    }
    if (existsSync(path)) return { ...policy, path };
    if (manager === 'uv' && existsSync(join(directory, 'pyproject.toml'))) {
      return { ...policy, path: join(directory, 'pyproject.toml'), section: 'tool.uv' };
    }
    if (existsSync(join(directory, '.git')) || dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return { ...policy, path: join(resolve(cwd), policy.file) };
}

function entries(text, config) {
  let section;
  const result = [];
  const lines = text.split(/\r?\n/u);
  // A line-based reader cannot distinguish configuration from multiline TOML prose.
  if (
    config.path.endsWith('.toml') &&
    (/"{3}|'{3}/u.test(text) ||
      lines.some((entry) => /^\s*\[.*["']/u.test(entry)) ||
      lines.some(
        (entry) =>
          /^\s*[^#\s][^=]*=\s*\{/u.test(entry) ||
          /^\s*(?:"[^"\n]+"|'[^'\n]+'|[\w-]+)\s*\./u.test(entry),
      ))
  )
    return { lines, result, unsupported: true };
  if (
    /\.ya?ml$/u.test(config.path) &&
    lines.some(
      (entry) =>
        /^\s*[[{]/u.test(entry) ||
        /^['"]/u.test(entry) ||
        /^\s*(?:---|\.\.\.)/u.test(entry) ||
        /:\s*[|>]/u.test(entry) ||
        /:\s*[&*]/u.test(entry),
    )
  )
    return { lines, result, unsupported: true };
  if (
    /\.ya?ml$/u.test(config.path) &&
    /^\s/u.test(lines.find((entry) => !/^\s*(?:#|$)/u.test(entry)) ?? '')
  )
    return { lines, result, unsupported: true };
  // INI indentation can turn following options into continuations after an edit.
  if (config.key === 'uploaded-prior-to' && lines.some((entry) => /^\s+[^\s#;]/u.test(entry)))
    return { lines, result, unsupported: true };
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index].match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/u);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== config.section) continue;
    if (/\.ya?ml$/u.test(config.path) && /^\s/u.test(lines[index])) continue;
    const match = lines[index].match(
      /^\s*(['"]?)([A-Za-z][\w-]*)\1\s*[:=]\s*(.*?)\s*(?:\s+[#;].*)?$/u,
    );
    const key = config.key === 'uploaded-prior-to' ? match?.[2].toLowerCase() : match?.[2];
    if (key === config.key) {
      const value = config.path.endsWith('.toml') ? match[3].replace(/#.*$/u, '').trim() : match[3];
      result.push({ index, value });
    }
  }
  return { lines, result };
}

function seconds(value, config) {
  const clean = value.replace(/^(['"])(.*)\1$/u, '$2');
  if (/^\d+(?:\.\d+)?$/u.test(clean)) return Number(clean) * (config.unit ?? 0);
  if (['min-release-age', 'minimum-release-age', 'minimumReleaseAge'].includes(config.key))
    return 0;
  if (
    config.key === 'npmMinimalAgeGate' &&
    !supportsReleaseDelay('yarn', config.version ?? '4.10.0')
  )
    return 0;
  if (
    config.key === 'npmMinimalAgeGate' &&
    Number((config.version ?? '4.10.0').split('.')[1]) < 11 &&
    Number((config.version ?? '4.10.0').split('.')[0]) === 4
  )
    return 0;
  if (
    ['uploaded-prior-to', 'exclude-newer'].includes(config.key) &&
    /^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(clean)
  ) {
    const timestamp = Date.parse(clean);
    return Number.isFinite(timestamp) ? (Date.now() - timestamp) / 1000 : 0;
  }
  if (config.key === 'uploaded-prior-to' && !/^P\d+D$/u.test(clean)) return 0;
  const iso = clean.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/iu,
  );
  if (iso)
    return (
      Number(iso[1] ?? 0) * 86400 +
      Number(iso[2] ?? 0) * 3600 +
      Number(iso[3] ?? 0) * 60 +
      Number(iso[4] ?? 0)
    );
  const friendly = clean.match(
    /^(\d+(?:\.\d+)?)\s*(d|days?|h|hours?|m|minutes?|s|seconds?|w|weeks?)$/iu,
  );
  if (friendly)
    return (
      Number(friendly[1]) *
      { d: 86400, h: 3600, m: 60, s: 1, w: 604800 }[friendly[2][0].toLowerCase()]
    );
  return 0;
}

export function detectReleaseDelay(manager, cwd, env, version) {
  const config = configLocation(manager, cwd, env, version);
  let { result, unsupported } = entries(read(config.path), config);
  if (unsupported)
    return { protected: false, path: config.path, key: config.key, setupSupported: false };
  if (manager === 'pip' && result.length === 0)
    result = entries(read(config.path), { ...config, section: 'global' }).result;
  const value = result.at(-1)?.value;
  const projectSeconds = result.length === 1 ? seconds(value ?? '', { ...config, version }) : 0;
  const environmentValues =
    manager === 'pip'
      ? [env?.PIP_UPLOADED_PRIOR_TO]
      : manager === 'npm'
        ? [env?.npm_config_min_release_age, env?.NPM_CONFIG_MIN_RELEASE_AGE]
        : manager === 'uv'
          ? [env?.UV_EXCLUDE_NEWER]
          : [];
  environmentValues.push(env?.VERITY_NATIVE_RELEASE_AGE);
  if (env?.HOME && (manager === 'uv' || (manager === 'bun' && result.length === 0))) {
    const paths =
      manager === 'bun'
        ? [
            join(env.HOME, '.bunfig.toml'),
            join(env.XDG_CONFIG_HOME ?? join(env.HOME, '.config'), '.bunfig.toml'),
          ]
        : [
            join(env.XDG_CONFIG_HOME ?? join(env.HOME, '.config'), 'uv', 'uv.toml'),
            '/etc/uv/uv.toml',
          ];
    for (const path of paths) {
      const native = entries(read(path), {
        ...config,
        path,
        section: manager === 'bun' ? 'install' : undefined,
      }).result;
      if (native.length === 1) environmentValues.push(native[0].value);
    }
  }
  let effectiveSeconds = projectSeconds;
  let effectiveValue = value;
  for (const candidate of environmentValues) {
    if (candidate === undefined) continue;
    const age = seconds(candidate, { ...config, version });
    if (age > effectiveSeconds) {
      effectiveSeconds = age;
      effectiveValue = candidate;
    }
  }
  if (['yarn', 'pnpm'].includes(manager) && env?.VERITY_NATIVE_RELEASE_AGE?.trim()) {
    effectiveValue = env.VERITY_NATIVE_RELEASE_AGE;
    effectiveSeconds = seconds(effectiveValue, { ...config, version });
  }
  // Duplicate YAML/TOML keys are invalid, and must not be reported as active.
  return {
    protected: effectiveSeconds >= 259200,
    path: config.path,
    key: config.key,
    value: effectiveValue,
  };
}

export function configureReleaseDelay(manager, cwd, version, env) {
  if (!supportsReleaseDelay(manager, version))
    throw new Error(`${manager} ${version} does not support a relative 3-day release delay`);
  // Setup replaces the queried effective floor and then applies it to this invocation.
  if (['yarn', 'pnpm'].includes(manager)) {
    env = { ...env };
    delete env.VERITY_NATIVE_RELEASE_AGE;
  }
  const config = configLocation(manager, cwd, env, version);
  const previous = read(config.path);
  const detected = detectReleaseDelay(manager, cwd, env, version);
  if (detected.setupSupported === false)
    throw new Error(
      `Unsupported configuration syntax in ${config.path}; configure the delay manually`,
    );
  if (detected.protected) return detected;
  const { lines, result } = entries(previous, config);
  if (result.length > 1)
    throw new Error(`Duplicate ${config.key} entries in ${config.path}; resolve them before setup`);
  const separator = config.path.endsWith('.yaml') || config.path.endsWith('.yml') ? ': ' : ' = ';
  const line = `${config.key}${separator}${config.value}`;
  if (result.length === 1) {
    const index = result[0].index;
    const comment = lines[index].match(/\s+([#;].*)$/u)?.[0] ?? '';
    lines[index] = line + comment;
  } else if (config.section) {
    const header = lines.findIndex((entry) =>
      new RegExp(`^\\s*\\[${config.section.replaceAll('.', '\\.')}\\]\\s*(?:[#;].*)?$`, 'u').test(
        entry,
      ),
    );
    if (header >= 0) lines.splice(header + 1, 0, line);
    else lines.push(`[${config.section}]`, line);
  } else {
    // Root TOML keys have to precede all tables.
    const firstTable = lines.findIndex((entry) => /^\s*\[/u.test(entry));
    if (manager === 'uv' && firstTable >= 0) lines.splice(firstTable, 0, line);
    else lines.push(line);
  }
  const newline = previous.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(config.path, lines.join(newline).replace(/\s*$/u, '') + newline, { mode: 0o600 });
  const updated = detectReleaseDelay(manager, cwd, env, version);
  if (!updated.protected) throw new Error(`Could not verify ${config.key} in ${config.path}`);
  return updated;
}
