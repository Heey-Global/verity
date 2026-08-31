import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VeritySettingsPatch } from '@verity/store';

export type AgentLoginProvider = 'claude' | 'codex';
export type AgentLoginStatus = 'starting' | 'ready' | 'waiting' | 'complete' | 'failed';

export interface AgentLoginPublic {
  sessionId: string;
  provider: AgentLoginProvider;
  status: AgentLoginStatus;
  verificationUri: string | null;
  userCode: string | null;
  needsCode: boolean;
  configured: boolean;
  message: string | null;
}

export interface AgentLoginService {
  start(provider: AgentLoginProvider): Promise<AgentLoginPublic>;
  get(sessionId: string): Promise<AgentLoginPublic>;
  submitCode(sessionId: string, code: string): Promise<AgentLoginPublic>;
  close(): void;
}

export type AgentLoginSettingsUpdater = (patch: VeritySettingsPatch) => Promise<void>;

interface LoginSession {
  id: string;
  provider: AgentLoginProvider;
  status: AgentLoginStatus;
  verificationUri: string | null;
  userCode: string | null;
  needsCode: boolean;
  configured: boolean;
  message: string | null;
  dir: string;
  home: string;
  transcriptPath: string;
  child: ChildProcessWithoutNullStreams | null;
  output: string;
  cleanupTimer: NodeJS.Timeout;
  submitTimer: NodeJS.Timeout | null;
}

const MAX_OUTPUT_CHARS = 48_000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const CLAUDE_CODE_SUBMIT_TIMEOUT_MS = 90 * 1000;
const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';

const CLAUDE_EXPECT_SCRIPT = String.raw`log_user 1
set timeout -1

if {[info exists env(VERITY_AGENT_LOGIN_TRANSCRIPT)]} {
  log_file -a $env(VERITY_AGENT_LOGIN_TRANSCRIPT)
}

spawn claude auth login --claudeai

expect {
  -re {Paste.*code.*here.*if.*prompted.*>} {}
  eof {
    catch wait result
    if {[llength $result] >= 4} { exit [lindex $result 3] }
    exit 1
  }
}

if {[gets stdin code] < 0 || [string trim $code] eq ""} {
  puts stderr "missing Claude setup code from Verity app"
  exit 1
}

send -- "$code\r"
after 250
send -- "\r"
after 750
send -- "\004"

expect {
  eof {
    catch wait result
    if {[llength $result] >= 4} { exit [lindex $result 3] }
    exit 0
  }
}`;

function stripAnsi(value: string): string {
  const esc = String.fromCharCode(27);
  return value
    .replace(new RegExp(esc + '\\[[0-?]*[ -/]*[@-~]', 'g'), '')
    .replace(new RegExp(esc + '[=>]', 'g'), '');
}

function cleanOutput(value: string): string {
  return stripAnsi(value)
    .replace(/\r+\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function isMoreCompleteUrl(candidate: string, current: string | null): boolean {
  if (current === null) return true;
  if (candidate === current) return false;
  if (candidate.length <= current.length) return false;
  if (candidate.startsWith(current)) return true;
  const currentUrl = new URL(current);
  const candidateUrl = new URL(candidate);
  return (
    currentUrl.origin === candidateUrl.origin &&
    currentUrl.pathname === candidateUrl.pathname &&
    !currentUrl.searchParams.has('redirect_uri') &&
    candidateUrl.searchParams.has('redirect_uri')
  );
}

function extractFirstUrl(output: string): string | null {
  const lines = cleanOutput(output).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const index = lines[i]?.indexOf('https://') ?? -1;
    if (index < 0) continue;
    let url = lines[i]!.slice(index).trim();
    for (let j = i + 1; j < lines.length; j += 1) {
      const part = lines[j]!.trim();
      if (part.length === 0) break;
      if (/^[A-Za-z][A-Za-z ]+:/.test(part)) break;
      if (part.includes(' ')) break;
      url += part;
    }
    return url;
  }
  return null;
}

function extractCodexCode(output: string): string | null {
  return cleanOutput(output).match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0] ?? null;
}

function isClaudeLoginUrlReady(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.hostname === 'claude.com' &&
      url.pathname === '/cai/oauth/authorize' &&
      url.searchParams.get('code') === 'true' &&
      url.searchParams.has('redirect_uri') &&
      url.searchParams.has('code_challenge') &&
      url.searchParams.has('state')
    );
  } catch {
    return false;
  }
}

