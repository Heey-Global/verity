import { spawn } from 'node:child_process';
import {
  probeMemoryGuard,
  readMemoryCeiling,
  runsUnderGvisor,
} from '../../bin/verity-memory-guard.mjs';
import { stopTaggedManagedPids } from '../../bin/verity-managed-secret-servers.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { URL } from 'node:url';
import { trustedCliSecretPath, validateTrustedCliArguments } from './launch.mjs';

/** Read-only health, using only root-selected paths; requests cannot select files or commands. */
export async function runnerStackHealth(options = {}) {
  const env = options.env ?? process.env;
  const controlDir = options.controlDir ?? DEFAULT_CONTROL_DIR;
  const read = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  let memoryGuard = true;
  try {
    if (env.VERITY_MEMORY_GUARD !== '0' && runsUnderGvisor(read) && readMemoryCeiling(read))
      memoryGuard = probeMemoryGuard(controlDir, read);
  } catch {
    memoryGuard = false;
  }
  let connector = true;
  if (env.VERITY_CLAUDE_CONNECTOR_PORT) {
    try {
      const port = Number(env.VERITY_CLAUDE_CONNECTOR_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
      const record = read(join(controlDir, 'egress-connector.pid')).trim().split(/\s+/u);
      const [pid, startTime, fingerprint] = record;
      if (!/^[1-9][0-9]*$/u.test(pid ?? '') || !startTime) throw new Error('missing identity');
      const stat = read(`/proc/${pid}/stat`);
      if (
        stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/u)[19] !== startTime ||
        !read(`/proc/${pid}/cmdline`).includes('/usr/local/bin/verity-egress-connector')
      )
        throw new Error('stale identity');
      // Match the launcher's fingerprint without spawning sha256sum or reading secrets into a response.
      const hash = createHash('sha256');
      for (const name of [
        'VERITY_CLAUDE_EGRESS_URL',
        'VERITY_CLAUDE_EGRESS_AUTHORITY',
        'VERITY_CLAUDE_EGRESS_SERVERNAME',
        'VERITY_CODEX_EGRESS_URL',
        'VERITY_CODEX_EGRESS_AUTHORITY',
      ])
        hash.update(`${env[name] ?? ''}\0`);
      for (const name of [
        'VERITY_CLAUDE_EGRESS_CA',
        'VERITY_CLAUDE_EGRESS_CERT',
        'VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE',
      ]) {
        const path = env[name];
        if (!path || !isAbsolute(path)) throw new Error('missing configuration');
        hash.update(`${createHash('sha256').update(read(path)).digest('hex')}  ${path}\n`);
      }
      if (fingerprint !== hash.digest('hex')) throw new Error('configuration changed');
      const response = await (options.fetch ?? globalThis.fetch)(
        `http://127.0.0.1:${port}/__verity/ready`,
        {
          signal: globalThis.AbortSignal.timeout(1_000),
          redirect: 'error',
        },
      );
      connector = response.ok && (await response.text()).includes('"ready":true');
    } catch {
      connector = false;
    }
  }
  return {
    ok: true,
    stackHealthVersion: 1,
    healthy: memoryGuard && connector,
    memoryGuard,
    connector,
  };
}

/**
 * Whether the hops an agent turn depends on accept connections yet, seen from
 * inside the Sandbox: the local egress connector, and the relay listeners behind
 * it for Claude, Codex and the broker (which also carries the `verity` MCP
 * gateway). A relay container is reported running by Docker before its process
 * listens, so a turn admitted in that window fails with a refused connection.
 *
 * Only TCP connects, closed at once: no request, no TLS handshake and no model
 * call leaves the Sandbox, so the probe is safe to repeat while the relay starts.
 * Read-only; targets come from this container's own environment, never from the
 * request.
 */
export async function runnerEgressReadiness(options = {}) {
  const env = options.env ?? process.env;
  const connect = options.connect ?? probeTcp;
  const fetchReady = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 1_000;
  const hop = async (value) => {
    if (!value) return 'not_configured';
    let url;
    try {
      url = new URL(value);
    } catch {
      return 'invalid';
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid';
    // A URL keeps an IPv6 literal bracketed; a socket connect wants it bare.
    return await connect(url.hostname.replace(/^\[(.*)\]$/u, '$1'), port, timeoutMs);
  };
  const connector = async () => {
    const port = Number(env.VERITY_CLAUDE_CONNECTOR_PORT);
    if (!env.VERITY_CLAUDE_CONNECTOR_PORT) return 'not_configured';
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid';
    try {
      const response = await fetchReady(`http://127.0.0.1:${port}/__verity/ready`, {
        signal: globalThis.AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) return 'unreachable';
      const body = JSON.parse(await response.text());
      return body !== null && typeof body === 'object' && body.ready === true
        ? 'ready'
        : 'unreachable';
    } catch (error) {
      return tcpFailure(error);
    }
  };
  const [local, claude, codex, broker] = await Promise.all([
    connector(),
    hop(env.VERITY_CLAUDE_EGRESS_URL),
    hop(env.VERITY_CODEX_EGRESS_URL),
    hop(env.VERITY_MCP_GATEWAY_URL),
  ]);
  return {
    ok: true,
    egressReadinessVersion: 1,
    connector: local,
    claude,
    codex,
    broker,
  };
}

function tcpFailure(error) {
  const codes = [];
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string') codes.push(current.code);
    if (Array.isArray(current.errors))
      for (const nested of current.errors)
        if (typeof nested?.code === 'string') codes.push(nested.code);
    current = current.cause;
  }
  if (codes.includes('ECONNREFUSED')) return 'refused';
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) return 'unresolved';
  if (codes.includes('ETIMEDOUT') || error?.name === 'TimeoutError' || error?.name === 'AbortError')
    return 'timeout';
  return 'unreachable';
}

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(state);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('ready'));
    socket.once('error', (error) => finish(tcpFailure(error)));
  });
}

