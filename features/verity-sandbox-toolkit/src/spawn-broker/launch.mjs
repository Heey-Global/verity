import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_SCRIPT_SANDBOX_PATH,
  DEFAULT_WORKTREE_ROOT,
  agentWorkspaceRead,
  childEnvironment,
  isObject,
  isSafeTrustedCliEnvName,
  npmCachePath,
  privilegeDropFlags,
  validateIdentity,
  validateImmutablePath,
  validateTrustedCliExecutable,
  validateTrustedCliExecutableDirectory,
  validateTrustedCliFileIntegrity,
  withinAgentWorktreeRoots,
} from './request.mjs';
import {
  nodeRuntimeRoots,
  planningRuntimeRoots,
  restrictedOpenCodePermissions,
  restrictedOpenCodePolicies,
} from './session-home.mjs';

function claudePolicyRoots(command) {
  if (command !== 'claude-agent-acp') return [];
  const path = '/etc/claude-code';
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata) return [];
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0
  )
    throw new Error('Invalid Claude managed policy directory');
  // The SDK reads both managed-settings.json and managed-settings.d. Without
  // directory access Landlock reports EACCES even for absent policy files.
  // Keep the system policy read-only, outside the writable session home.
  return ['--read-root', path];
}

function normalSessionRoots(options, agentPath) {
  const roots = [];
  for (const [flag, path] of [
    // Image-owned hooks and wrapper targets must remain executable under confinement.
    ['--read-root', '/opt/agent-seed'],
    ['--read-root', '/opt/verity/package-managers'],
    ['--read-root', '/knowledge'],
    ['--write-root', '/knowledge/insights'],
  ]) {
    try {
      const metadata = lstatSync(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error('Invalid session access root');
      roots.push(flag, path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // The installer links existing npm CLIs into /usr/local/bin. Grant their
  // module installation tree, never the enclosing nvm user home.
  const moduleRoots = new Set();
  for (const executable of [
    agentPath,
    '/usr/local/bin/codex',
    '/usr/local/bin/claude',
    '/usr/local/bin/opencode',
  ]) {
    try {
      const target = realpathSync(executable);
      const index = target.indexOf('/node_modules/');
      if (index >= 0) moduleRoots.add(target.slice(0, index + '/node_modules'.length));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const path of moduleRoots) roots.push('--read-root', path);
  // Node reads this configuration before starting the ACP adapter.
  // Keep the sibling TLS private-key directory outside the policy.
  roots.push(...nodeRuntimeRoots());
  // These files are selected by trusted container configuration, never turn input.
  for (const key of [
    'VERITY_FORGE_PROXY_CA_FILE',
    'VERITY_SIGNING_TOKEN_FILE',
    'VERITY_GH_BROKER_CAPABILITY_FILE',
  ]) {
    const path =
      options.env?.[key] ??
      {
        VERITY_SIGNING_TOKEN_FILE: '/run/verity/ssh/signing_broker_token',
        VERITY_GH_BROKER_CAPABILITY_FILE: '/run/verity/gh-token-capability',
      }[key];
    if (
      path !== undefined &&
      (options.env?.[key] !== undefined || lstatSync(path, { throwIfNoEntry: false }))
    )
      roots.push('--secret', path);
  }
  return roots;
}

export function agentLaunchSpec(request, options) {
  if (request.gatewayToolsOnly && request.knowledgeIsolation)
    throw new Error('Native tool isolation cannot use the separate knowledge runtime');
  if (request.gatewayToolsOnly && !request.managedHome && !request.knowledgeHome)
    throw new Error('Native tool isolation requires broker-owned configuration');
  const { uid, gid } = validateIdentity(options);
  const setprivPath = options.setprivPath ?? '/usr/bin/setpriv';
  const normalConfinement =
    !!request.managedHome &&
    !request.planning &&
    !request.knowledgeIsolation &&
    options.dockerGid === undefined;
  // One entry per accepted `command`, and no fallback: the chain this replaces ended
  // in a default that resolved anything unrecognized to the native `claude` binary,
  // which is exactly the transport ADR 0012 retired. An unmapped command must fail
  // loudly here rather than silently launch some other agent under the caller's argv.
  // Null-prototype, so `constructor`/`valueOf`/`toString` are unmapped like any other
  // unknown command instead of resolving to an inherited function and sailing past the
  // guard below into a privileged `setpriv` exec. `validateSpawnRequest` already bounds
  // the broker's own flow, but `agentLaunchSpec` is exported and this is its last check.
  const agentPaths = Object.assign(Object.create(null), {
    'codex-acp': options.codexAcpPath ?? '/usr/local/bin/codex-acp',
    'claude-agent-acp': options.claudeAcpPath ?? '/usr/local/bin/claude-agent-acp',
    // A root-owned wrapper the Feature writes (`exec opencode acp "$@"`), because
    // OpenCode speaks ACP as a subcommand and ships no adapter binary of its own.
    // The indirection lives in the image rather than in this argv on purpose: the
    // mapping stays one fixed command name to one fixed executable, so nothing
    // here has to know that this agent needs a subcommand and the others do not.
    'opencode-acp': options.openCodeAcpPath ?? '/usr/local/bin/opencode-acp',
  });
  const agentPath = typeof request.command === 'string' ? agentPaths[request.command] : undefined;
  if (typeof agentPath !== 'string') {
    throw new Error(`unsupported agent command '${String(request.command)}'`);
  }
  if ((request.knowledgeIsolation || request.planning) && typeof request.knowledgeHome !== 'string')
    throw new Error('Wiki isolation home was not prepared');
  return {
    command: setprivPath,
    args: [
      `--reuid=${String(uid)}`,
      `--regid=${String(gid)}`,
      // Never `options.runnerGid`, and never a shorter list than this one: these
      // flags ARE the ADR 0006 anti-forgery boundary for a PROJECT Sandbox — the
      // case the boundary exists for, since that is where repository code runs.
      // See PRIVILEGE_DROP_FLAGS, including what ADR 0006 Amendment 1 takes away
      // from the control-plane Runner and why this argv does not restore it.
      // `options.dockerGid` is that one sanctioned variation, and it swaps
      // `--clear-groups` for `--groups=<docker>` — never the runtime GID.
      ...privilegeDropFlags(
        request.knowledgeIsolation || request.planning ? undefined : options.dockerGid,
        options.runnerGid,
      ),
      ...(request.knowledgeIsolation || request.planning || normalConfinement
        ? [
            options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH,
            '--root',
            request.planning || normalConfinement
              ? request.cwd === (options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT) ||
                request.cwd.startsWith(`${options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT}/`)
                ? (options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT)
                : (options.sharedSessionRoot ?? request.cwd)
              : request.cwd,
            '--cwd',
            request.cwd,
            '--loading',
            'dynamic',
            '--dynamic-root',
            normalConfinement ? request.managedHome : request.knowledgeHome,
            request.planning ? '--read-only-root' : '--write-isolated',
            ...(request.command === 'opencode-acp' ? ['--self-proc-maps'] : []),
            request.planning ? '--runtime-root' : '--write-root',
            npmCachePath(options),
            ...planningRuntimeRoots(request, options).flatMap((path) => ['--runtime-root', path]),
            ...(normalConfinement ? normalSessionRoots(options, agentPath) : []),
            ...(request.planning || request.knowledgeIsolation ? nodeRuntimeRoots() : []),
            ...claudePolicyRoots(request.command),
            '--',
          ]
        : []),
      ...(options.signalTraceSeconds === undefined ||
      request.command !== 'codex-acp' ||
      request.knowledgeIsolation
        ? []
        : [
            '/usr/bin/python3',
            '/usr/local/bin/verity-agent-signal-trace',
            '--seconds',
            String(options.signalTraceSeconds),
            '--launch',
          ]),
      agentPath,
      ...request.args,
    ],
    spawnOptions: {
      cwd: request.cwd,
      env: {
        ...childEnvironment(
          request.command,
          {
            ...options.env,
            VERITY_CLAUDE_CONNECTOR_URL: options.connectorUrl,
          },
          request.sessionEnv,
          request.turnCapability,
          request.gitAuthor,
          request.signCommits,
        ),
        VERITY_SESSION_WORKTREE: request.cwd,
        // Disabling project config also disables automatic AGENTS.md discovery.
        // Keep repository guidance as text, without allowing repository JSON to
        // configure providers, permissions or executable extensions. Wiki turns
        // deliberately receive no project instructions.
        ...(request.command === 'opencode-acp'
          ? {
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                instructions:
                  request.knowledgeIsolation || request.gatewayToolsOnly
                    ? []
                    : [join(request.cwd, 'AGENTS.md')],
                websearch: { provider: 'exa' },
                policies: request.gatewayToolsOnly
                  ? restrictedOpenCodePolicies()
                  : [
                      { action: 'integration.use', resource: 'plugin:*', effect: 'deny' },
                      { action: 'provider.use', resource: '*', effect: 'deny' },
                      { action: 'provider.use', resource: 'verity', effect: 'allow' },
                    ],
                permissions: request.gatewayToolsOnly
                  ? restrictedOpenCodePermissions()
                  : [
                      { action: 'external_directory', resource: '*', effect: 'ask' },
                      { action: 'external_directory', resource: '/knowledge/**', effect: 'allow' },
                    ],
              }),
            }
          : {}),
        ...(request.managedHome
          ? {
              HOME: request.managedHome,
              ...(request.command === 'claude-agent-acp'
                ? { CLAUDE_CONFIG_DIR: join(request.managedHome, 'claude') }
                : {}),
              ...(request.command === 'codex-acp'
                ? { CODEX_HOME: join(request.managedHome, 'codex') }
                : {}),
              XDG_CONFIG_HOME: join(request.managedHome, 'config'),
              OPENCODE_CONFIG: join(request.managedHome, 'config', 'opencode.json'),
              XDG_DATA_HOME: join(request.managedHome, 'data'),
              XDG_STATE_HOME: join(request.managedHome, 'state'),
              XDG_CACHE_HOME: join(request.managedHome, 'cache'),
              npm_config_logs_dir: join(request.managedHome, 'cache', '_logs'),
              TMPDIR: join(request.managedHome, 'tmp'),
            }
          : {}),
        ...(request.knowledgeIsolation || request.planning
          ? {
              HOME: request.knowledgeHome,
              CLAUDE_CONFIG_DIR: join(request.knowledgeHome, 'claude'),
              CODEX_HOME: join(request.knowledgeHome, 'codex'),
              XDG_CONFIG_HOME: join(request.knowledgeHome, 'config'),
              OPENCODE_CONFIG: join(request.knowledgeHome, 'config', 'opencode.json'),
              ...(request.command === 'opencode-acp' &&
              request.planning &&
              !request.knowledgeIsolation &&
              !request.sessionEnv?.VERITY_SESSION_ID
                ? Object.fromEntries(
                    ['data', 'state', 'cache'].map((name) => [
                      `XDG_${name.toUpperCase()}_HOME`,
                      join(planningRuntimeRoots(request, options)[0], name),
                    ]),
                  )
                : {
                    XDG_DATA_HOME: join(request.knowledgeHome, 'data'),
                    XDG_STATE_HOME: join(request.knowledgeHome, 'state'),
                    XDG_CACHE_HOME: join(request.knowledgeHome, 'cache'),
                  }),
              npm_config_logs_dir: join(request.knowledgeHome, 'cache', '_logs'),
              TMPDIR: join(request.knowledgeHome, 'tmp'),
            }
          : {}),
        npm_config_cache: npmCachePath(options),
      },
      stdio: [
        'pipe',
        'pipe',
        'pipe',
        ...(request.sessionLockFd === undefined ? [] : [request.sessionLockFd]),
        ...(request.packageCacheLockFd === undefined ? [] : [request.packageCacheLockFd]),
      ],
      // Give every agent invocation its own process group. Codex can leave tool
      // and sub-agent descendants running after its direct process receives a
      // signal; those descendants inherit stdout and keep the broker/turn open.
      // The broker can therefore only guarantee Stop by signalling this whole
      // group, rather than the setpriv/Codex process alone.
      detached: true,
    },
  };
}

/**
 * Fixed on purpose. An argument that must name the file — `example-cli up
 * --secret=file:/run/verity-runner/secrets/EXAMPLE_TOKEN` — can then be written by
 * the caller without Verity substituting anything into argv, which would add an
 * injection surface in the one place that has to stay literal.
 */
/**
 * Interpreters run whatever their argument names, so for them a plain data file
 * is code too. Everything else only runs a file that is marked executable.
 */
const TRUSTED_CLI_INTERPRETERS = new Set([
  'sh',
  'bash',
  'ash',
  'awk',
  'busybox',
  'bun',
  'dash',
  'deno',
  'fish',
  'zsh',
  'ksh',
  'lua',
  'node',
  'nodejs',
  'perl',
  'php',
  'pwsh',
  'python',
  'python2',
  'python3',
  'ruby',
  'Rscript',
  'tclsh',
]);
function trustedCliInterpreterName(token) {
  const name = token.slice(token.lastIndexOf('/') + 1);
  return TRUSTED_CLI_INTERPRETERS.has(name) ||
    /^(?:g|m|n)?awk$/u.test(name) ||
    /^(?:python|ruby)\d+(?:\.\d+)*$/u.test(name)
    ? name
    : undefined;
}

export const TRUSTED_CLI_ARGV_POLICY_SUFFIX = '.verity-trusted-cli-policy.json';
export const LEGACY_TRUSTED_CLI_ARGV_POLICY_SUFFIX = '.breeze-trusted-cli-policy.json';
// Paginated diagnostic modes can exceed 64 routes; keep the whole policy bounded
// without invalidating every existing route when another mode is installed.
const MAX_TRUSTED_CLI_ARGV_POLICY_ROUTES = 256;
const MAX_TRUSTED_CLI_ARGV_POLICY_BYTES = 64 * 1024;
const TRUSTED_CLI_POLICY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

function parseTrustedCliArgvPolicy(raw) {
  if (
    !isObject(raw) ||
    raw.version !== 1 ||
    Object.keys(raw).some((key) => key !== 'version' && key !== 'routes') ||
    !Array.isArray(raw.routes) ||
    raw.routes.length === 0 ||
    raw.routes.length > MAX_TRUSTED_CLI_ARGV_POLICY_ROUTES
  ) {
    throw new Error('trusted CLI argv policy is invalid');
  }
  const routes = raw.routes.map((route) => {
    if (!Array.isArray(route) || route.length === 0 || route.length > 255) {
      throw new Error('trusted CLI argv policy is invalid');
    }
    return route.map((token) => {
      if (typeof token === 'string' && token.length > 0) return token;
      if (isObject(token) && token.kind === 'identifier' && Object.keys(token).length === 1) {
        return token;
      }
      throw new Error('trusted CLI argv policy is invalid');
    });
  });
  return { version: 1, routes };
}

export function matchesTrustedCliArgvPolicy(policy, args) {
  const parsed = parseTrustedCliArgvPolicy(policy);
  return parsed.routes.some(
    (route) =>
      route.length === args.length &&
      route.every(
        (token, index) =>
          (typeof token === 'string' && token === args[index]) ||
          (isObject(token) &&
            token.kind === 'identifier' &&
            TRUSTED_CLI_POLICY_IDENTIFIER.test(args[index] ?? '')),
      ),
  );
}

export async function loadTrustedCliArgvPolicy(resolvedCommand, options = {}) {
  const inspect = options.lstat ?? lstat;
  const validatePath = options.validateImmutablePath ?? validateImmutablePath;
  const read = options.readFile ?? readFile;
  let path;
  let entry;
  for (const suffix of [TRUSTED_CLI_ARGV_POLICY_SUFFIX, LEGACY_TRUSTED_CLI_ARGV_POLICY_SUFFIX]) {
    const candidate = `${resolvedCommand}${suffix}`;
    try {
      entry = await inspect(candidate);
      path = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (path === undefined || entry === undefined) return undefined;
  if (!entry.isFile() || entry.size > MAX_TRUSTED_CLI_ARGV_POLICY_BYTES) {
    throw new Error('trusted CLI argv policy is invalid');
  }
  await validatePath(path);
  try {
    return parseTrustedCliArgvPolicy(JSON.parse(await read(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message === 'trusted CLI argv policy is invalid') {
      throw error;
    }
    throw new Error('trusted CLI argv policy is invalid', { cause: error });
  }
}
const TRUSTED_CLI_CODE_LOADING_ENV = new Set([
  'BASH_ENV',
  'ENV',
  // The environment spelling of `-javaagent:`: the JVM reads its options out of
  // these, so `env JAVA_TOOL_OPTIONS=-javaagent:<jar> java Main` loads the same
  // jar without ever naming it in a place argv inspection reaches.
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  '_JAVA_OPTIONS',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LUA_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PERL5LIB',
  'PERL5OPT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'RUBYLIB',
]);

/**
 * The executable check used to cover `argv[0]` alone. That is not what runs:
 * `/usr/bin/timeout 240s /usr/bin/env … /work/…/script.sh` passes it, because
 * `timeout` is root-owned — while the payload is a script in the agent's own
 * worktree, rewritable between one approved run and the next.
 *
 * What this rule protects is INTEGRITY, not confinement: the approval card
 * already warns that a trusted process may disclose its secret outright, so
 * `sh -c '<inline code>'` stays legitimate — the operator read that code before
 * approving. A path is different. It shows a name, never the bytes behind it,
 * and those bytes can change after the approval and before the next run.
 *
 * So every argument that names a file which may affect execution must be as
 * immutable as the command itself. The sole mutable exception is the exact
 * Verity-materialized secret path supplied by file injection; arbitrary mutable
 * workspace data stays fail-closed because formats such as config can load
 * executable plugins.
 */
export async function validateTrustedCliArguments(
  command,
  args,
  cwd,
  executablePath = '/usr/local/bin:/usr/bin:/bin',
  mutableDataPaths = [],
  approvedEntryScript,
  options = {},
) {
  const workspaceRealpath =
    approvedEntryScript === undefined || options.agentUid === undefined
      ? realpath
      : (path) => agentWorkspaceRead('realpath', path, options);
  const workspaceLstat =
    approvedEntryScript === undefined || options.agentUid === undefined
      ? lstat
      : (path) => agentWorkspaceRead('lstat', path, options);
  // Production reaches this only after validateTrustedCliExecutable; retain the
  // basename fallback for direct validator callers and focused unit fixtures.
  const resolvedCommand = await realpath(command).catch(() => command);
  const commandName = resolvedCommand.slice(resolvedCommand.lastIndexOf('/') + 1);
  let interpreterName = trustedCliInterpreterName(resolvedCommand) ?? '';
  let interpreter = interpreterName.length > 0;
  let inlineCodeFollows = false;
  let remainingAreData = false;
  let approvedDynamicScriptSeen = false;
  let executableDirectories = executablePath.split(':').map((dir) => resolve(cwd, dir));
  await Promise.all(executableDirectories.map(validateTrustedCliExecutableDirectory));
  const argvPolicy = await (options.loadArgvPolicy ?? loadTrustedCliArgvPolicy)(resolvedCommand);
  if (argvPolicy !== undefined) {
    if (!matchesTrustedCliArgvPolicy(argvPolicy, args)) {
      throw new Error('trusted CLI argv is not allowed by executable policy');
    }
    return;
  }
  let envWrapper = commandName === 'env';
  let timeoutWrapper = commandName === 'timeout';
  let timeoutDurationSeen = false;
  let requiredFileOperand = false;
  // What the exception may waive is the file Verity is about to write, so the
  // comparison has to be the one open(2) makes. `resolve` collapses `..`
  // textually: `<dir>/link/../SECRET` matches the secret path lexically while
  // the kernel follows `link` first and lands somewhere else entirely. Walking
  // up to the nearest existing ancestor is what keeps that usable before file
  // injection has created the directory it writes into.
  const canonicalPath = async (path) => {
    let current = path.startsWith('/') ? path : `${cwd}/${path}`;
    while (current.length > 1 && current.endsWith('/')) current = current.slice(0, -1);
    const missing = [];
    for (;;) {
      const real = await realpath(current).catch(() => undefined);
      if (real !== undefined) return missing.length === 0 ? real : join(real, ...missing);
      const slash = current.lastIndexOf('/');
      if (slash < 0) return resolve(cwd, path);
      missing.unshift(current.slice(slash + 1));
      current = slash === 0 ? '/' : current.slice(0, slash);
    }
  };
  const namesMaterializedSecret = async (paths) => {
    for (const secretPath of mutableDataPaths) {
      const secret = await canonicalPath(secretPath);
      for (const path of paths) {
        if ((await canonicalPath(path)) === secret) return true;
      }
    }
    return false;
  };
  // A refusal an agent cannot act on is a refusal it repeats verbatim: name the
  // token that failed, and the path file injection does allow before it exists.
  const describeOperand = (operand) => {
    const token = operand.length > 200 ? `${operand.slice(0, 200)}…` : operand;
    if (mutableDataPaths.length === 0) return token;
    return `${token} (only ${mutableDataPaths.join(', ')} may be named before it is written)`;
  };
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    const fileOperandRequired = requiredFileOperand;
    requiredFileOperand =
      (commandName === 'make' && arg === '-f') ||
      (commandName === 'xargs' && arg === '-a') ||
      ((commandName === 'java' || commandName === 'javac') &&
        (arg === '-cp' || arg === '-classpath' || arg === '--class-path'));
    if (inlineCodeFollows) {
      // Arguments after `-c <code>` are values supplied to that already-visible
      // code, not files the interpreter itself executes.
      inlineCodeFollows = false;
      interpreter = false;
      remainingAreData = true;
      continue;
    }
    const shellInline =
      ['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(interpreterName) && /^-[^-]*c/u.test(arg);
    const otherInline =
      ['node', 'nodejs', 'perl', 'ruby'].includes(interpreterName) &&
      (arg === '-e' || arg === '--eval');
    const attachedInline =
      ['node', 'nodejs', 'perl', 'ruby'].includes(interpreterName) &&
      (/^-e.+/u.test(arg) || arg.startsWith('--eval='));
    if (interpreter && attachedInline) {
      interpreter = false;
      remainingAreData = true;
      continue;
    }
    if (interpreter && (shellInline || arg === '-c' || otherInline)) {
      inlineCodeFollows = true;
      continue;
    }
    if (interpreter && interpreterName.startsWith('python') && /^-m/u.test(arg)) {
      throw new Error('trusted CLI interpreter module execution is not immutable');
    }
    if (interpreter && arg.startsWith('-')) {
      throw new Error('trusted CLI interpreter option execution is not immutable');
    }
    if (envWrapper && arg.startsWith('-')) {
      throw new Error('trusted CLI env option execution is not immutable');
    }
    if (!interpreter && arg.startsWith('PATH=')) {
      executableDirectories = arg
        .slice('PATH='.length)
        .split(':')
        .map((dir) => resolve(cwd, dir));
      await Promise.all(executableDirectories.map(validateTrustedCliExecutableDirectory));
      continue;
    }
    if (envWrapper && arg.includes('=')) {
      const name = arg.slice(0, arg.indexOf('='));
      if (TRUSTED_CLI_CODE_LOADING_ENV.has(name)) {
        throw new Error('trusted CLI code-loading environment is not immutable');
      }
    }
    const envCommandOperand = envWrapper && !arg.includes('=');
    if (envCommandOperand) envWrapper = false;
    let timeoutCommandOperand = false;
    if (timeoutWrapper && !arg.startsWith('-')) {
      if (timeoutDurationSeen) {
        timeoutCommandOperand = true;
        timeoutWrapper = false;
      } else {
        timeoutDurationSeen = true;
      }
    }
    if (interpreterName === 'busybox') {
      const appletInterpreter = trustedCliInterpreterName(arg);
      if (appletInterpreter !== undefined) {
        interpreterName = appletInterpreter;
        interpreter = true;
        continue;
      }
    }
    const activatedInterpreterName =
      !remainingAreData && !interpreter ? trustedCliInterpreterName(arg) : undefined;
    const activatesInterpreter = activatedInterpreterName !== undefined;
    const bareExecutableOperand =
      activatesInterpreter || envCommandOperand || timeoutCommandOperand;
    const filesystemToken = (token) =>
      token.startsWith('/') ||
      token.startsWith('./') ||
      token.startsWith('../') ||
      token.startsWith('file:');
    // `file:` is a label the option defines, never a name on disk, so only the
    // stripped path is looked up — and it inherits the explicit-filesystem
    // reading of the spelling it came from, or `file:payload.args` would be
    // waved through where `file:./payload.args` is refused.
    const pathTokens = [{ token: arg, explicit: filesystemToken(arg) }];
    const equals = arg.indexOf('=');
    if (equals >= 0 && equals + 1 < arg.length) {
      const value = arg.slice(equals + 1);
      pathTokens.push({ token: value, explicit: filesystemToken(value) });
      if (value.startsWith('file:')) {
        pathTokens.push({ token: value.slice('file:'.length), explicit: true });
      }
    }
    if (arg.startsWith('file:')) {
      pathTokens.push({ token: arg.slice('file:'.length), explicit: true });
    }
    // A path can also ride inside a single token, behind a prefix the option
    // itself defines. `java @args.txt` takes the rest of its argv out of that
    // file, so the file decides what runs; `-javaagent:`, `-agentpath:` and
    // `-Xbootclasspath/a:` name code the JVM loads before main. Neither spelling
    // is reachable by reading the whole token or the part after `=`, so both
    // passed with the file sitting in the agent's own worktree.
    if (arg.startsWith('@') && arg.length > 1) {
      const value = arg.slice(1);
      pathTokens.push({ token: value, explicit: filesystemToken(value) });
    }
    const optionColon = arg.startsWith('-') ? arg.indexOf(':') : -1;
    // Only when the colon comes first. In `--url=https://host` the colon belongs
    // to the value's scheme, and reading behind it would yield `//host` — a
    // token that looks absolute, exists nowhere, and would refuse an ordinary
    // HTTPS argument.
    if (optionColon >= 0 && optionColon + 1 < arg.length && (equals < 0 || optionColon < equals)) {
      // `-javaagent:<jar>=<agent options>`: the jar ends at the first `=`, and
      // `<jar>=<options>` names nothing on disk, so requiring the whole of it to
      // exist would refuse every agent that takes options.
      const carried = arg.slice(optionColon + 1);
      const carriedEquals = carried.indexOf('=');
      const carriedPath = carriedEquals > 0 ? carried.slice(0, carriedEquals) : carried;
      pathTokens.push({ token: carriedPath, explicit: filesystemToken(carriedPath) });
      // The options are the agent's own syntax, and `=config=/work/agent.conf`
      // names a file it reads — a file that decides what the agent does, for
      // the same reason a config does. Reading them out is what keeps an
      // immutable jar from vouching for mutable content behind it. Only
      // explicit filesystem spellings are taken: a bare relative name stays the
      // documented gap it is in every other operand.
      if (carriedEquals > 0) {
        for (const fragment of carried.slice(carriedEquals + 1).split(/[,=]/u)) {
          const value = fragment.startsWith('file:') ? fragment.slice('file:'.length) : fragment;
          if (fragment.startsWith('file:') || filesystemToken(value)) {
            pathTokens.push({ token: value, explicit: true });
          }
        }
      }
    }
    // One group per spelling the token carries. Within a group the locations are
    // alternatives — the PATH search for a bare name — so the first that exists
    // wins. Across groups they are not: `-javaagent:<jar>=<opts>` names two
    // independent files, and stopping at whichever happens to exist left the
    // other unread, whether that meant skipping its integrity check or waiving
    // it along with the secret that shared its token.
    const pathGroups = pathTokens
      .map(({ token, explicit }) => ({
        token,
        explicit,
        locations:
          /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(token) || token.startsWith('file:')
            ? []
            : token.startsWith('/')
              ? [token]
              : token.includes('/') || interpreter
                ? [resolve(cwd, token)]
                : bareExecutableOperand
                  ? executableDirectories.map((dir) => resolve(dir, token))
                  : [resolve(cwd, token)],
      }))
      .filter((group) => group.locations.length > 0);
    let candidate;
    let entry;
    for (const group of pathGroups) {
      let found;
      let stat;
      for (const path of group.locations) {
        try {
          const canonical = await workspaceRealpath(path);
          found = path;
          stat = await workspaceLstat(canonical);
          break;
        } catch {
          // Keep searching the effective PATH.
        }
      }
      if (found === undefined || stat === undefined) {
        // File injection writes the secret only after this check, so its path is
        // legitimately absent here. What makes that safe is where the token
        // points, not how it is spelled: `--secret=file:<path>` and
        // `--secret-file <path>` name the same root-owned directory entry that
        // no agent can pre-create. Reading the spelling instead would leave every
        // tool whose flag takes a plain path unable to use file injection at all.
        if (!interpreter && (await namesMaterializedSecret(group.locations))) continue;
        if (interpreter) throw new Error('trusted CLI interpreter operand does not exist');
        if (group.explicit || bareExecutableOperand || fileOperandRequired) {
          throw new Error(`trusted CLI file operand does not exist: ${describeOperand(arg)}`);
        }
        continue;
      }
      // Dynamic approval already grants this script access to its worktree.
      // Directory data must not fail solely because it is named in argv.
      if (
        stat.isDirectory() &&
        !interpreter &&
        !bareExecutableOperand &&
        approvedDynamicScriptSeen &&
        withinAgentWorktreeRoots(await workspaceRealpath(found), [approvedEntryScript.worktreeRoot])
      )
        continue;
      // A socket names an endpoint the command talks to, and is judged by whose
      // it is (see validateTrustedCliFileIntegrity). Not so in the one position
      // where a script belongs: an interpreter's operand is read for bytes, so a
      // special file standing in it stays refused as any other special file is.
      if (!stat.isFile() && (interpreter || !stat.isSocket())) {
        throw new Error('trusted CLI file operand must be a regular file');
      }
      // Configuration and "data" files can themselves activate code (for example
      // config.exec or Git helpers). The only mutable file whose provenance
      // Verity can vouch for is the secret it materialized for this exact launch.
      if (!interpreter && (await namesMaterializedSecret([found]))) continue;
      if (candidate === undefined) {
        // The operand the token is about: what decides whether it runs, and
        // whether an interpreter follows.
        candidate = found;
        entry = stat;
        if (activatesInterpreter) await validateTrustedCliExecutable(found);
        else if (!(
          interpreter &&
          approvedEntryScript !== undefined &&
          (await workspaceRealpath(found)) === approvedEntryScript.path
        ))
          await validateTrustedCliFileIntegrity(found);
        continue;
      }
      // A second file the same token names. It never activates an interpreter
      // on its own, but the command still opens it, so it answers to the
      // ordinary rule rather than riding in behind the first.
      await validateTrustedCliFileIntegrity(found);
    }
    if (candidate === undefined || entry === undefined) continue;
    if (activatesInterpreter) {
      interpreter = true;
      interpreterName = activatedInterpreterName;
      continue;
    }
    if (arg.slice(arg.lastIndexOf('/') + 1) === 'env') envWrapper = true;
    if (arg.slice(arg.lastIndexOf('/') + 1) === 'timeout') {
      timeoutWrapper = true;
      timeoutDurationSeen = false;
    }
    // An interpreter executes one script operand; later operands are its data.
    if (interpreter) {
      if (
        approvedEntryScript?.loading === 'dynamic' &&
        typeof approvedEntryScript.worktreeRoot === 'string' &&
        (await workspaceRealpath(candidate)) === approvedEntryScript.path
      )
        approvedDynamicScriptSeen = true;
      interpreter = false;
    }
  }
}

const TRUSTED_CLI_SECRET_DIR = '/run/verity-runner/secrets';

export function trustedCliSecretPath(name, options, correlationId) {
  if (!isSafeTrustedCliEnvName(name)) throw new Error('unsafe trusted CLI environment variable');
  const root = options?.secretDir ?? TRUSTED_CLI_SECRET_DIR;
  return correlationId === undefined ? `${root}/${name}` : `${root}/${correlationId}/${name}`;
}

export const TRUSTED_CLI_SECRET_LEAK_ERROR = 'trusted CLI secret file could not be removed';

export const SCRIPT_ISOLATION_UNAVAILABLE_ERROR =
  'trusted CLI entry-script isolation is unavailable in this Sandbox';
export const SCRIPT_SANDBOX_PROBE_TIMEOUT_MS = 10_000;

/**
 * Ask the helper whether this kernel will enforce its filesystem policy. It uses
 * Landlock on Linux hosts and a private user/mount namespace under gVisor. Exit 0
 * means a command it launches would be confined; anything else means it refuses
 * to launch one. The helper stays the enforcement point: a probe that wrongly
 * reported success would still end in the helper's own refusal.
 */
export async function probeScriptSandbox(
  helperPath = DEFAULT_SCRIPT_SANDBOX_PATH,
  timeoutMs = SCRIPT_SANDBOX_PROBE_TIMEOUT_MS,
  launchOptions,
) {
  return await new Promise((resolveProbe) => {
    let child;
    try {
      const spec =
        launchOptions === undefined
          ? { command: helperPath, args: ['--probe'], spawnOptions: {} }
          : trustedCliLaunchSpec(
              {
                kind: 'trusted-cli',
                command: helperPath,
                args: ['--probe'],
                cwd: '/',
                secrets: [],
              },
              launchOptions,
            );
      child = spawn(spec.command, spec.args, {
        ...spec.spawnOptions,
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: timeoutMs,
      });
    } catch {
      resolveProbe({ available: false, reason: 'script sandbox helper could not be started' });
      return;
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 512) stderr += chunk;
    });
    child.once('error', () =>
      resolveProbe({ available: false, reason: 'script sandbox helper could not be started' }),
    );
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveProbe({ available: true });
        return;
      }
      const line = stderr.split('\n', 1)[0].trim().slice(0, 256);
      resolveProbe({
        available: false,
        reason:
          line !== ''
            ? line
            : `script sandbox probe exited with ${signal === null ? `code ${String(code)}` : signal}`,
      });
    });
  });
}

// Never forward arbitrary exception text: it can contain argv or secret values.
const TRUSTED_CLI_VALIDATION_CODES = new Map([
  ['invalid trusted CLI spawn request', 'validation_invalid_request'],
  ['trusted CLI argv exceeds broker limit', 'validation_argv_too_large'],
  ['trusted CLI executable must be root-owned and immutable', 'validation_path_not_immutable'],
  ['trusted CLI command is not an executable file', 'validation_command_not_executable'],
  ['trusted CLI file operand must be a regular file', 'validation_operand_not_regular_file'],
  [
    'trusted CLI PATH entry must be an immutable directory',
    'validation_path_directory_not_immutable',
  ],
  [
    'isolated trusted CLI interpreter must be installed under /bin or /usr',
    'validation_isolated_interpreter_location',
  ],
  ['trusted CLI cwd escaped the worktree root', 'validation_cwd_outside_worktree'],
  ['invalid trusted CLI entry-script attestation', 'validation_invalid_entry_attestation'],
  ['trusted CLI entry script escaped the worktree root', 'validation_entry_outside_worktree'],
  ['trusted CLI entry script must be a regular file', 'validation_entry_not_regular_file'],
  ['trusted CLI entry script content hash changed after approval', 'validation_entry_hash_changed'],
  [
    'trusted CLI cwd and entry script must share one worktree root',
    'validation_entry_worktree_mismatch',
  ],
  [
    'trusted CLI entry script project path does not match its worktree',
    'validation_entry_project_path_mismatch',
  ],
  ['trusted CLI argv policy is invalid', 'validation_invalid_argv_policy'],
  ['trusted CLI argv is not allowed by executable policy', 'validation_argv_policy_denied'],
  [
    'trusted CLI interpreter module execution is not immutable',
    'validation_interpreter_module_mutable',
  ],
  [
    'trusted CLI interpreter option execution is not immutable',
    'validation_interpreter_option_mutable',
  ],
  ['trusted CLI env option execution is not immutable', 'validation_env_option_mutable'],
  [
    'trusted CLI code-loading environment is not immutable',
    'validation_code_loading_environment_mutable',
  ],
  ['trusted CLI interpreter operand does not exist', 'validation_interpreter_operand_missing'],
  [SCRIPT_ISOLATION_UNAVAILABLE_ERROR, 'validation_script_isolation_unavailable'],
]);

export function trustedCliFailureCode(phase, error) {
  if (phase === 'validation') {
    const rule = TRUSTED_CLI_VALIDATION_CODES.get(error instanceof Error ? error.message : '');
    if (rule !== undefined) return rule;
    // Filesystem exceptions carry paths in their messages; expose only the errno class.
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'validation_path_missing';
    if (code === 'EACCES' || code === 'EPERM') return 'validation_path_permissions';
    if (code === 'ELOOP') return 'validation_path_symlink_loop';
    return 'validation_failed';
  }
  if (phase !== 'materialization') return `${phase.replace('-', '_')}_failed`;
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'EEXIST') return 'materialization_secret_file_exists';
  if (code === 'EACCES' || code === 'EPERM') return 'materialization_path_permissions';
  if (code === 'ENOENT') return 'materialization_path_missing';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'materialization_storage_full';
  if (code === 'EROFS') return 'materialization_read_only';
  return 'materialization_failed';
}

/**
 * Pick which failure the caller hears about when a run fails and its secret file
 * survived. The leak wins: the run is lost either way, but only this outcome
 * needs a credential rotated, and a spawn error scrolling past says nothing
 * about that. The original message rides along so diagnosis still has it, and
 * `stage` says which step dropped the run so the two cases stay tellable apart.
 */
export function leakOutranks(contained, error, stage = 'spawn failed') {
  if (contained !== false) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${TRUSTED_CLI_SECRET_LEAK_ERROR} after ${stage}: ${detail}`);
}

/**
 * Put one file-injected secret out of the agent's reach, and report whether that
 * succeeded. Unlinking is the normal route; the rest of this exists for when it
 * fails, because the file is agent-owned 0600 at a path the agent knows, so a
 * leftover is a live credential any later sandbox process can read.
 *
 * The broker holds CAP_CHOWN but no CAP_DAC_OVERRIDE, so against an agent-owned
 * 0600 file it is judged by the "other" bits and cannot even open it — but it
 * can take ownership back, and ownership is exactly what the agent has to lose.
 * Once the file is root-owned at 0600 the agent falls into "other" and is shut
 * out, which makes the bytes reachable again for the broker to truncate away and
 * unlink. Any of those steps landing is containment; only a failed chown leaves
 * the secret readable, and that is the one case this reports as uncontained.
 */
async function containTrustedCliSecretFile(path) {
  const removed = await rm(path, { force: true }).then(
    () => true,
    () => false,
  );
  if (removed) return true;
  const reclaimed = await chown(path, 0, 0).then(
    () => true,
    () => false,
  );
  if (!reclaimed) return false;
  await truncate(path, 0).catch(() => undefined);
  await rm(path, { force: true }).catch(() => undefined);
  return true;
}

export async function removeLegacyTrustedCliSecretFiles(options) {
  const root = options?.secretDir ?? TRUSTED_CLI_SECRET_DIR;
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    // Current calls own one directory per correlation ID. Only non-directories
    // can belong to the old flat layout, and its names were restricted to the
    // same environment-variable grammar.
    if (entry.isDirectory() || !isSafeTrustedCliEnvName(entry.name)) continue;
    const contained = await containTrustedCliSecretFile(`${root}/${entry.name}`);
    if (!contained) throw new Error(TRUSTED_CLI_SECRET_LEAK_ERROR);
  }
}

/**
 * Write every file-injected secret where the command can read it, and hand back
 * their removal. The directory stays root-owned at 0711 so the broker — which holds
 * no CAP_DAC_OVERRIDE — can still delete inside it, while each file is 0600 and
 * agent-owned.
 *
 * A failure part-way through still removes what was already written. Otherwise a
 * request that dies on its third secret leaves the first two behind, and the
 * `wx` guard below turns that leftover into a spurious refusal of the next run.
 */
export async function materializeTrustedCliSecrets(request, options) {
  const fileSecrets = request.secrets.filter((secret) => secret.injection === 'file');
  if (fileSecrets.length === 0) return { cleanup: async () => true };
  const { uid, gid } = validateIdentity(options);
  const written = [];
  const invocationDir =
    request.correlationId === undefined
      ? undefined
      : `${options?.secretDir ?? TRUSTED_CLI_SECRET_DIR}/${request.correlationId}`;
  // Resolves to false rather than rejecting when a secret is still readable by
  // the agent. The child-exit path has no rejection handler on it, and an
  // unhandled rejection there takes the whole broker down — with it the socket
  // of every concurrent turn in the container. The caller turns false into a
  // failed run instead, so the credential gets rotated rather than logged.
  const contain = async () => {
    const contained = await Promise.all(
      written.map(async (path) => {
        if (await containTrustedCliSecretFile(path)) return true;
        process.stderr.write(`verity-agent-spawn-broker: leaked trusted CLI secret file ${path}\n`);
        return false;
      }),
    );
    const fullyContained = contained.every(Boolean);
    if (fullyContained && invocationDir !== undefined) {
      await rm(invocationDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return fullyContained;
  };
  // A child that never starts emits `error` and then `close`, so the spawn-error
  // path and the child-exit path both reach this, concurrently, over the same
  // files. Run the containment once and hand every caller that one promise. Two
  // passes would race on the same unlink and could report opposite verdicts for
  // the same file — whichever lost the race seeing an ENOENT it did not cause —
  // and only one of those two answers would reach the caller.
  let running;
  const cleanup = () => (running ??= contain());
  try {
    // Correlated calls chmod only their own child directory. An existing 0700
    // root still blocks the approved CLI from traversing to its 0600 file.
    const root = options?.secretDir ?? TRUSTED_CLI_SECRET_DIR;
    await mkdir(root, { recursive: true, mode: 0o711 });
    await chmod(root, 0o711);
    for (const secret of fileSecrets) {
      const path = trustedCliSecretPath(secret.name, options, request.correlationId);
      const dir = path.slice(0, path.lastIndexOf('/'));
      await mkdir(dir, { recursive: true, mode: 0o711 });
      await chmod(dir, 0o711);
      // `wx` fails closed on an existing file: a leftover from a killed run, or
      // one planted by the agent, must never be handed to a command as though
      // Verity had just written it.
      const bytes =
        secret.encoding === 'base64' ? Buffer.from(secret.value, 'base64') : secret.value;
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      written.push(path);
      await chown(path, uid, gid);
    }
  } catch (error) {
    // A part-way failure has the same stakes as a failed spawn: if an already
    // written secret cannot be taken back, the caller has to hear that it needs
    // rotating, not just that materialization died on a later file.
    throw leakOutranks(await cleanup(), error, 'materialization failed');
  }
  return { cleanup };
}

/**
 * Snapshot the approved worktree bytes into a broker-owned file. Hashing the
 * worktree path and then letting the interpreter reopen it would leave a TOCTOU
 * window in which the agent could replace the script after verification.
 */
export async function materializeTrustedCliEntryScript(request, options) {
  if (request.entryScript === undefined) {
    return { args: request.args, cleanup: async () => true };
  }
  const bytes = await agentWorkspaceRead('readEntry', request.entryScript.path, options);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== request.entryScript.sha256) {
    throw new Error('trusted CLI entry script content hash changed after approval');
  }
  const base = resolve(
    options.trustedCliEntryScriptDir ??
      join(options.secretDir ?? TRUSTED_CLI_SECRET_DIR, '..', 'entry-scripts'),
  );
  await mkdir(base, { recursive: true, mode: 0o711 });
  await chmod(base, 0o711);
  const directory = await mkdtemp(join(base, `${digest.slice(0, 16)}-`));
  try {
    await chmod(directory, 0o711);
    const snapshotRoot = join(directory, 'root');
    const relativeScript = request.entryScript.path.slice(
      request.entryScript.worktreeRoot.length + 1,
    );
    const snapshot = join(snapshotRoot, relativeScript);
    const snapshotScriptDir = snapshot.slice(0, snapshot.lastIndexOf('/'));
    // The broker starts with umask 0077. mkdir's mode alone leaves root-owned
    // snapshot directories at 0700, hiding the approved entry after setpriv.
    const makeSnapshotDirectory = async (path) => {
      await mkdir(snapshotRoot, { mode: 0o755 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await chmod(snapshotRoot, 0o755);
      let current = snapshotRoot;
      for (const component of path
        .slice(snapshotRoot.length + 1)
        .split('/')
        .filter(Boolean)) {
        current = join(current, component);
        await mkdir(current, { mode: 0o755 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        await chmod(current, 0o755);
      }
    };
    await makeSnapshotDirectory(snapshotScriptDir);
    const relativeCwd = request.cwd.slice(request.entryScript.worktreeRoot.length + 1);
    const snapshotCwd = join(snapshotRoot, relativeCwd);
    if (request.entryScript.loading === 'isolated') {
      await makeSnapshotDirectory(snapshotCwd);
    }
    await writeFile(snapshot, bytes, { mode: 0o444, flag: 'wx' });
    await chmod(snapshot, 0o444);
    if (request.entryScript.loading === 'dynamic') {
      // Recreate the path from worktree root to the entry script. At every level,
      // siblings link back to the live worktree while the path component leading
      // to the entry remains a real snapshot directory. This preserves `../lib`,
      // project-root package lookup, and arbitrarily nested relative resources for
      // the explicitly one-time dynamic mode without replacing the approved entry
      // bytes themselves.
      const components = relativeScript.split('/');
      let sourceDir = request.entryScript.worktreeRoot;
      let targetDir = snapshotRoot;
      for (const component of components) {
        for (const entry of await agentWorkspaceRead('readdir', sourceDir, options)) {
          if (entry === component) continue;
          await symlink(join(sourceDir, entry), join(targetDir, entry));
        }
        sourceDir = join(sourceDir, component);
        targetDir = join(targetDir, component);
      }
    }
    const cleanup = async () => {
      try {
        await rm(directory, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    };
    return {
      args: [snapshot, ...request.args.slice(1)],
      entrySandbox: {
        root: snapshotRoot,
        cwd: request.entryScript.loading === 'isolated' ? snapshotCwd : request.cwd,
        loading: request.entryScript.loading,
        ...(request.entryScript.loading === 'dynamic'
          ? { dynamicRoot: request.entryScript.worktreeRoot }
          : {}),
      },
      cleanup,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function trustedCliLaunchSpec(request, options) {
  const { uid, gid } = validateIdentity(options);
  for (const secret of request.secrets) {
    if (!isSafeTrustedCliEnvName(secret.name)) {
      throw new Error('unsafe trusted CLI environment variable');
    }
  }
  if (new Set(request.secrets.map((secret) => secret.name)).size !== request.secrets.length) {
    throw new Error('duplicate trusted CLI environment variable');
  }
  const setprivPath = options.setprivPath ?? '/usr/bin/setpriv';
  const command =
    request.entrySandbox === undefined
      ? [request.command, ...request.args]
      : [
          options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH,
          '--root',
          request.entrySandbox.root,
          '--cwd',
          request.entrySandbox.cwd,
          '--loading',
          request.entrySandbox.loading,
          ...(request.entrySandbox.loading === 'dynamic'
            ? ['--dynamic-root', request.entrySandbox.dynamicRoot]
            : []),
          ...request.secrets.flatMap((secret) =>
            secret.injection === 'file'
              ? ['--secret', trustedCliSecretPath(secret.name, options, request.correlationId)]
              : [],
          ),
          '--',
          request.command,
          ...request.args,
        ];
  return {
    command: setprivPath,
    args: [
      `--reuid=${String(uid)}`,
      `--regid=${String(gid)}`,
      // The same boundary as `agentLaunchSpec`, from the same list, for the same
      // reason: a trusted CLI is reached THROUGH an agent turn — so it gets the
      // ADR 0006 Amendment 1 Docker grant too. Withholding it here would buy nothing (the
      // agent can already run `docker` directly) while making the two argv
      // prefixes differ, which is precisely the drift the shared list prevents.
      ...privilegeDropFlags(options.dockerGid, options.runnerGid),
      ...command,
    ],
    spawnOptions: {
      cwd: request.cwd,
      env: {
        PATH: options.env?.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: options.env?.VERITY_AGENT_HOME ?? '/home/dev',
        USER: options.env?.VERITY_AGENT_USER ?? 'dev',
        LOGNAME: options.env?.VERITY_AGENT_USER ?? 'dev',
        LANG: options.env?.LANG ?? 'C.UTF-8',
        // Last, so a secret can never overwrite the fixed launch environment —
        // isSafeTrustedCliEnvName already rejects those names, and this keeps the
        // two defences from depending on each other.
        ...Object.fromEntries(
          request.secrets.map((secret) => [
            secret.name,
            secret.injection === 'file'
              ? trustedCliSecretPath(secret.name, options, request.correlationId)
              : secret.value,
          ]),
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  };
}

/**
 * SIGTERM → SIGKILL grace for a subtree that escaped the agent's process group. Kept
 * in step with `PROCESS_TREE_KILL_GRACE_MS` in `packages/session/src/process-tree.ts`,
 * which is the same walk for the same reason — duplicated rather than imported because
 * this broker is standalone ESM installed into the sandbox image and cannot resolve the
 * workspace. Change one, change the other.
 */
export const PROCESS_TREE_KILL_GRACE_MS = 1_000;

/** Best-effort `/proc` read; the injected form is what makes the walk testable. */
export const readProcFile = (path) => readFileSync(path, 'utf8');

/**
 * Fields of `/proc/<pid>/stat` AFTER `comm`, which may itself contain spaces and
 * parentheses — hence the split starting at the LAST `)`. Index 2 is field 5 (`pgrp`),
 * index 19 is field 22 (`starttime`, the fence against pid reuse).
 */
export function statFields(pid, readProc) {
  const stat = readProc(`/proc/${pid}/stat`);
  const end = stat.lastIndexOf(')');
  // No `comm` terminator at all means the line is truncated or not a `stat` line.
  // Slicing from 1 anyway would produce a plausible-looking but misaligned field list,
  // and a bogus non-empty `starttime` is worse than none: it defeats the fence quietly
  // in both directions.
  if (end < 0) return [];
  // Trim rather than assume the single space real `/proc` puts after `comm`: a slice
  // one character off would shift EVERY index, reading `ppid` as `pgrp` and `utime` as
  // `starttime` — plausible numbers instead of nothing.
  return stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
}

export function processStartTime(pid, readProc) {
  return statFields(pid, readProc)[19] ?? '';
}