function commandAvailable(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function agentLoginBaseEnv(): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TZ',
    // Test fixture control only; production does not set it.
    'VERITY_FAKE_AGENT_LOGIN_MODE',
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
}

function readCodexAuthJson(session: LoginSession): string | null {
  const paths = [join(session.home, '.codex', 'auth.json'), join(session.home, 'auth.json')];
  for (const file of paths) {
    if (!existsSync(file)) continue;
    const value = readFileSync(file, 'utf8').trim();
    if (value.length > 0) return value;
  }
  return null;
}

function readClaudeCredentialsJson(session: LoginSession): string | null {
  const files = [
    join(session.home, '.claude', '.credentials.json'),
    join(session.home, '.claude', 'credentials.json'),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const value = readFileSync(file, 'utf8').trim();
    if (value.length === 0) continue;
    try {
      JSON.parse(value);
    } catch {
      continue;
    }
    return value;
  }
  return null;
}

function toPublic(session: LoginSession): AgentLoginPublic {
  const verificationUri =
    session.provider === 'claude' && !isClaudeLoginUrlReady(session.verificationUri)
      ? null
      : session.verificationUri;
  return {
    sessionId: session.id,
    provider: session.provider,
    status: session.status,
    verificationUri,
    userCode: session.userCode,
    needsCode: session.needsCode,
    configured: session.configured,
    message: session.message,
  };
}

function markFromOutput(session: LoginSession): void {
  const url = extractFirstUrl(session.output);
  if (url) {
    try {
      if (isMoreCompleteUrl(url, session.verificationUri)) session.verificationUri = url;
    } catch {
      if (!session.verificationUri) session.verificationUri = url;
    }
  }
  if (session.provider === 'codex') {
    session.userCode = session.userCode ?? extractCodexCode(session.output);
    if (session.userCode) session.verificationUri = session.verificationUri ?? CODEX_DEVICE_URL;
  }
  if (
    session.status === 'starting' &&
    session.verificationUri &&
    (session.provider === 'claude'
      ? isClaudeLoginUrlReady(session.verificationUri)
      : session.provider !== 'codex' || session.userCode)
  ) {
    session.status = 'ready';
    session.message = null;
  }
}