export const AGENT_SPAWN_PROTOCOL_VERSION = 1;
/**
 * Where `opencode acp` keeps everything that is not its config: session storage
 * and logs (`$XDG_DATA_HOME/opencode`), lock files (`$XDG_STATE_HOME/opencode`),
 * and its downloaded helper binaries (`$XDG_CACHE_HOME/opencode`).
 *
 * Named here because the fallback for all three is `$HOME`, and `$HOME` is the one
 * thing this broker cannot make true: it pins `/home/dev`, which exists on the
 * Verity base image and generally does NOT on a project's own devcontainer image
 * (`provisioner.ts`, `pathMode`). Measured against opencode 1.18.21, that is not a
 * degraded start — the process creates these directories eagerly and dies at spawn
 * with `EACCES: permission denied, mkdir '/home/dev'` before answering
 * `initialize`, so every OpenCode turn on such an image would fail. With the three
 * variables set it starts cleanly under a `$HOME` it cannot write at all.
 *
 * Container-local on purpose, and NOT under {@link DEFAULT_RUNTIME_DIR}: that
 * runtime is a host directory outliving the container, so putting OpenCode's
 * session storage there would leave conversations behind after a session or
 * project is deleted — `session-artifacts.ts` returns nothing for `opencode`
 * precisely because this storage dies with the container. This directory is created
 * and handed to the agent by `verity-runner-stack-start`, the same root pass that
 * prepares Claude's and Codex's directories. Only this leaf is chowned — the
 * `/run/verity` parent comes into being as a side effect of `mkdir -p` and stays
 * root-owned, which is correct: nothing writes into the parent itself, and the
 * agent's three subdirectories are created under a leaf it owns.
 */
export const OPENCODE_STATE_DIR = '/run/verity/opencode';
export const DEFAULT_RUNTIME_DIR = '/run/verity-runner';
export const DEFAULT_CONTROL_DIR = '/run/verity-runner-broker';
export const DEFAULT_WORKTREE_ROOT = '/work';
export const DEFAULT_SCRIPT_SANDBOX_PATH = '/usr/local/bin/verity-script-sandbox';
/**
 * The ONE additional namespace a Runner may be told about, and it is a literal
 * here rather than anything a caller can name.
 *
 * A project Sandbox has a single tree: its clone at `/work`, session worktrees
 * inside it at `/work/.verity-sessions/<id>`. The control-plane Runner has two,
 * because the Server puts control-plane session worktrees somewhere else
 * entirely — under `workspacesDir` (`/srv/verity/sessions`), NOT under the
 * `verity-control` clone — and `runnerSandboxPath` deliberately leaves such
 * shared-namespace paths unrewritten (packages/server/src/embedded.ts). That is
 * why the Runner container mounts `verity-data:sessions` at this exact path
 * beside its `/work`. The broker was written for the one-tree Sandbox and never
 * learned about the second mount, so every control-plane turn arrived with a cwd
 * that existed, resolved, and sat outside `/work` — "escaped".
 *
 * Kept as a fixed constant, enabled by a boolean env flag, rather than a
 * configurable path list: a deployment may turn this root ON where the mount
 * exists, and can never point the guard at some other directory. The guard's
 * granularity is unchanged — it still confines an agent to a mounted tree, not
 * to its own session — because the only party that could supply a narrower root
 * is the Runner, which is exactly the party this guard does not trust.
 */
export const SHARED_SESSION_ROOT = '/srv/verity/sessions';
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_ARGS_BYTES = 2 * 1024 * 1024;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/**
 * The `command` values a spawn request may name. Deliberately a closed set held
 * separately from the path map in {@link agentLaunchSpec}: this one bounds what the
 * request parser will accept, that one decides what each accepted name execs, and
 * an entry missing from either is a refusal rather than a fallback. Keep both in
 * step with the profiles' `defaultCommand` in packages/session/src/acp-*-backend.ts.
 */
const SPAWNABLE_AGENT_COMMANDS = new Set(['claude-agent-acp', 'codex-acp', 'opencode-acp']);
/**
 * The turn's badge: 32 random bytes as unpadded base64url, minted per turn by the
 * Server. In-Sandbox helpers present it as VERITY_TURN_CAPABILITY so a Server
 * route can tell which turn, and so whose turn, is calling. It travels as its own
 * request field rather than in `sessionEnv`, whose key list older brokers enforce.
 */
const TURN_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The person a turn's commits are authored by (see packages/session/src/git-author.ts,
 * which this mirrors). It travels as its own request field: older peers enforce
 * the `sessionEnv` key list but ignore unknown fields. Angle brackets and control
 * characters could forge a second identity line in a commit header.
 */
/** `commit.gpgsign=false` appended to the GIT_CONFIG_COUNT pairs (see git-author.ts). */
function unsignedCommitsConfig(source) {
  const raw = source.GIT_CONFIG_COUNT;
  const count = raw !== undefined && /^\d{1,3}$/u.test(raw) ? Number(raw) : 0;
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'commit.gpgsign',
    [`GIT_CONFIG_VALUE_${count}`]: 'false',
  };
}

function isGitAuthor(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { name, email } = value;
  return (
    Object.keys(value).length === 2 &&
    typeof name === 'string' &&
    typeof email === 'string' &&
    name.trim().length > 0 &&
    Buffer.byteLength(name) <= 200 &&
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    /^[^\u0000-\u001f\u007f<>]+$/u.test(name) &&
    Buffer.byteLength(email) <= 320 &&
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    /^[^\s\u0000-\u001f\u007f<>@]+@[^\s\u0000-\u001f\u007f<>@]+$/u.test(email)
  );
}
/**
 * Verity's own per-turn runtime context — the only environment a spawn request
 * may contribute. Everything else in the child's environment is derived from THIS
 * process (see {@link childEnvironment}), so the caller cannot reach past this
 * list. Mirrors SESSION_RUNTIME_ENV_KEYS in packages/session/src/broker-spawner.ts
 * and the runner worker's independent check in runner-worker-entry.ts.
 *
 * These two values are non-secret routing context: which backend and model this
 * turn runs on, so an in-Sandbox helper such as `verity-code-review` starts its
 * isolated reviewer on the same one instead of guessing from the environment.
 */
const SESSION_RUNTIME_ENV_KEYS = [
  'VERITY_SESSION_BACKEND',
  'VERITY_SESSION_MODEL',
  'VERITY_SESSION_ID',
];
const MAX_SESSION_ENV_VALUE_BYTES = 256;
/**
 * Every neighbouring bound here is a size cap, but a value bound for a child's
 * environment also has a shape.
 *
 * The two keys are held to different shapes on purpose. A backend name steers
 * control flow in the in-Sandbox helpers that read it — `verity-code-review`
 * branches on it to pick a reviewer — so it is held to a bare identifier.
 * A model id is inert routing text whose spelling belongs to the provider, so it
 * is only required to be free of control characters: a NUL or newline in one is
 * never legitimate and has no business reaching `spawn`, but an unforeseen id
 * spelling should not fail the whole turn.
 */
