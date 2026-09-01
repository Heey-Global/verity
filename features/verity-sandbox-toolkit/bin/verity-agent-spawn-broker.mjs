#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

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
const OPENCODE_STATE_DIR = '/run/verity/opencode';
export const DEFAULT_RUNTIME_DIR = '/run/verity-runner';
export const DEFAULT_CONTROL_DIR = '/run/verity-runner-broker';
export const DEFAULT_WORKTREE_ROOT = '/work';
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
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_ARGS_BYTES = 2 * 1024 * 1024;
/**
 * The `command` values a spawn request may name. Deliberately a closed set held
 * separately from the path map in {@link agentLaunchSpec}: this one bounds what the
 * request parser will accept, that one decides what each accepted name execs, and
 * an entry missing from either is a refusal rather than a fallback. Keep both in
 * step with the profiles' `defaultCommand` in packages/session/src/acp-*-backend.ts.
 */
const SPAWNABLE_AGENT_COMMANDS = new Set(['claude-agent-acp', 'codex-acp', 'opencode-acp']);
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
const SESSION_RUNTIME_ENV_KEYS = ['VERITY_SESSION_BACKEND', 'VERITY_SESSION_MODEL'];
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decode(data) {
  return Buffer.from(data, 'base64');
}

function isLocalConnectorUrl(value) {
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

function send(socket, value) {
  if (socket.destroyed) return false;
  return socket.write(`${JSON.stringify(value)}\n`);
}

async function acquireLock(path) {
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

function validateIdentity(options) {
  const uid = Number(options.agentUid);
  const gid = Number(options.agentGid);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error('agent spawn broker requires non-root agent uid/gid');
  }
  return { uid, gid };
}

function isSafeTrustedCliEnvName(name) {
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
async function validateImmutablePath(path, endpoint = false) {
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
async function validateTrustedCliFileIntegrity(path) {
  const resolved = await realpath(path);
  const entry = await lstat(resolved);
  const endpoint = entry.isSocket();
  await validateImmutablePath(path, endpoint);
  if (resolved !== path) await validateImmutablePath(resolved, endpoint);
  if (!entry.isFile() && !endpoint) {
    throw new Error('trusted CLI file operand must be a regular file');
  }
}

async function validateTrustedCliExecutableDirectory(path) {
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
async function validateSharedSessionRoot(options) {
  if (options.sharedSessionRoot === undefined) return;
  const configured = resolve(options.sharedSessionRoot);
  if (configured === '/') throw new Error('shared session root must not be the filesystem root');
  const resolved = await realpath(configured).catch(() => undefined);
  if (resolved === undefined || resolved === '/' || !(await lstat(resolved)).isDirectory()) {
    throw new Error(`shared session root is not a mounted directory: ${configured}`);
  }
}

async function validateSpawnRequest(raw, options) {
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
      realpath(resolve(raw.cwd)),
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
      const canonical = await realpath(raw.entryScript.path).catch(() => undefined);
      if (canonical === undefined || !withinAgentWorktreeRoots(canonical, worktreeRoots)) {
        throw new Error('trusted CLI entry script escaped the worktree root');
      }
      const entry = await lstat(canonical);
      if (!entry.isFile()) throw new Error('trusted CLI entry script must be a regular file');
      const digest = createHash('sha256')
        .update(await readFile(canonical))
        .digest('hex');
      if (digest !== raw.entryScript.sha256) {
        throw new Error('trusted CLI entry script content hash changed after approval');
      }
      const worktreeRoot = [...worktreeRoots]
        .sort((left, right) => right.length - left.length)
        .find((root) => withinAgentWorktreeRoots(canonical, [root]));
      if (worktreeRoot === undefined) throw new Error('trusted CLI entry script has no worktree');
      if (!withinAgentWorktreeRoots(cwd, [worktreeRoot])) {
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
        .map((secret) => trustedCliSecretPath(secret.name, options)),
      approvedEntryScript,
    );
    return {
      kind: 'trusted-cli',
      command: raw.command,
      args: raw.args,
      cwd,
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
  // `opencode-acp` takes no argv at all, and the reason is the `cwd` check below.
  // That check resolves the requested directory and refuses anything outside the
  // worktree roots — but `opencode acp` accepts `--cwd`, so a request could satisfy
  // the check with a legal `cwd` and then hand the agent a different working
  // directory in its argv, while still receiving the broker-supplied child
  // environment. Neither of the other two adapters has a flag that can do that, so
  // this is not a general argv policy; it is the one place where argv would walk
  // past a boundary this function enforces. Verity's OpenCode profile passes no
  // arguments (`acp-opencode-backend.ts`), so nothing legitimate is refused: if a
  // future turn needs one, add it to an allowlist here rather than reopening argv.
  //
  // Two flags in particular are not allowlist material. `--cwd` is the one above.
  // The other is any flag that makes the agent LISTEN — `opencode serve` grew
  // `--port`, `--hostname`, `--cors` and `--mdns`, and admitting one here would put a
  // network-reachable agent back inside the Sandbox holding the turn's credentials,
  // which is exactly the shared-server exposure ADR 0010 O3 was closed by removing
  // (ADR 0012 Amendment 4). Admitting one reopens it and needs that decision retaken.
  if (raw.command === 'opencode-acp' && raw.args.length > 0) {
    throw new Error('opencode-acp takes no argv');
  }
  const [worktreeRoots, cwd] = await Promise.all([
    resolveAgentWorktreeRoots(options),
    realpath(resolve(raw.cwd)),
  ]);
  if (!withinAgentWorktreeRoots(cwd, worktreeRoots)) {
    throw new Error('agent cwd escaped the worktree root');
  }
  return {
    kind: 'agent',
    command: raw.command,
    args: raw.args,
    cwd,
    sessionEnv: raw.sessionEnv,
  };
}

function childEnvironment(command, source = process.env, sessionEnv = undefined) {
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
          CLAUDE_CODE_OAUTH_TOKEN: 'verity-claude-egress-placeholder-v1', // gitleaks:allow
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
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: source.VERITY_AGENT_HOME ?? '/home/dev',
    USER: source.VERITY_AGENT_USER ?? 'dev',
    LOGNAME: source.VERITY_AGENT_USER ?? 'dev',
    LANG: source.LANG ?? 'C.UTF-8',
    ...(isClaude ? copy('CLAUDE_CONFIG_DIR') : {}),
    // claude-agent-acp otherwise starts the private Claude CLI bundled with its
    // Agent SDK. Pin it to the root-owned image binary so upgrades and the live
    // smoke exercise the same executable. Never accept this path from a request.
    ...(command === 'claude-agent-acp' ? { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' } : {}),
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
    // OpenCode has no config-dir variable of its own; it reads plain XDG. The
    // provisioner mounts the shared opencode config volume at
    // `$XDG_CONFIG_HOME/opencode` and sets that variable for devcontainer images,
    // whose home directory is not `/home/dev` (provisioner.ts, `pathMode`). Without
    // it the child falls back to `$HOME/.config/opencode`, which on those images is
    // an empty directory — so the agent starts with no provider configured and the
    // turn fails on the first prompt rather than at spawn. Copied, never accepted
    // from a request, and only for the one command that reads it.
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
          XDG_DATA_HOME: `${OPENCODE_STATE_DIR}/data`,
          XDG_STATE_HOME: `${OPENCODE_STATE_DIR}/state`,
          XDG_CACHE_HOME: `${OPENCODE_STATE_DIR}/cache`,
        }
      : {}),
    ...copy('IS_SANDBOX'),
    ...copy('GIT_CONFIG_COUNT'),
    ...Object.fromEntries(
      Object.entries(source).filter(([name]) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/u.test(name)),
    ),
    ...copy('VERITY_SIGNING_URL'),
    ...copy('VERITY_SIGNING_TOKEN_FILE'),
    ...copy('VERITY_GH_TOKEN_URL'),
    ...copy('VERITY_GH_TOKEN_CAPABILITY_FILE'),
    ...copy('VERITY_PROJECT_MEMORY_URL'),
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

export function agentLaunchSpec(request, options) {
  const { uid, gid } = validateIdentity(options);
  const setprivPath = options.setprivPath ?? '/usr/bin/setpriv';
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
      ...privilegeDropFlags(options.dockerGid, options.runnerGid),
      agentPath,
      ...request.args,
    ],
    spawnOptions: {
      cwd: request.cwd,
      env: childEnvironment(
        request.command,
        {
          ...options.env,
          VERITY_CLAUDE_CONNECTOR_URL: options.connectorUrl,
        },
        request.sessionEnv,
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
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
const MAX_TRUSTED_CLI_ARGV_POLICY_BYTES = 64 * 1024;
const TRUSTED_CLI_POLICY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

function parseTrustedCliArgvPolicy(raw) {
  if (
    !isObject(raw) ||
    raw.version !== 1 ||
    Object.keys(raw).some((key) => key !== 'version' && key !== 'routes') ||
    !Array.isArray(raw.routes) ||
    raw.routes.length === 0 ||
    raw.routes.length > 64
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
  const path = `${resolvedCommand}${TRUSTED_CLI_ARGV_POLICY_SUFFIX}`;
  const inspect = options.lstat ?? lstat;
  const validatePath = options.validateImmutablePath ?? validateImmutablePath;
  const read = options.readFile ?? readFile;
  let entry;
  try {
    entry = await inspect(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
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
  // Production reaches this only after validateTrustedCliExecutable; retain the
  // basename fallback for direct validator callers and focused unit fixtures.
  const resolvedCommand = await realpath(command).catch(() => command);
  const commandName = resolvedCommand.slice(resolvedCommand.lastIndexOf('/') + 1);
  let interpreterName = trustedCliInterpreterName(resolvedCommand) ?? '';
  let interpreter = interpreterName.length > 0;
  let inlineCodeFollows = false;
  let remainingAreData = false;
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
          const canonical = await realpath(path);
          found = path;
          stat = await lstat(canonical);
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
          (await realpath(found)) === approvedEntryScript.path
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
    if (interpreter) interpreter = false;
  }
}

const TRUSTED_CLI_SECRET_DIR = '/run/verity-runner/secrets';

function trustedCliSecretPath(name, options) {
  if (!isSafeTrustedCliEnvName(name)) throw new Error('unsafe trusted CLI environment variable');
  return `${options?.secretDir ?? TRUSTED_CLI_SECRET_DIR}/${name}`;
}

const TRUSTED_CLI_SECRET_LEAK_ERROR = 'trusted CLI secret file could not be removed';

/**
 * Pick which failure the caller hears about when a run fails and its secret file
 * survived. The leak wins: the run is lost either way, but only this outcome
 * needs a credential rotated, and a spawn error scrolling past says nothing
 * about that. The original message rides along so diagnosis still has it, and
 * `stage` says which step dropped the run so the two cases stay tellable apart.
 */
function leakOutranks(contained, error, stage = 'spawn failed') {
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
async function materializeTrustedCliSecrets(request, options) {
  const fileSecrets = request.secrets.filter((secret) => secret.injection === 'file');
  if (fileSecrets.length === 0) return { cleanup: async () => true };
  const { uid, gid } = validateIdentity(options);
  const written = [];
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
    return contained.every(Boolean);
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
    for (const secret of fileSecrets) {
      const path = trustedCliSecretPath(secret.name, options);
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
  const handle = await open(request.entryScript.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('trusted CLI entry script must be a regular file');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
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
    await mkdir(snapshotScriptDir, { recursive: true, mode: 0o755 });
    const relativeCwd = request.cwd.slice(request.entryScript.worktreeRoot.length + 1);
    const snapshotCwd = join(snapshotRoot, relativeCwd);
    if (request.entryScript.loading === 'isolated') {
      await mkdir(snapshotCwd, { recursive: true, mode: 0o755 });
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
        for (const entry of await readdir(sourceDir)) {
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
          options.scriptSandboxPath ?? '/usr/local/bin/verity-script-sandbox',
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
              ? ['--secret', trustedCliSecretPath(secret.name, options)]
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
            secret.injection === 'file' ? trustedCliSecretPath(secret.name, options) : secret.value,
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
const readProcFile = (path) => readFileSync(path, 'utf8');

/**
 * Fields of `/proc/<pid>/stat` AFTER `comm`, which may itself contain spaces and
 * parentheses — hence the split starting at the LAST `)`. Index 2 is field 5 (`pgrp`),
 * index 19 is field 22 (`starttime`, the fence against pid reuse).
 */
function statFields(pid, readProc) {
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

function processStartTime(pid, readProc) {
  return statFields(pid, readProc)[19] ?? '';
}

/**
 * Depth-first walk of the descendants of `root` that a `kill(-root)` would MISS — the
 * ones outside process group `root`. `root` itself is NOT included (the group signal
 * owns it), and neither are the descendants inside that group: those the group signal
 * already reaches, and they are entitled to their leader's grace rather than to the
 * short one an escaped tree is escalated on. The walk still DESCENDS through them,
 * because an in-group shell is exactly how an escaped grandchild is reached.
 *
 * The group is `root`'s pid and NOT the `pgrp` its own `/proc` entry reports, because
 * `-root` is what the caller signals; see the note on the session-package copy.
 *
 * The kernel files a child under the thread that forked it, so every task's `children`
 * file is read. If the task directory cannot be listed, the main-thread path remains a
 * best-effort fallback.
 *
 * Exported for the drift tripwire only. This is a hand-synced fork of
 * `collectEscapedProcessTree` in `packages/session/src/process-tree.ts` — the broker is
 * standalone ESM and cannot import the workspace — and behaviourally identical, though
 * not textually: the seam is a positional `readProc` here and a `ProcessTreeOptions`
 * there, and the `keep` predicate is inlined here rather than passed to a shared
 * `walkProcessTree`. The test that keeps the two honest runs the same fixture table
 * through both walks; `signalProcessTree` and the grace constant are compared
 * separately, the latter by value only.
 */
export function collectEscapedProcessTree(root, readProc = readProcFile) {
  const rootGroup = String(root);
  const descendants = new Map();
  let rootStartTime;
  try {
    rootStartTime = processStartTime(root, readProc);
  } catch {
    return descendants;
  }
  if (rootStartTime === '') return descendants;
  const visited = new Set();
  const visit = (parent) => {
    if (visited.has(parent)) return;
    visited.add(parent);
    let taskIds;
    try {
      taskIds = readdirSync(`/proc/${parent}/task`)
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number);
    } catch {
      taskIds = [parent];
    }
    const children = new Set();
    for (const taskId of taskIds) {
      try {
        for (const child of readProc(`/proc/${parent}/task/${taskId}/children`)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)) {
          children.add(child);
        }
      } catch {
        // A thread or the whole parent exited mid-walk.
      }
    }
    for (const child of children) {
      try {
        // Fence the recursive read on BOTH sides. The pid came from its parent's
        // `children` file, but it can exit and be reused before or during `visit`.
        // Anything collected below a child whose identity changed may belong to the
        // replacement process, so roll that entire addition back.
        const before = statFields(child, readProc);
        const startTime = before[19] ?? '';
        // No start time means no fence: at signal time an empty capture would compare
        // equal to the empty read of whatever now holds that pid, and the check meant to
        // refuse a recycled pid would wave it through. A descendant whose identity cannot
        // be established is therefore dropped — the group signal still covers it if it
        // never left the group, and an unfenced kill is the one outcome worth avoiding.
        if (startTime === '') continue;
        const alreadyCollected = new Set(descendants.keys());
        visit(child);
        const after = statFields(child, readProc);
        if ((after[19] ?? '') !== startTime) {
          for (const pid of descendants.keys()) {
            if (!alreadyCollected.has(pid)) descendants.delete(pid);
          }
          continue;
        }
        if ((after[2] ?? '') !== rootGroup) descendants.set(child, startTime);
      } catch {
        // It exited while the tree was being captured.
      }
    }
  };
  visit(root);
  try {
    if (processStartTime(root, readProc) !== rootStartTime) descendants.clear();
  } catch {
    descendants.clear();
  }
  return descendants;
}

/**
 * A diagnostic line on stderr. Guarded: a broker whose stderr has been closed under it
 * gets EPIPE, and these calls sit in detached timer callbacks where that would be an
 * uncaught exception rather than a lost log line.
 */
function warn(message) {
  const ignoreWriteError = () => undefined;
  process.stderr.once('error', ignoreWriteError);
  try {
    process.stderr.write(`verity-agent-spawn-broker: ${message}\n`, () => {
      process.stderr.off('error', ignoreWriteError);
    });
  } catch {
    process.stderr.off('error', ignoreWriteError);
    // Nowhere to report to.
  }
}

/** Warned once per broker process; the condition is a property of the kernel. */
let childrenApiWarned = false;

/**
 * `/proc/<pid>/task/<pid>/children` exists only on kernels built with
 * `CONFIG_CHECKPOINT_RESTORE`. Without it the walk finds nothing, every teardown looks
 * like a sandbox that simply had no escaped tool trees, and the escalation log below —
 * the tell this design leans on — stays silent for the one reason that is NOT success.
 * Checked only when the walk came back empty, so the common case reads nothing extra.
 */
function warnIfChildrenApiMissing(pid, readProc) {
  if (childrenApiWarned) return;
  try {
    // A process that has already exited has no `children` file either, and that is the
    // common case, not a kernel without the API. Its `stat` is the discriminator.
    readProc(`/proc/${pid}/stat`);
  } catch {
    return;
  }
  try {
    readProc(`/proc/${pid}/task/${pid}/children`);
  } catch {
    childrenApiWarned = true;
    warn(
      'no /proc/<pid>/task/<pid>/children on this kernel (CONFIG_CHECKPOINT_RESTORE) — ' +
        'agent tool trees that left the process group cannot be reached',
    );
  }
}

/**
 * Clear the once-per-process latch above. Exported for tests only: the latch makes the
 * warning order-dependent across a file that tears many fake trees down, and a test that
 * asserts the line is written has to start from a known state rather than from whichever
 * test happened to run first.
 */
export function resetProcessTreeWarnings() {
  childrenApiWarned = false;
}

/**
 * Signal a captured tree, skipping any pid whose start time no longer matches, and
 * report how many pids were actually signalled — the escalation below is the one event
 * here worth a line in the broker's log, and this is what tells it whether to write one.
 */
function signalProcessTree(tree, signal, kill, readProc) {
  let signalled = 0;
  for (const [pid, startTime] of tree) {
    try {
      if (processStartTime(pid, readProc) !== startTime) continue;
      kill(pid, signal);
      signalled += 1;
    } catch {
      // Already gone.
    }
  }
  return signalled;
}

/**
 * Stop an agent and everything it started. The process group signal alone is not
 * enough: an agent starts each Bash tool call through `setsid`, so the shell — and the
 * `vitest`/`tsc` tree under it — leads its own group and `kill(-pid)` never reaches it.
 * Those survivors reparent to the sandbox's init and keep holding the sandbox's memory
 * and pid budget until the container is recreated. The `/proc` parent/child links
 * survive `setsid`, so the escaped subtree is walked first, signalled, and escalated to
 * SIGKILL after {@link PROCESS_TREE_KILL_GRACE_MS} — the agent itself keeps whatever
 * grace its caller grants it.
 */
export function stopAgentProcessGroup(child, signal, options = {}) {
  const kill = options.kill ?? ((pid, signalName) => process.kill(pid, signalName));
  const readProc = options.readProc ?? readProcFile;
  const running = child.exitCode === null && child.signalCode === null;
  if (child.pid === undefined || !running) {
    child.kill(signal);
    return;
  }
  // Captured BEFORE anything is signalled: a SIGTERM'd shell tears its own children
  // down, and a tree walked afterwards would be missing exactly what we mean to reach.
  let rootStartTime = '';
  try {
    rootStartTime = processStartTime(child.pid, readProc);
  } catch {
    // Root exited before its identity could be captured.
  }
  const escaped = collectEscapedProcessTree(child.pid, readProc);
  if (escaped.size === 0) warnIfChildrenApiMissing(child.pid, readProc);
  signalProcessTree(escaped, signal, kill, readProc);
  let rootIdentityMatches = true;
  if (rootStartTime !== '') {
    try {
      rootIdentityMatches = processStartTime(child.pid, readProc) === rootStartTime;
    } catch {
      rootIdentityMatches = false;
    }
  }
  if (rootIdentityMatches) {
    try {
      kill(-child.pid, signal);
    } catch {
      // The group may already be gone; fall back to Node's safe direct child
      // signal for custom spawners and spawn/exit races.
      child.kill(signal);
    }
  }
  // Nothing survives SIGKILL, and an empty capture has nothing to escalate: in both
  // cases a timer would only be a handle holding pids the kernel is free to recycle.
  if (signal === 'SIGKILL' || escaped.size === 0) return;
  // Deliberately NOT unref'd — see the session-package copy: broker shutdown is exactly
  // when a surviving tool tree costs the most, and the guard above keeps the timer from
  // being scheduled at all on a teardown that found nothing escaped.
  setTimeout(() => {
    const killed = signalProcessTree(escaped, 'SIGKILL', kill, readProc);
    // The one observable symptom of this whole mechanism. A tool tree that has to be
    // SIGKILLed is normal enough (a `vitest` run does not stop politely), but a sandbox
    // where this line NEVER appears while pids keep accumulating is how the leak coming
    // back — a `/proc` the walk can no longer read, a signal the kernel refuses — would
    // otherwise look exactly like success.
    if (killed > 0) warn(`SIGKILLed ${killed} agent tool process(es) that outlived SIGTERM`);
  }, PROCESS_TREE_KILL_GRACE_MS);
}

export function killExitedTrustedCliProcessGroup(child, kill = process.kill) {
  if (child.pid === undefined) return;
  try {
    kill(-child.pid, 'SIGKILL');
  } catch {
    // The expected case is that the process group disappeared with its leader.
  }
}

export function validateRunnerRuntimeStats(stats, options) {
  if (options.runnerUid === undefined) return;
  if (stats.gid !== Number(options.runnerGid)) {
    throw new Error('runner runtime ownership mismatch');
  }
  const runnerOwned = stats.uid === Number(options.runnerUid);
  // Owner read/write must stay clear (a same-uid agent must not touch the
  // Runner's control files), but a bare owner traverse bit (0170, --x) is allowed
  // so the agent can descend to its Server-created transcript dir under claude/.
  const serverOwned = !runnerOwned && (stats.mode & 0o600) === 0;
  if (!runnerOwned && !serverOwned) {
    throw new Error('runner runtime ownership mismatch');
  }
  if ((stats.mode & 0o007) !== 0 || (stats.mode & 0o070) !== 0o070) {
    throw new Error('runner runtime must be group-only and writable');
  }
}

export function brokerSocketOwnership(options) {
  if (options.runnerUid === undefined) return { uid: undefined, gid: undefined, mode: 0o600 };
  const rootBroker = options.enforceRoot !== false;
  return {
    uid: rootBroker ? 0 : Number(options.runnerUid),
    gid: Number(options.runnerGid),
    mode: rootBroker ? 0o660 : 0o600,
  };
}

async function readConnectorUrl(path, expectedUid) {
  try {
    const stats = await lstat(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.uid !== expectedUid ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > 128
    ) {
      throw new Error('invalid Claude connector routing file');
    }
    const value = (await readFile(path, 'utf8')).trim();
    if (!isLocalConnectorUrl(value)) {
      throw new Error('invalid Claude connector routing URL');
    }
    return value;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function runAgentSpawnBroker(options = {}) {
  if (options.enforceRoot !== false && process.getuid?.() !== 0) {
    throw new Error('agent spawn broker must run as root');
  }
  validateIdentity(options);
  await validateSharedSessionRoot(options);
  const runtimeDir = resolve(options.runtimeDir ?? DEFAULT_RUNTIME_DIR);
  // `enforceRoot: false` is the explicit test seam; every real/root broker uses
  // the fixed root-owned control directory unless the caller names another one.
  const controlDir = resolve(
    options.controlDir ?? (options.enforceRoot === false ? runtimeDir : DEFAULT_CONTROL_DIR),
  );
  const stats = await lstat(runtimeDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('invalid runner runtime');
  if ((options.runnerUid === undefined) !== (options.runnerGid === undefined)) {
    throw new Error('runner uid and gid must be configured together');
  }
  validateRunnerRuntimeStats(stats, options);
  const lock = await acquireLock(join(controlDir, 'agent-spawn-broker.lock'));
  const socketPath = join(controlDir, 'agent-spawn-broker.sock');
  await rm(socketPath, { force: true });
  const children = new Map();
  const sockets = new Set();
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const connectorConfigPath =
    options.connectorConfigPath ?? join(controlDir, 'egress-connector.url');
  const connectorConfigOwner = options.enforceRoot === false ? (process.getuid?.() ?? 0) : 0;
  let closing = false;
  const spawnChild =
    options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let child;
    let processing = Promise.resolve();
    let accepted = false;
    let connectionClosed = false;
    let childRecord;
    let protocolFailed = false;
    let trustedCliFailurePhase;
    const fail = (error) => {
      if (protocolFailed) return;
      protocolFailed = true;
      send(socket, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(trustedCliFailurePhase === undefined
          ? {}
          : {
              trustedCliFailure: {
                phase: trustedCliFailurePhase,
                cause: `${trustedCliFailurePhase} failed`,
              },
            }),
      });
      childRecord?.stop('SIGKILL');
      socket.end();
    };
    const handle = async (raw) => {
      if (protocolFailed) return;
      if (!accepted) {
        if (
          isObject(raw) &&
          raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION &&
          raw.kind === 'status'
        ) {
          protocolFailed = true;
          send(socket, { ok: true, protocolVersion: AGENT_SPAWN_PROTOCOL_VERSION });
          socket.end();
          return;
        }
        if (closing) throw new Error('agent spawn broker is shutting down');
        if (isObject(raw) && raw.kind === 'spawn-trusted-cli') {
          trustedCliFailurePhase = 'validation';
        }
        const request = await validateSpawnRequest(raw, options);
        if (closing || connectionClosed) throw new Error('agent spawn request was detached');
        const connectorUrl =
          request.kind === 'agent'
            ? await readConnectorUrl(connectorConfigPath, connectorConfigOwner)
            : undefined;
        if (request.kind === 'trusted-cli') trustedCliFailurePhase = 'materialization';
        const materialized =
          request.kind === 'agent'
            ? { args: request.args, cleanup: async () => undefined }
            : await (async () => {
                const entryScript = await materializeTrustedCliEntryScript(request, options);
                let secrets;
                try {
                  secrets = await materializeTrustedCliSecrets(request, options);
                } catch (error) {
                  await entryScript.cleanup();
                  throw error;
                }
                return {
                  args: entryScript.args,
                  ...(entryScript.entrySandbox === undefined
                    ? {}
                    : { entrySandbox: entryScript.entrySandbox }),
                  cleanup: async () => {
                    const [secretContained] = await Promise.all([
                      secrets.cleanup(),
                      entryScript.cleanup(),
                    ]);
                    // A stranded snapshot contains only bytes the user approved,
                    // not a credential. Its cleanup failure must not falsely
                    // report that a secret leaked; the secret result remains the
                    // containment authority for this combined cleanup.
                    return secretContained;
                  },
                };
              })();
        try {
          // Inside the cleanup guard, not before it. Since ADR 0012 removed the
          // resolve-anything fallback, `agentLaunchSpec` rejects an unmapped command
          // by throwing, and by this point the request's files and secrets are
          // already on disk — so a throw with the spec built OUTSIDE the guard would
          // leave them there.
          //
          // No request can reach that throw today: `validateSpawnRequest` bounds
          // `command` to the same two names before anything is materialized, which
          // is also why this has no test driving it. The two lists are the point.
          // They are maintained separately on purpose — one guards the socket, one
          // guards the exported function — so they can disagree, and the day they do
          // is the day this matters. Cheap enough to hold the guard open for.
          if (request.kind === 'trusted-cli') trustedCliFailurePhase = 'launch-spec';
          const spec =
            request.kind === 'agent'
              ? agentLaunchSpec(
                  { ...request, args: materialized.args },
                  { ...options, connectorUrl },
                )
              : trustedCliLaunchSpec(
                  {
                    ...request,
                    args: materialized.args,
                    ...(materialized.entrySandbox === undefined
                      ? {}
                      : { entrySandbox: materialized.entrySandbox }),
                  },
                  options,
                );
          if (request.kind === 'trusted-cli') trustedCliFailurePhase = 'spawn';
          child = spawnChild(spec.command, spec.args, spec.spawnOptions);
        } catch (error) {
          throw leakOutranks(await materialized.cleanup(), error);
        }
        const pendingFrames = [];
        let childClosed = false;
        let resolveClosed = () => undefined;
        const closed = new Promise((resolve) => (resolveClosed = resolve));
        let pendingSignal;
        const stop = (signal) => {
          pendingSignal = signal;
          stopAgentProcessGroup(child, signal);
        };
        childRecord = { child, closed, stop };
        children.set(child, childRecord);
        child.once('spawn', () => {
          if (pendingSignal !== undefined) child.kill(pendingSignal);
        });
        // Registered before the rejection handler below, so this containment is
        // always under way by the time the spawn rejection is handled.
        let spawnErrorCleanup;
        child.once('error', () => (spawnErrorCleanup = materialized.cleanup()));
        const relay = (kind, chunk) => {
          const frame = { ok: true, kind, data: chunk.toString('base64') };
          if (!accepted) pendingFrames.push(frame);
          else if (!send(socket, frame)) {
            child.stdout?.pause();
            child.stderr?.pause();
          }
        };
        child.stdout?.on('data', (chunk) => relay('stdout', chunk));
        child.stderr?.on('data', (chunk) => relay('stderr', chunk));
        if (request.kind === 'trusted-cli') {
          child.once('exit', () => killExitedTrustedCliProcessGroup(child));
        }
        child.once('close', (code, signal) => {
          childClosed = true;
          children.delete(child);
          const exitFrame = { ok: true, kind: 'exit', code, signal };
          const deliver = (frame) => {
            // `accepted` is the whole guard against a child that never started
            // reporting success. A spawn failure emits `error` then `close`, so
            // this runs for it too and can queue an exit frame — but the spawn
            // rejection below throws before `accepted` is ever set, and queued
            // frames are flushed at exactly one place, after that assignment.
            // The frame is therefore dropped with the request, and the caller
            // hears the spawn failure. Keep that flush the only one.
            if (!accepted) pendingFrames.push(frame);
            else {
              send(socket, frame);
              socket.end();
            }
            resolveClosed();
          };
          if (request.kind === 'trusted-cli') {
            // A file-injected secret must be gone before its exit frame crosses
            // back: the caller is free to start the next run the moment it sees
            // that frame, and the `wx` guard would refuse it over this run's own
            // leftover. cleanup() never rejects, so this cannot strand the frame.
            void materialized.cleanup().then((contained) =>
              deliver(
                contained
                  ? exitFrame
                  : // Containment failed outright, so the credential is still
                    // sitting at a path the agent knows and owns. Reporting the
                    // command's own clean exit here would hide that. The
                    // supervisor turns `ok: false` into a failed run carrying
                    // this reason, which is what gets the secret rotated.
                    { ok: false, error: TRUSTED_CLI_SECRET_LEAK_ERROR },
              ),
            );
          } else {
            deliver(exitFrame);
            void materialized.cleanup();
          }
        });
        await new Promise((resolveSpawn, rejectSpawn) => {
          child.once('spawn', resolveSpawn);
          child.once('error', rejectSpawn);
        }).catch(async (error) => {
          throw leakOutranks(await spawnErrorCleanup, error);
        });
        if (closing || connectionClosed) {
          stop('SIGKILL');
          throw new Error('agent spawn request was detached');
        }
        accepted = true;
        if (childClosed) children.delete(child);
        socket.on('drain', () => {
          child.stdout?.resume();
          child.stderr?.resume();
        });
        send(socket, {
          ok: true,
          kind: 'spawned',
          pid: child.pid,
        });
        for (const frame of pendingFrames) send(socket, frame);
        if (childClosed) socket.end();
        return;
      }
      if (!isObject(raw) || raw.protocolVersion !== AGENT_SPAWN_PROTOCOL_VERSION) {
        throw new Error('invalid agent control request');
      }
      if (raw.kind === 'stdin' && typeof raw.data === 'string') {
        if (child.stdin?.write(decode(raw.data)) === false) {
          socket.pause();
          child.stdin.once('drain', () => socket.resume());
        }
      } else if (raw.kind === 'close-stdin') child.stdin?.end();
      else if (raw.kind === 'signal' && ['SIGTERM', 'SIGKILL'].includes(raw.signal))
        childRecord.stop(raw.signal);
      else throw new Error('invalid agent control request');
    };
    socket.on('data', (chunk) => {
      if (buffered.length + chunk.length > maxFrameBytes) {
        fail(new Error('agent broker frame too large'));
        socket.destroy();
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        processing = processing.then(async () => await handle(JSON.parse(line))).catch(fail);
      }
    });
    socket.once('close', () => {
      connectionClosed = true;
      childRecord?.stop('SIGKILL');
    });
  });
  const previousUmask = process.umask(0o077);
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, resolveListen);
    });
  } finally {
    process.umask(previousUmask);
  }
  const socketOwnership = brokerSocketOwnership(options);
  if (socketOwnership.uid !== undefined && socketOwnership.gid !== undefined) {
    await chown(socketPath, socketOwnership.uid, socketOwnership.gid);
  }
  await chmod(socketPath, socketOwnership.mode);
  return {
    socketPath,
    async close() {
      closing = true;
      const running = [...children.values()];
      for (const record of running) record.stop('SIGTERM');
      const escalation = setTimeout(() => {
        for (const record of running) {
          if (record.child.exitCode === null) record.stop('SIGKILL');
        }
      }, options.shutdownGraceMs ?? 5_000);
      await Promise.all(running.map((record) => record.closed));
      clearTimeout(escalation);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
      await rm(socketPath, { force: true });
      await lock.close();
    },
  };
}

export async function probeAgentSpawnBroker(controlDir = DEFAULT_CONTROL_DIR, timeoutMs = 1_000) {
  const socketPath = join(resolve(controlDir), 'agent-spawn-broker.sock');
  return await new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    let response = '';
    let finished = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (live) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(live);
    };
    socket.once('error', () => finish(false));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response);
        finish(parsed?.ok === true && parsed.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION);
      } catch {
        finish(false);
      }
    });
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ protocolVersion: AGENT_SPAWN_PROTOCOL_VERSION, kind: 'status' })}\n`,
      );
    });
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeDir = process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const controlDir = process.env.VERITY_AGENT_BROKER_RUNTIME ?? DEFAULT_CONTROL_DIR;
  // A flag, not a path: the control-plane Runner launcher sets it because that
  // container mounts `verity-data:sessions` at SHARED_SESSION_ROOT. Project
  // Sandboxes leave it unset and keep the single `/work` tree they have always
  // had. Nothing here reads a directory name from the environment, so no value
  // this variable can carry widens the guard beyond that one literal root.
  const sharedSessionRoot =
    process.env.VERITY_AGENT_SHARED_SESSION_ROOT === '1' ||
    process.env.VERITY_AGENT_SHARED_SESSION_ROOT === 'true'
      ? SHARED_SESSION_ROOT
      : undefined;
  const launch =
    process.argv[2] === '--probe'
      ? probeAgentSpawnBroker(controlDir)
      : runAgentSpawnBroker({
          runtimeDir,
          controlDir,
          ...(sharedSessionRoot === undefined ? {} : { sharedSessionRoot }),
          agentUid: Number(process.env.VERITY_AGENT_UID ?? 1000),
          agentGid: Number(process.env.VERITY_AGENT_GID ?? 1000),
          runnerUid: Number(process.env.VERITY_RUNNER_RUNTIME_UID ?? 1101),
          runnerGid: Number(process.env.VERITY_RUNNER_RUNTIME_GID ?? 1101),
          // ADR 0006 Amendment 1. Set by `verity-control-plane-runner-start` and
          // by nothing else — but a project image CAN declare the same name, so
          // the value is re-checked against the mounted inode here rather than
          // trusted. See {@link resolveDockerGid}: no socket owned by the claimed
          // group, no grant, which is every project Sandbox.
          ...(() => {
            const dockerGid = resolveDockerGid(process.env, (path) => statSync(path).gid);
            return dockerGid === undefined ? {} : { dockerGid };
          })(),
          // Thread the broker's own (container-provided) environment into the
          // Claude child through the `childEnvironment` allowlist. The container
          // sets CLAUDE_CONFIG_DIR=/run/verity-runner/claude on the
          // runner-supervisor path; without this the allowlisted copy() has no
          // source and Claude never sees the config dir, so its transcript would
          // land off the shared mount. The allowlist bounds exposure to the
          // vetted keys only — inherited OAuth/API/egress secrets never cross
          // (see the "passes only the local Claude connector coordinates" test).
          env: process.env,
        });
  launch
    .then((broker) => {
      if (typeof broker === 'boolean') {
        process.exitCode = broker ? 0 : 1;
        return;
      }
      const shutdown = () => void broker.close().finally(() => process.exit(0));
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((error) => {
      process.stderr.write(
        `verity-agent-spawn-broker: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