export function createProcessAgentLoginService(options: {
  updateSettings: AgentLoginSettingsUpdater;
  sessionTtlMs?: number;
}): AgentLoginService {
  const sessions = new Map<string, LoginSession>();
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;

  const cleanup = (session: LoginSession): void => {
    clearTimeout(session.cleanupTimer);
    if (session.submitTimer) clearTimeout(session.submitTimer);
    if (session.child && session.status !== 'complete') {
      session.child.kill('SIGTERM');
    }
    rmSync(session.dir, { recursive: true, force: true });
  };

  const fail = (session: LoginSession, message: string): void => {
    session.status = 'failed';
    session.message = message;
    if (session.submitTimer) {
      clearTimeout(session.submitTimer);
      session.submitTimer = null;
    }
  };

  const maybeComplete = async (session: LoginSession): Promise<void> => {
    if (session.status === 'complete') return;
    if (session.provider === 'codex') {
      const authJson = readCodexAuthJson(session);
      if (!authJson) return;
      await options.updateSettings({ codexAuthJson: authJson });
    } else {
      const credentialsJson = readClaudeCredentialsJson(session);
      if (!credentialsJson) return;
      await options.updateSettings({
        claudeCodeOauthCredentialsJson: credentialsJson,
      });
    }
    session.status = 'complete';
    session.configured = true;
    session.message = null;
    session.child = null;
    if (session.submitTimer) {
      clearTimeout(session.submitTimer);
      session.submitTimer = null;
    }
    rmSync(session.dir, { recursive: true, force: true });
    clearTimeout(session.cleanupTimer);
  };

  const start = (provider: AgentLoginProvider): Promise<AgentLoginPublic> => {
    const binary = provider === 'codex' ? 'codex' : 'claude';
    if (!commandAvailable(binary)) {
      return Promise.resolve({
        sessionId: randomUUID(),
        provider,
        status: 'failed',
        verificationUri: null,
        userCode: null,
        needsCode: provider === 'claude',
        configured: false,
        message: `${binary} CLI is not installed in this Verity server image. Rebuild/redeploy the server image and try again.`,
      });
    }
    if (provider === 'claude' && !commandAvailable('expect')) {
      return Promise.resolve({
        sessionId: randomUUID(),
        provider,
        status: 'failed',
        verificationUri: null,
        userCode: null,
        needsCode: true,
        configured: false,
        message:
          'expect is not installed in this Verity server image. Rebuild/redeploy the server image and try again.',
      });
    }
    const id = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), `verity-${provider}-login-`));
    const home = join(dir, 'home');
    const transcriptPath = join(dir, 'typescript');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, '.codex'), { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);

    const session: LoginSession = {
      id,
      provider,
      status: 'starting',
      verificationUri: null,
      userCode: null,
      needsCode: provider === 'claude',
      configured: false,
      message: null,
      dir,
      home,
      transcriptPath,
      child: null,
      output: '',
      submitTimer: null,
      cleanupTimer: setTimeout(() => {
        const current = sessions.get(id);
        if (!current || current.status === 'complete') return;
        fail(current, 'Login timed out. Start a new login and try again.');
        cleanup(current);
      }, sessionTtlMs),
    };
    sessions.set(id, session);

    let child: ChildProcessWithoutNullStreams;
    if (provider === 'claude') {
      const expectScriptPath = join(dir, 'claude-login.expect');
      writeFileSync(expectScriptPath, CLAUDE_EXPECT_SCRIPT, { mode: 0o700 });
      chmodSync(expectScriptPath, 0o700);
      child = spawn('expect', [expectScriptPath], {
        env: {
          ...agentLoginBaseEnv(),
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          VERITY_AGENT_LOGIN_TRANSCRIPT: transcriptPath,
          NO_COLOR: '1',
          TERM: process.env.TERM ?? 'xterm-256color',
        },
        cwd: home,
      });
    } else {
      child = spawn('script', ['-q', '-f', '-c', 'codex login --device-auth', transcriptPath], {
        env: {
          ...agentLoginBaseEnv(),
          HOME: home,
          CODEX_HOME: join(home, '.codex'),
          NO_COLOR: '1',
        },
        cwd: home,
      });
    }
    session.child = child;

    const collect = (chunk: Buffer): void => {
      session.output = `${session.output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
      markFromOutput(session);
      if (session.provider === 'codex') {
        void maybeComplete(session).catch((error: unknown) => {
          fail(
            session,
            error instanceof Error ? error.message : 'Could not store login credentials.',
          );
        });
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => fail(session, error.message));
    child.on('exit', () => {
      session.child = null;
      const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '';
      session.output = `${session.output}\n${transcript}`.slice(-MAX_OUTPUT_CHARS);
      markFromOutput(session);
      void maybeComplete(session)
        .then(() => {
          if (session.status !== 'complete' && session.status !== 'failed') {
            fail(
              session,
              session.provider === 'codex'
                ? 'Codex login did not produce auth.json. Start a new login and keep the app open until it completes.'
                : 'Claude login did not produce credentials.json. Paste the code from Claude and wait for completion.',
            );
          }
        })
        .catch((error: unknown) => {
          fail(
            session,
            error instanceof Error ? error.message : 'Could not store login credentials.',
          );
        });
    });

    return Promise.resolve(toPublic(session));
  };

  return {
    start,
    async get(sessionId: string): Promise<AgentLoginPublic> {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('login session not found');
      markFromOutput(session);
      await maybeComplete(session);
      return toPublic(session);
    },
    async submitCode(sessionId: string, code: string): Promise<AgentLoginPublic> {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('login session not found');
      if (session.provider !== 'claude') throw new Error('provider does not accept a pasted code');
      const trimmed = code.trim();
      if (trimmed.length === 0) throw new Error('code is required');
      if (!session.child || session.status === 'failed' || session.status === 'complete') {
        throw new Error('login session is no longer active');
      }
      session.status = 'waiting';
      session.message = null;
      session.child.stdin.end(`${trimmed}\n`);
      if (session.submitTimer) clearTimeout(session.submitTimer);
      session.submitTimer = setTimeout(() => {
        const current = sessions.get(sessionId);
        if (!current || current.status !== 'waiting') return;
        fail(
          current,
          'Claude did not finish the login after the code was submitted. Start a new login and try again.',
        );
      }, CLAUDE_CODE_SUBMIT_TIMEOUT_MS);
      if (typeof session.submitTimer === 'object' && 'unref' in session.submitTimer) {
        session.submitTimer.unref();
      }
      await maybeComplete(session);
      return toPublic(session);
    },
    close(): void {
      for (const session of sessions.values()) cleanup(session);
      sessions.clear();
    },
  };
}