const SESSION_ENV_VALUE_SHAPES = {
  // Without the `m` flag `$` is end-of-input in JS, so a trailing newline fails
  // this on its own rather than relying on the control-character check above.
  VERITY_SESSION_BACKEND: /^[a-z0-9][a-z0-9._-]*$/u,
  // A model id is opaque and may legitimately contain spaces or punctuation, so
  // it is only length- and control-character-checked. Consumers must quote it:
  // it is an environment value, never a fragment of a command line.
  VERITY_SESSION_MODEL: undefined,
  VERITY_SESSION_ID: undefined,
};
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
// Mirrors MAX_TRUSTED_CLI_SECRETS in packages/secret-contracts/src/tool.ts. The
// broker re-derives every bound rather than trusting the supervisor that sent it.
const MAX_TRUSTED_CLI_SECRETS = 8;

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decode(data) {
  return Buffer.from(data, 'base64');
}

export function isLocalConnectorUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port !== '' &&
      Number.isSafeInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      value === url.origin
    );
  } catch {
    return false;
  }
}

export function send(socket, value) {
  if (socket.destroyed) return false;
  return socket.write(`${JSON.stringify(value)}\n`);
}

export async function acquireLock(path) {
  const handle = await open(path, 'a+', 0o600);
  const code = await new Promise((resolveCode, rejectCode) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    child.once('error', rejectCode);
    child.once('close', resolveCode);
  }).catch(async (error) => {
    await handle.close();
    throw error;
  });
  if (code !== 0) {
    await handle.close();
    throw new Error('agent spawn broker is already claimed');
  }
  await chmod(path, 0o600);
  return handle;
}

export function validateIdentity(options) {
  const uid = Number(options.agentUid);
  const gid = Number(options.agentGid);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error('agent spawn broker requires non-root agent uid/gid');
  }
  return { uid, gid };
}

// Keep workspace reads under the same identity as the eventual interpreter.
// Dropping the broker itself would race concurrent requests and remove its ability
// to create immutable snapshots in the protected runtime directory.
const AGENT_FILE_READER = `
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const { operation, path } = JSON.parse(input);
    let value;
    if (operation === 'managedStop') {
      const { stopTaggedManagedPids } = await import('/usr/local/bin/verity-managed-secret-servers.mjs');
      const [id, signal] = path.split(':');
      value = await stopTaggedManagedPids(id, signal);
    } else if (operation === 'realpath' || operation === 'readdir') value = await fs[operation](path);
    else if (operation === 'lstat') {
      const stat = await fs.lstat(path);
      value = { uid: stat.uid, mode: stat.mode, size: stat.size,
        file: stat.isFile(), directory: stat.isDirectory(), socket: stat.isSocket() };
    } else if (operation === 'readEntry') {
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('trusted CLI entry script must be a regular file');
        value = (await handle.readFile()).toString('base64');
      } finally { await handle.close(); }
    } else throw new Error('invalid workspace read operation');
    process.stdout.write(JSON.stringify({ value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: { code: error.code,
      message: error.code ? 'workspace read failed' : error.message } }));
  }
});
`;

export async function agentWorkspaceRead(operation, path, options) {
  // Non-root broker fixtures deliberately use synthetic agent identities.
  const { uid, gid } =
    options.enforceRoot === false
      ? { uid: process.getuid?.(), gid: process.getgid?.() }
      : validateIdentity(options);
  let value;
  if (options.enforceRoot === false || (process.getuid?.() === uid && process.getgid?.() === gid)) {
    if (operation === 'managedStop') {
      const [id, signal] = path.split(':');
      return await stopTaggedManagedPids(id, signal);
    }
    if (operation === 'readEntry') {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile())
          throw new Error('trusted CLI entry script must be a regular file');
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    }
    if (operation === 'realpath') return await realpath(path);
    if (operation === 'readdir') return await readdir(path);
    return await lstat(path);
  }
  const response = await new Promise((resolveResponse, reject) => {
    const child = spawn(
      options.setprivPath ?? '/usr/bin/setpriv',
      [
        `--reuid=${uid}`,
        `--regid=${gid}`,
        ...PRIVILEGE_DROP_FLAGS,
        process.execPath,
        '--input-type=commonjs',
        '-e',
        AGENT_FILE_READER,
      ],
      { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('workspace reader timed out'));
    }, 10000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('workspace reader failed'));
      try {
        resolveResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid workspace reader response'));
      }
    });
    child.stdin.end(JSON.stringify({ operation, path }));
  });
  if (response.error) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    throw error;
  }
  value = response.value;
  // A process running as the agent cannot supply path components for privileged
  // snapshot writes. Validate the transport even though the reader is fixed code.
  if (
    operation === 'readdir' &&
    (!Array.isArray(value) ||
      value.some(
        (name) =>
          typeof name !== 'string' ||
          name === '' ||
          name === '.' ||
          name === '..' ||
          name.includes('/') ||
          name.includes('\0'),
      ))
  ) {
    throw new Error('invalid workspace directory response');
  }
  if (
    operation === 'realpath' &&
    (typeof value !== 'string' ||
      !value.startsWith('/') ||
      value.includes('\0') ||
      resolve(value) !== value)
  ) {
    throw new Error('invalid workspace path response');
  }
  if (operation === 'readEntry') {
    if (typeof value !== 'string') throw new Error('invalid workspace entry response');
    return Buffer.from(value, 'base64');
  }
  if (operation === 'lstat')
    return {
      ...value,
      isFile: () => value.file,
      isDirectory: () => value.directory,
      isSocket: () => value.socket,
    };
  return value;
}

export function isSafeTrustedCliEnvName(name) {
  return (
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) &&
    !/^(?:LD_|MALLOC_)/u.test(name) &&
    !new Set([
      'GCONV_PATH',
      'GETCONF_DIR',
      'GLIBC_TUNABLES',
      'HOME',
      'HOSTALIASES',
      'LANG',
      'LOGNAME',
      'LOCALDOMAIN',
      'LOCPATH',
      'NLSPATH',
      'PATH',
      'RES_OPTIONS',
      'TMPDIR',
      'TZDIR',
      'USER',
    ]).has(name)
  );
}

/**
 * Every segment root-owned and writable by nobody else, so no path the agent can
 * reach decides what the run reads.
 *
 * `endpoint` waives the write bits of the LAST segment alone, and callers set it
 * only for a socket. Write permission on a socket is what connect(2) checks, so
 * a socket the trusted CLI can reach at all is necessarily group- or
 * other-writable — holding it to the file rule refuses every socket that works.
 * It grants nothing the rule protects against: the node's contents cannot be
 * rewritten through it, and replacing the node needs write permission on the
 * directory above, which still answers to the full rule.
 */
export async function validateImmutablePath(path, endpoint = false) {
  const segments = path.split('/').filter(Boolean);
  let current = '/';
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const entry = await lstat(current);
    const connectable = endpoint && index === segments.length - 1 && entry.isSocket();
    if (
      entry.uid !== 0 ||
      (!entry.isSymbolicLink() && !connectable && (entry.mode & 0o022) !== 0)
    ) {
      throw new Error('trusted CLI executable must be root-owned and immutable');
    }
  }
}

export async function validateTrustedCliExecutable(command) {
  const resolved = await realpath(command);
  await validateImmutablePath(command);
  if (resolved !== command) await validateImmutablePath(resolved);
  const executable = await lstat(resolved);
  if (!executable.isFile() || (executable.mode & 0o111) === 0) {
    throw new Error('trusted CLI command is not an executable file');
  }
}

/**
 * What the integrity rule asks of an operand is that the bytes behind the name
 * cannot change between the approval and the run. A regular file answers that by
 * being root-owned and unwritable.
 *
 * A Unix socket answers it differently: it holds no bytes at all. What sits
 * behind the name is a live peer, and which peer that is was decided when the
 * node was bound — by root, since only root can create an entry in a directory
 * the rule already requires to be root-owned and unwritable. So a socket is held
 * to WHOSE it is, not to a content check it has nothing to answer with. Refusing
 * it for its node type is what put `example-cli --socket=/…/example-daemon.sock` out of
 * reach, along with every other CLI whose flag names a daemon endpoint.
 */
export async function validateTrustedCliFileIntegrity(path) {
  const resolved = await realpath(path);
  const entry = await lstat(resolved);
  const endpoint = entry.isSocket();
  await validateImmutablePath(path, endpoint);
  if (resolved !== path) await validateImmutablePath(resolved, endpoint);
  if (!entry.isFile() && !endpoint) {
    throw new Error('trusted CLI file operand must be a regular file');
  }
}

export async function validateTrustedCliExecutableDirectory(path) {
  const resolved = await realpath(path);
  await validateImmutablePath(path);
  if (resolved !== path) await validateImmutablePath(resolved);
  const entry = await lstat(resolved);
  if (!entry.isDirectory()) {
    throw new Error('trusted CLI PATH entry must be an immutable directory');
  }
}

/**
 * Every tree this broker's container was given, canonicalized.
 *
 * `realpath` on BOTH sides is what makes the containment check mean what it
 * says: a cwd that only looks contained (a symlink out of the tree) resolves to
 * where it actually leads before it is compared.
 */
export async function resolveAgentWorktreeRoots(options = {}) {
  const configured = [resolve(options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT)];
  if (options.sharedSessionRoot !== undefined) configured.push(resolve(options.sharedSessionRoot));
  return await Promise.all(configured.map(async (root) => await realpath(root)));
}

/** Containment against a canonicalized root set: at a root, or below one. */
export function withinAgentWorktreeRoots(cwd, roots) {
  return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

/**
 * Refuse an unusable shared root at STARTUP rather than per turn. A missing or
 * substituted mount would otherwise surface as `ENOENT` on every spawn, long
 * after the provisioning mistake that caused it — and a broker that cannot
 * honour its configured roots must not serve turns against the remaining one.
 */
export async function validateSharedSessionRoot(options) {
  if (options.sharedSessionRoot === undefined) return;
  const configured = resolve(options.sharedSessionRoot);
  if (configured === '/') throw new Error('shared session root must not be the filesystem root');
  const resolved = await realpath(configured).catch(() => undefined);
  if (resolved === undefined || resolved === '/' || !(await lstat(resolved)).isDirectory()) {
    throw new Error(`shared session root is not a mounted directory: ${configured}`);
  }
}

export async function validateSpawnRequest(raw, options) {
  if (
    isObject(raw) &&
    raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION &&
    raw.kind === 'spawn-trusted-cli'
  ) {
    if (
      typeof raw.command !== 'string' ||
      !raw.command.startsWith('/') ||
      !Array.isArray(raw.args) ||
      raw.args.length > 255 ||
      raw.args.some((arg) => typeof arg !== 'string') ||
      typeof raw.cwd !== 'string' ||
      (raw.correlationId !== undefined && !SAFE_CORRELATION_ID.test(raw.correlationId)) ||
      !Array.isArray(raw.secrets) ||
      raw.secrets.length === 0 ||
      raw.secrets.length > MAX_TRUSTED_CLI_SECRETS ||
      !raw.secrets.every(
        (secret) =>
          isObject(secret) &&
          typeof secret.name === 'string' &&
          isSafeTrustedCliEnvName(secret.name) &&
          typeof secret.value === 'string' &&
          secret.value.length > 0 &&
          !secret.value.includes('\0') &&
          (secret.encoding === undefined ||
            (secret.injection === 'file' &&
              secret.encoding === 'base64' &&
              Buffer.from(secret.value, 'base64').toString('base64') === secret.value)) &&
          Buffer.byteLength(secret.value) <= 1024 * 1024 &&
          // Absent means env: every caller written before file injection existed.
          (secret.injection === undefined ||
            secret.injection === 'env' ||
            secret.injection === 'file'),
      ) ||
      new Set(raw.secrets.map((secret) => secret.name)).size !== raw.secrets.length
    ) {
      throw new Error('invalid trusted CLI spawn request');
    }
    if (Buffer.byteLength(JSON.stringify(raw.args)) > MAX_ARGS_BYTES) {
      throw new Error('trusted CLI argv exceeds broker limit');
    }
    await validateTrustedCliExecutable(raw.command);
    if (raw.entryScript?.loading === 'isolated') {
      const executable = await realpath(raw.command);
      if (
        executable !== '/bin' &&
        !executable.startsWith('/bin/') &&
        executable !== '/usr' &&
        !executable.startsWith('/usr/')
      ) {
        throw new Error('isolated trusted CLI interpreter must be installed under /bin or /usr');
      }
    }
    const [worktreeRoots, cwd] = await Promise.all([
      resolveAgentWorktreeRoots(options),
      agentWorkspaceRead('realpath', resolve(raw.cwd), options),
    ]);
    if (!withinAgentWorktreeRoots(cwd, worktreeRoots)) {
      throw new Error('trusted CLI cwd escaped the worktree root');
    }
    let approvedEntryScript;
    if (raw.entryScript !== undefined) {
      if (
        !isObject(raw.entryScript) ||
        typeof raw.entryScript.path !== 'string' ||
        !raw.entryScript.path.startsWith('/') ||
        typeof raw.entryScript.projectPath !== 'string' ||
        raw.entryScript.projectPath.startsWith('/') ||
        raw.entryScript.projectPath
          .split('/')
          .some((component) => component === '' || component === '.' || component === '..') ||
        typeof raw.entryScript.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(raw.entryScript.sha256) ||
        (raw.entryScript.loading !== 'isolated' && raw.entryScript.loading !== 'dynamic') ||
        raw.args[0] !== raw.entryScript.path
      ) {
        throw new Error('invalid trusted CLI entry-script attestation');
      }
      // Preserve filesystem errors so missing or inaccessible entries are not
      // misreported as resolved paths outside the allowed worktrees.
      const canonical = await agentWorkspaceRead('realpath', raw.entryScript.path, options);
      if (!withinAgentWorktreeRoots(canonical, worktreeRoots)) {
        throw new Error('trusted CLI entry script escaped the worktree root');
      }
      const entry = await agentWorkspaceRead('lstat', canonical, options);
      if (!entry.isFile()) throw new Error('trusted CLI entry script must be a regular file');
      const digest = createHash('sha256')
        .update(await agentWorkspaceRead('readEntry', canonical, options))
        .digest('hex');
      if (digest !== raw.entryScript.sha256) {
        throw new Error('trusted CLI entry script content hash changed after approval');
      }
      // The turn's cwd is its session worktree, which is usually NESTED in a
      // configured root (`/work/.verity-sessions/<agent>`). Measuring from the
      // configured root would demand a session-specific project path the agent
      // cannot know and no grant could carry across sessions, and would hand a
      // dynamic script every sibling session as its tree.
      const worktreeRoot = cwd;
      if (!withinAgentWorktreeRoots(canonical, [worktreeRoot])) {
        throw new Error('trusted CLI cwd and entry script must share one worktree root');
      }
      const projectPath = canonical.slice(worktreeRoot.length + 1);
      if (projectPath !== raw.entryScript.projectPath) {
        throw new Error('trusted CLI entry script project path does not match its worktree');
      }
      approvedEntryScript = {
        path: canonical,
        projectPath,
        sha256: digest,
        loading: raw.entryScript.loading,
        worktreeRoot,
      };
    }
    await validateTrustedCliArguments(
      raw.command,
      raw.args,
      cwd,
      options.env?.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      // Every file-injected secret contributes one path an argument may name
      // before it exists — the exception is per path, not per request.
      raw.secrets
        .filter((secret) => secret.injection === 'file')
        // Same `options` materialization and injection use: a validator reading
        // the default directory while the file lands in an overridden one would
        // reject the very path the command is about to be handed.
        .map((secret) => trustedCliSecretPath(secret.name, options, raw.correlationId)),
      approvedEntryScript,
      options,
    );
    return {
      kind: 'trusted-cli',
      command: raw.command,
      args: raw.args,
      cwd,
      ...(raw.correlationId === undefined ? {} : { correlationId: raw.correlationId }),
      secrets: raw.secrets,
      ...(approvedEntryScript === undefined ? {} : { entryScript: approvedEntryScript }),
    };
  }
  if (
    !isObject(raw) ||
    raw.protocolVersion !== AGENT_SPAWN_PROTOCOL_VERSION ||
    raw.kind !== 'spawn-agent' ||
    !SPAWNABLE_AGENT_COMMANDS.has(raw.command) ||
    !Array.isArray(raw.args) ||
    raw.args.some((arg) => typeof arg !== 'string') ||
    typeof raw.cwd !== 'string'
  ) {
    throw new Error('invalid agent spawn request');
  }
  // Verity's own per-turn runtime context (see SESSION_RUNTIME_ENV_KEYS). Validated
  // here rather than trusted: this process re-checks the request as far as it can,
  // and anything outside the fixed allowlist would be an attempt to push caller
  // environment across the spawn boundary. The runner worker applies its own
  // check on the request file it reads (`runner-worker-entry.ts`); that one guards
  // a different boundary and neither is a substitute for the other.
  if (raw.sessionEnv !== undefined) {
    const entries = isObject(raw.sessionEnv) ? Object.entries(raw.sessionEnv) : undefined;
    if (
      entries === undefined ||
      entries.length > SESSION_RUNTIME_ENV_KEYS.length ||
      entries.some(
        ([key, value]) =>
          !SESSION_RUNTIME_ENV_KEYS.includes(key) ||
          typeof value !== 'string' ||
          value.length === 0 ||
          Buffer.byteLength(value) > MAX_SESSION_ENV_VALUE_BYTES ||
          hasControlCharacter(value) ||
          SESSION_ENV_VALUE_SHAPES[key]?.test(value) === false,
      )
    ) {
      throw new Error('invalid agent session environment');
    }
  }
  if (Buffer.byteLength(JSON.stringify(raw.args)) > MAX_ARGS_BYTES) {
    throw new Error('agent argv exceeds broker limit');
  }
  // ACP adapters take no caller-selected argv. Their CLI entry points can select
  // another command or unmanaged configuration before the session policy applies.
  if (raw.args.length > 0) {
    throw new Error(`${raw.command} takes no argv`);
  }
  const [worktreeRoots, cwd] = await Promise.all([
    resolveAgentWorktreeRoots(options),
    realpath(resolve(raw.cwd)),
  ]);
  if (!withinAgentWorktreeRoots(cwd, worktreeRoots)) {
    throw new Error('agent cwd escaped the worktree root');
  }
  if (raw.knowledgeIsolation !== undefined && typeof raw.knowledgeIsolation !== 'boolean')
    throw new Error('Invalid knowledge isolation policy');
  // The turn's badge (see TURN_CAPABILITY_PATTERN). Shape-checked only: the Server
  // minted it and alone resolves it.
  if (
    raw.turnCapability !== undefined &&
    (typeof raw.turnCapability !== 'string' || !TURN_CAPABILITY_PATTERN.test(raw.turnCapability))
  )
    throw new Error('invalid agent turn capability');
  if (raw.gitAuthor !== undefined && !isGitAuthor(raw.gitAuthor))
    throw new Error('invalid agent git author');
  if (raw.signCommits !== undefined && raw.signCommits !== false)
    throw new Error('invalid agent commit signing flag');
  if (raw.planning !== undefined && typeof raw.planning !== 'boolean')
    throw new Error('Invalid planning isolation policy');
  if (raw.gatewayToolsOnly === true && raw.knowledgeIsolation === true)
    throw new Error('Native tool isolation cannot use the separate knowledge runtime');
  if (raw.gatewayToolsOnly !== undefined && typeof raw.gatewayToolsOnly !== 'boolean')
    throw new Error('Invalid native tool isolation policy');
  if (
    raw.gatewayToolsOnly === true &&
    raw.command === 'codex-acp' &&
    (typeof raw.gatewayToolsModel !== 'string' ||
      !/^codex\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(raw.gatewayToolsModel) ||
      raw.gatewayToolsModel === 'codex/default')
  )
    throw new Error('Native tool isolation requires a concrete Codex model');
  return {
    kind: 'agent',
    command: raw.command,
    args: raw.args,
    cwd,
    sessionEnv: raw.sessionEnv,
    ...(raw.turnCapability !== undefined ? { turnCapability: raw.turnCapability } : {}),
    ...(raw.gitAuthor !== undefined
      ? { gitAuthor: { name: raw.gitAuthor.name, email: raw.gitAuthor.email } }
      : {}),
    ...(raw.signCommits === false ? { signCommits: false } : {}),
    knowledgeIsolation: raw.knowledgeIsolation === true,
    planning: raw.planning === true,
    gatewayToolsOnly: raw.gatewayToolsOnly === true,
    ...(raw.gatewayToolsOnly === true && raw.command === 'codex-acp'
      ? { gatewayToolsModel: raw.gatewayToolsModel }
      : {}),
  };
}

/**
 * What Claude sees as its OAuth token behind the local egress connector, which
 * swaps in the real one (see packages/server/src/claude-egress-policy.ts). Named
 * here rather than written inline so the shipped bundle never pairs the token's
 * variable name with a literal that reads like a credential.
 */
const CLAUDE_EGRESS_PLACEHOLDER = 'verity-claude-egress-placeholder-v1';

export function childEnvironment(
  command,
  source = process.env,
  sessionEnv = undefined,
  turnCapability = undefined,
  gitAuthor = undefined,
  signCommits = undefined,
) {
  const copy = (name) => (source[name] === undefined ? {} : { [name]: source[name] });
  // Re-filtered here even though `parseRequest` already rejected anything else:
  // this function is the single place the child's environment is built, so the
  // guarantee that a request cannot set PATH, HOME or a credential placeholder
  // should hold by construction rather than by remembering the earlier check.
  const runtimeContext = {};
  for (const name of SESSION_RUNTIME_ENV_KEYS) {
    const value = sessionEnv?.[name];
    if (typeof value === 'string' && value.length > 0) runtimeContext[name] = value;
  }
  const connectorUrl = source.VERITY_CLAUDE_CONNECTOR_URL;
  const isClaude = command === 'claude-agent-acp';
  const connectorEnv =
    isClaude && isLocalConnectorUrl(connectorUrl)
      ? {
          ANTHROPIC_BASE_URL: connectorUrl,
          // Fixed, non-secret placeholder — the real OAuth token lives only in the
          // egress gateway; the connector rewrites this value. Not a credential.
          CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
          // Names the arrangement above, because the Claude CLI strips the
          // placeholder from the subprocesses it spawns: an in-Sandbox helper that
          // has to re-supply it (`verity-code-review`'s isolated reviewer) would
          // otherwise have to guess from ANTHROPIC_BASE_URL looking loopback, which
          // is also true of an unrelated local Anthropic-compatible proxy.
          VERITY_CLAUDE_EGRESS: '1',
        }
      : {};
  return {
    // First, so every fixed key below wins over anything a request supplied.
    ...runtimeContext,
    // Lifecycle launchers sanitize PATH before starting this broker. Restore the
    // image-owned Git/forge guards without losing package shims or interpreter paths.
    PATH: `/opt/verity/package-managers:/opt/agent-seed/bin:${source.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: source.VERITY_AGENT_HOME ?? '/home/dev',
    USER: source.VERITY_AGENT_USER ?? 'dev',
    LOGNAME: source.VERITY_AGENT_USER ?? 'dev',
    LANG: source.LANG ?? 'C.UTF-8',
    ...(isClaude ? copy('CLAUDE_CONFIG_DIR') : {}),
    // claude-agent-acp otherwise starts the private Claude CLI bundled with its
    // Agent SDK. Pin it to the root-owned image binary so upgrades and the live
    // smoke exercise the same executable. Never accept this path from a request.
    ...(command === 'claude-agent-acp' ? { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' } : {}),
    // The Claude CLI opens a cross-session inbox by default: a socket under
    // /tmp/cc-socks that every other Claude process of the same user can find and
    // write to. All sessions of a project share this Sandbox and its uid, so any
    // of them could message any other directly, bypassing session links, their
    // approval and their allowance. Session links are the only agent-to-agent
    // channel. Never accept this value from a request.
    ...(isClaude ? { CLAUDE_CODE_HARBOR_KITE: '0' } : {}),
    // The Claude CLI offers its task-list tools (TaskCreate/TaskUpdate, which the
    // ACP adapter reports as a plan) only to models on its own allowlist. Newer
    // models silently lose them, and the app never receives a checklist.
    ...(isClaude ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } : {}),
    // ADR 0006 D10: derive auth only from one validated local connector URL.
    // Never copy an inherited OAuth/API token; the placeholder is fixed here.
    ...connectorEnv,
    ...(command === 'codex-acp'
      ? {
          ...copy('CODEX_HOME'),
          VERITY_CODEX_PLACEHOLDER: 'verity-codex-gateway-placeholder-v1',
        }
      : {}),
    // codex-acp otherwise runs the @openai/codex copy bundled with the adapter.
    // Pin it to the root-owned, Renovate-pinned image binary — same reasoning as
    // CLAUDE_CODE_EXECUTABLE above. NO_BROWSER keeps the browserless sandbox from
    // being handed an interactive login flow it cannot complete. Never accept
    // either value from a request.
    // INITIAL_AGENT_MODE sets approvalPolicy 'never' + sandbox 'danger-full-access': the project
    // container is the isolation boundary, and Verity has no Codex approval UI.
    // Fixed here so a request cannot pick the mode.
    ...(command === 'codex-acp'
      ? {
          CODEX_PATH: '/usr/local/bin/codex',
          NO_BROWSER: '1',
          INITIAL_AGENT_MODE: 'agent-full-access',
        }
      : {}),
    // Verity's server-owned provider config lives outside OpenCode's writable XDG
    // directory. OpenCode creates files such as .gitignore under the latter during
    // startup, so mounting the whole directory read-only makes every turn crash.
    // OPENCODE_CONFIG points at the separate read-only directory bind while
    // XDG_CONFIG_HOME keeps OpenCode's own files writable. Both are copied, never
    // accepted from a request, and only for the one command that reads them.
    //
    // `copy` reads THIS process's environment, which is the container's: the
    // provisioner puts the variable in the container `Env`, and the stack launcher
    // starts this broker with a plain `nohup` rather than the `env -i` allowlist the
    // egress connector gets (`verity-runner-stack-start`). Move the broker behind a
    // sanitized environment and this forward has to be added to that allowlist.
    //
    // The other three XDG roots are NOT copied — they are pinned, because the
    // container sets none of them and the fallback behind them is `$HOME`, which
    // this function pins to a directory a project's devcontainer image need not
    // have. See {@link OPENCODE_STATE_DIR} for what each one holds and why the
    // path is container-local.
    ...(command === 'opencode-acp'
      ? {
          ...copy('XDG_CONFIG_HOME'),
          ...copy('OPENCODE_CONFIG'),
          // Repository config is executable policy: it can redefine the plan
          // agent, replace providers/MCP servers and load local tools. These
          // flags must be fixed here, never inherited from the container or turn.
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_DISABLE_MODELS_FETCH: '1',
          XDG_DATA_HOME: `${OPENCODE_STATE_DIR}/data`,
          XDG_STATE_HOME: `${OPENCODE_STATE_DIR}/state`,
          XDG_CACHE_HOME: `${OPENCODE_STATE_DIR}/cache`,
        }
      : {}),
    ...copy('IS_SANDBOX'),
    ...copy('VERITY_FORGE_MODE'),
    ...copy('VERITY_FORGE_AUTHORITY'),
    ...copy('VERITY_FORGE_PROXY_URL'),
    ...copy('VERITY_FORGE_PROXY_CA_FILE'),
    ...copy('GIT_TERMINAL_PROMPT'),
    ...copy('GIT_CONFIG_COUNT'),
    ...Object.fromEntries(
      Object.entries(source).filter(([name]) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/u.test(name)),
    ),
    // A person without a signing key commits unsigned, from this turn's request
    // only. Appended after the container's own pairs, which keep the signing
    // program and key configured for everyone else in the container.
    ...(signCommits === false ? unsignedCommitsConfig(source) : {}),
    ...copy('VERITY_SIGNING_URL'),
    ...copy('VERITY_SIGNING_TOKEN_FILE'),
    ...copy('VERITY_GH_BROKER_CAPABILITY_FILE'),
    ...copy('VERITY_PROJECT_MEMORY_URL'),
    ...copy('VERITY_PROJECT_REPO_URL'),
    // Only ever from this turn's request, never copied from the container: an
    // ambient value would let one turn present another turn's badge.
    ...(typeof turnCapability === 'string' && TURN_CAPABILITY_PATTERN.test(turnCapability)
      ? { VERITY_TURN_CAPABILITY: turnCapability }
      : {}),
    // The turn's own author, also only from this turn's request. git prefers these
    // over the shared container's `user.name` / `user.email`, which name one person.
    ...(isGitAuthor(gitAuthor)
      ? {
          GIT_AUTHOR_NAME: gitAuthor.name,
          GIT_AUTHOR_EMAIL: gitAuthor.email,
          GIT_COMMITTER_NAME: gitAuthor.name,
          GIT_COMMITTER_EMAIL: gitAuthor.email,
        }
      : {}),
  };
}

/**
 * The privilege-reducing half of every brokered `setpriv` argv. The identity
 * half (`--reuid`/`--regid`) is per-launch; this half varies in exactly one
 * sanctioned way, see the end of this comment — and both
 * {@link agentLaunchSpec} and {@link trustedCliLaunchSpec} spread it verbatim —
 * a trusted CLI is reached THROUGH an agent turn, so anything it may hold, the
 * agent may drive, and the two prefixes have to stay identical.
 *
 * `--clear-groups` is NOT an oversight, and this is NOT a place to pass
 * `options.runnerGid` through. The Runner's whole control surface — every
 * turn's `events.jsonl`, its `control.sock`, and `supervisor.sock` — is 0660
 * owned by the runtime GID, so that group membership IS the anti-forgery
 * boundary of ADR 0006: "the agent child retains neither the Runner UID nor the
 * runtime GID and clears all supplementary groups before exec". An agent
 * holding it could append to the journal of its own turn, i.e. forge the record
 * the Server trusts.
 *
 * The agent needs nothing from that group. It reaches its transcript directory
 * through the OWNER traverse bit the runtime dir carries for exactly this
 * reason ({@link validateRunnerRuntimeStats} admits 0170), and every brokered
 * capability it has arrives as environment from `childEnvironment` or over its
 * own stdio — never as a file it opens under the runtime dir.
 *
 * One list, because a boundary that is copy-pasted rots asymmetrically. There
 * is one copy that cannot be avoided — `scripts/test-runner-forgery-boundary.mjs`
 * is bind-mounted alone into the server image, with no repo beside it to import
 * from, and it is what actually PROVES the resulting denials, as root, in CI.
 * `broker-spawner.test.ts` pins this list to that script's argv in both
 * directions, and to both launch paths, so no copy can move on its own.
 *
 * Where this argv stops being the boundary. ADR 0006 Amendment 1 (2026-08-18)
 * records the operator's decision to mount the host Docker daemon socket into
 * the CONTROL-PLANE Runner, and this note is here so that nobody reads the
 * paragraphs above as a guarantee that survives it.
 *
 * A `group_add` on that container reaches this child not at all —
 * `--clear-groups` leaves it holding no supplementary group — so the grant is
 * made here instead, by {@link privilegeDropFlags}, which substitutes
 * `--groups=<docker-gid>` for `--clear-groups` (util-linux takes exactly one of
 * the four group flags, and `--groups` SETS the list rather than extending it,
 * so the runtime GID still cannot arrive by accident).
 *
 * Read that substitution for what it is worth and no more. Once the socket is
 * reachable, the agent can start a privileged container and rewrite the same
 * journals as host root, so for that one container the anti-forgery property
 * above is void in practice and this argv is not what protects it — nothing
 * does. What the substitution buys is that the runtime GID is not widened into
 * by mistake. The paragraphs above keep describing PROJECT Sandboxes exactly:
 * no socket, no Docker group, `--clear-groups` intact, denials proven in CI.
 */
export const PRIVILEGE_DROP_FLAGS = Object.freeze([
  '--clear-groups',
  '--no-new-privs',
  '--inh-caps=-all',
  '--ambient-caps=-all',
  '--bounding-set=-all',
]);

/**
 * {@link PRIVILEGE_DROP_FLAGS}, with the one sanctioned substitution applied:
 * ADR 0006 Amendment 1's Docker grant to the control-plane agent. The reasoning
 * — why the grant cannot be made with `group_add`, what the `--groups` form
 * preserves, and what it emphatically does not — is above and in the amendment;
 * it is deliberately not restated here, so that the two cannot drift apart.
 *
 * The mechanics this function is responsible for: substitute rather than append
 * (util-linux accepts exactly one group flag), keep every other flag in place,
 * and fail closed on a value that is not a group id or that is the Runner's own
 * runtime gid. `dockerGid` is absent for every project Sandbox, whose argv is
 * byte-for-byte unchanged.
 */
export function privilegeDropFlags(dockerGid, runnerGid) {
  if (dockerGid === undefined || dockerGid === '') return [...PRIVILEGE_DROP_FLAGS];
  const gid = Number(dockerGid);
  // Fail closed, and loudly. A bad value must not quietly degrade to
  // `--clear-groups`: that is the "socket the agent cannot open" failure this
  // path exists to remove, and it would look identical to success.
  if (!Number.isSafeInteger(gid) || gid < 1) {
    throw new Error('agent spawn broker requires a positive docker group id');
  }
  // The ADR 0006 invariant, ENFORCED here rather than assumed upstream. The
  // runtime GID owns every turn's `events.jsonl`, its `control.sock` and
  // `supervisor.sock`, so it is the one group this substitution must never be
  // able to hand over — whoever computed the value, and wherever it came from.
  // `runnerGid` is trustworthy for the comparison because the Server pins it in
  // the container's own Env (provisioner.ts), which overrides any image ENV.
  if (runnerGid !== undefined && gid === Number(runnerGid)) {
    throw new Error('agent spawn broker refuses the Runner runtime gid as a docker grant');
  }
  return [`--groups=${String(gid)}`, ...PRIVILEGE_DROP_FLAGS.slice(1)];
}

/**
 * Resolve the ADR 0006 Amendment 1 grant WITHOUT taking the environment's word
 * for it.
 *
 * `VERITY_AGENT_DOCKER_GID` is set by `verity-control-plane-runner-start` and by
 * nothing else — but "nothing else sets it" is not "nothing else CAN set it". A
 * project Sandbox's image is built from that repository's own `.devcontainer`
 * (`provisioner.ts`), and the Server pins only the env names it lists, so a name
 * it does not list falls through from the image. A repository could therefore
 * ship `ENV VERITY_AGENT_DOCKER_GID=<runtime gid>` and, with the variable
 * trusted, hand its own agent the group that owns the turn journal — precisely
 * the ADR 0006 forgery boundary, defeated by a file in the repo under test.
 *
 * So the variable is a HINT and the mounted inode is the authority: the grant
 * survives only if a real socket is there and really is owned by the group
 * claimed. A project Sandbox has no daemon socket, so it resolves to nothing and
 * that agent's argv is byte-for-byte what it was. (One that DID have the socket
 * is already lost for reasons no argv can fix.)
 */
export function resolveDockerGid(env, statSocketGid) {
  const declared = env.VERITY_AGENT_DOCKER_GID;
  if (declared === undefined || declared === '') return undefined;
  let socketGid;
  try {
    socketGid = statSocketGid('/var/run/docker.sock');
  } catch {
    socketGid = undefined;
  }
  if (socketGid === undefined || String(socketGid) !== String(declared)) {
    process.stderr.write(
      'verity-agent-spawn-broker: ignoring VERITY_AGENT_DOCKER_GID — no /var/run/docker.sock owned by that group\n',
    );
    return undefined;
  }
  return String(declared);
}

/** One writer may refresh policy or use native databases for a session at a time. */
export const activeSessionHomes = new Set();
export const sessionHomeLocks = new Map();
const SESSION_HOME_WAIT_MS = 2_000;
export const SESSION_HOME_BUSY =
  'session home is already in use; the previous agent is still shutting down. Wait a moment and try again.';

export async function waitForSessionHome(home) {
  const deadline = Date.now() + SESSION_HOME_WAIT_MS;
  while (activeSessionHomes.has(home)) {
    if (Date.now() >= deadline) throw new Error(SESSION_HOME_BUSY);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

export function sessionHomePath(runtimeDir, sessionId) {
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    sessionId.length > 256 ||
    hasControlCharacter(sessionId)
  )
    throw new Error('invalid session id');
  return join(runtimeDir, 'session-homes', createHash('sha256').update(sessionId).digest('hex'));
}

export async function policyWrite(path, content, options = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: options.mode ?? 0o644, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function managedDirectory(path, owner, group) {
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('invalid session home directory');
  await chown(path, owner, group);
  await chmod(path, 0o755);
}

export async function lockSessionHome(home, options, nonblocking = false) {
  await managedDirectory(
    join(options.runtimeDir, 'session-homes'),
    process.getuid(),
    process.getgid(),
  );
  const handle = await open(
    `${home}.lock`,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await new Promise((resolveLock, rejectLock) => {
      const child = spawn(
        '/usr/bin/flock',
        [...(nonblocking ? ['--nonblock'] : ['--wait', String(SESSION_HOME_WAIT_MS / 1000)]), '3'],
        {
          stdio: ['ignore', 'ignore', 'ignore', handle.fd],
        },
      );
      child.once('error', rejectLock);
      child.once('exit', (code) =>
        code === 0 ? resolveLock() : rejectLock(new Error(SESSION_HOME_BUSY)),
      );
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** A project-wide content cache; credentials and npm logs remain in the private home. */
export function npmCachePath(options) {
  return join(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, 'package-cache', 'npm');
}
