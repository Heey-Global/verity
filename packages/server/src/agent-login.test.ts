import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProcessAgentLoginService,
  type AgentLoginPublic,
  type AgentLoginService,
} from './agent-login.js';
import type { VeritySettingsPatch } from '@verity/store';

const originalPath = process.env.PATH;

let tempRoot: string;
let service: AgentLoginService;
let updates: VeritySettingsPatch[];

async function waitForSession(
  sessionId: string,
  predicate: (session: AgentLoginPublic) => boolean,
): Promise<AgentLoginPublic> {
  let last: AgentLoginPublic | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await service.get(sessionId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for login session; last=${JSON.stringify(last)}`);
}

function claudeCredentialsPatch(token = 'claude-access-fixture'): VeritySettingsPatch {
  return {
    claudeCodeOauthCredentialsJson: JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: 'claude-refresh-token',
        expiresAt: 4102444800000,
      },
    }),
  };
}

function installFakeScript(): void {
  const bin = join(tempRoot, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'script');
  const expect = join(bin, 'expect');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const commandIndex = args.indexOf('-c');
const command = commandIndex >= 0 ? args[commandIndex + 1] ?? '' : '';
const transcriptPath = args[args.length - 1];
const mode = process.env.VERITY_FAKE_AGENT_LOGIN_MODE ?? 'success';

function writeClaudeCredentials(token) {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: 'claude-refresh-token',
        expiresAt: 4102444800000,
      },
    }),
  );
}

if (command.includes('codex')) {
  console.log('Open https://auth.openai.com/codex/device');
  console.log('Your device code is ABCD-12345');
  setTimeout(() => {
    if (mode !== 'missing-codex-auth') {
      mkdirSync(process.env.CODEX_HOME, { recursive: true });
      writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ refresh_token: 'codex-refresh' }));
    }
    process.exit(0);
  }, 75);
} else if (command.includes('claude')) {
  if (mode === 'wrapped-claude-url') {
    console.log('https://claude.com/cai/oauth/authorize?code=true&client_id=abc');
    setTimeout(() => console.log('&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference'), 25);
    setTimeout(() => console.log('&code_challenge=challenge&code_challenge_method=S256&state=state'), 50);
  } else if (mode === 'claude-terminal-wrapped-url') {
    process.stdout.write('Browser did not open? Use the url below to sign in\\r\\r\\n\\r\\r\\n');
    process.stdout.write('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\\r\\r\\n');
    setTimeout(() => process.stdout.write('ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co\\r\\r\\n'), 25);
    setTimeout(() => process.stdout.write('m%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge\\r\\r\\n'), 50);
    setTimeout(() => process.stdout.write('&code_challenge_method=S256&state=state\\r\\r\\n\\r\\r\\nPaste code here if prompted >'), 75);
  } else {
    console.log('Open https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state');
  }
  process.stdin.setEncoding('utf8');
  let claudeBuffer = '';
  process.stdin.on('data', (chunk) => {
    claudeBuffer += chunk;
    console.log('received ' + chunk.trim());
    if (mode === 'require-claude-newline' && !claudeBuffer.includes('\\n')) return;
    if (mode === 'require-claude-eof' && !claudeBuffer.includes('\u0004')) return;
    if (mode === 'require-claude-close') return;
    if (mode !== 'missing-claude-token') {
      const token = mode === 'claude-versioned-token' ? 'claude-access-v1-fixture' : 'claude-access-fixture';
      writeClaudeCredentials(token);
      if (mode === 'claude-versioned-wrapped-token') {
        writeFileSync(transcriptPath, 'Claude auth output:\\nclaude-access-part-one\\npart-two\\nStore this token securely');
        console.log('Claude auth output:');
        console.log('claude-access-part-one');
        console.log('part-two');
      } else if (mode === 'claude-terminal-reflowed-token') {
        writeFileSync(
          transcriptPath,
          'Claude auth output:\\n\\u001b[1C\\u001b[1Bs\\u001b[4G-ant-oat01-token_first\\u001b[49Gpart-two\\n\\u001b[1C\\u001b[1Bpart-three\\u001b[25Gpart-four\\nStore this token securely',
        );
        console.log('Claude auth output:');
        console.log('claude-access-part-onepart-two');
        console.log('part-threepart-four');
      } else {
        writeFileSync(transcriptPath, token);
        console.log(token);
      }
    }
    setTimeout(() => process.exit(0), 25);
  });
  process.stdin.on('end', () => {
    if (mode !== 'require-claude-close') return;
    const token = mode === 'claude-versioned-token' ? 'claude-access-v1-fixture' : 'claude-access-fixture';
    writeFileSync(transcriptPath, token);
    console.log(token);
    setTimeout(() => process.exit(0), 25);
  });
} else {
  console.error('unexpected command: ' + command);
  process.exit(2);
}
`,
    { mode: 0o755 },
  );
  chmodSync(script, 0o755);
  writeFileSync(
    expect,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.VERITY_FAKE_AGENT_LOGIN_MODE ?? 'success';
const transcriptPath = process.env.VERITY_AGENT_LOGIN_TRANSCRIPT;
const expectScript = readFileSync(process.argv[2], 'utf8');

function writeClaudeCredentials(token) {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: 'claude-refresh-token',
        expiresAt: 4102444800000,
      },
    }),
  );
}

if (mode === 'claude-ansi-prompt-pattern' && !expectScript.includes('Paste.*code.*here.*if.*prompted.*>')) {
  console.error('Claude prompt pattern does not tolerate terminal cursor control');
  process.exit(2);
}

if (!expectScript.includes('claude auth login --claudeai')) {
  console.error('Claude login must use auth login');
  process.exit(2);
}

if (process.env.CLAUDE_TEST_LEAK) {
  console.error('Claude login must not inherit server Claude env');
  process.exit(2);
}

if (mode === 'wrapped-claude-url') {
  console.log('https://claude.com/cai/oauth/authorize?code=true&client_id=abc');
  setTimeout(() => console.log('&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference'), 25);
  setTimeout(() => console.log('&code_challenge=challenge&code_challenge_method=S256&state=state'), 50);
} else if (mode === 'claude-terminal-wrapped-url') {
  process.stdout.write('Browser did not open? Use the url below to sign in\\r\\r\\n\\r\\r\\n');
  process.stdout.write('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\\r\\r\\n');
  setTimeout(() => process.stdout.write('ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co\\r\\r\\n'), 25);
  setTimeout(() => process.stdout.write('m%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge\\r\\r\\n'), 50);
  setTimeout(() => process.stdout.write('&code_challenge_method=S256&state=state\\r\\r\\n\\r\\r\\nPaste code here if prompted >'), 75);
} else {
  console.log('Open https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state');
}

process.stdin.setEncoding('utf8');
let claudeBuffer = '';
process.stdin.on('data', (chunk) => {
  claudeBuffer += chunk;
  if (!claudeBuffer.includes('\\n')) return;
  console.log('received ' + claudeBuffer.trim());
  if (mode !== 'missing-claude-token') {
    const token = mode === 'claude-versioned-token' ? 'claude-access-v1-fixture' : 'claude-access-fixture';
    writeClaudeCredentials(token);
    if (mode === 'claude-token-home-file') {
      mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
      writeFileSync(
        join(process.env.CLAUDE_CONFIG_DIR, 'credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: token,
            refreshToken: 'claude-refresh-token',
            expiresAt: 4102444800000,
          },
        }),
      );
    } else {
      if (mode === 'claude-versioned-wrapped-token') {
        if (transcriptPath) {
          writeFileSync(
            transcriptPath,
            'Claude auth output:\\nclaude-access-part-one\\npart-two\\nStore this token securely',
          );
        }
        console.log('Claude auth output:');
        console.log('claude-access-part-one');
        console.log('part-two');
      } else if (mode === 'claude-terminal-reflowed-token') {
        if (transcriptPath) {
          writeFileSync(
            transcriptPath,
            'Claude auth output:\\n\\u001b[1C\\u001b[1Bs\\u001b[4G-ant-oat01-token_first\\u001b[49Gpart-two\\n\\u001b[1C\\u001b[1Bpart-three\\u001b[25Gpart-four\\nStore this token securely',
          );
        }
        console.log('Claude auth output:');
        console.log('claude-access-part-onepart-two');
        console.log('part-threepart-four');
      } else {
        if (transcriptPath) writeFileSync(transcriptPath, token);
        if (mode !== 'claude-token-transcript-only') console.log(token);
      }
    }
  }
  setTimeout(() => process.exit(0), 25);
});
`,
    { mode: 0o755 },
  );
  chmodSync(expect, 0o755);
  for (const command of ['claude', 'codex']) {
    const executable = join(bin, command);
    writeFileSync(executable, '#!/bin/sh\necho fake ' + command + '\n');
    chmodSync(executable, 0o755);
  }
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
}

describe('createProcessAgentLoginService', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-agent-login-test-'));
    updates = [];
    installFakeScript();
    service = createProcessAgentLoginService({
      updateSettings: async (patch) => {
        updates.push(patch);
      },
    });
  });

  afterEach(() => {
    service?.close();
    process.env.PATH = originalPath;
    delete process.env.VERITY_FAKE_AGENT_LOGIN_MODE;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('automates Codex device login and stores auth.json', async () => {
    const started = await service.start('codex');

    expect(started.provider).toBe('codex');
    expect(started.verificationUri).toBeNull();
    expect(started.userCode).toBeNull();
    expect(started.needsCode).toBe(false);

    const ready = await waitForSession(
      started.sessionId,
      (session) => session.status === 'ready' && session.userCode === 'ABCD-12345',
    );
    expect(ready.verificationUri).toBe('https://auth.openai.com/codex/device');

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete).toMatchObject({
      provider: 'codex',
      status: 'complete',
      userCode: 'ABCD-12345',
      configured: true,
      message: null,
    });
    expect(updates).toEqual([{ codexAuthJson: '{"refresh_token":"codex-refresh"}' }]);
  });

  it('waits for the complete streamed Claude OAuth URL before becoming ready', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'wrapped-claude-url';

    const started = await service.start('claude');
    expect(started.verificationUri).toBeNull();

    const ready = await waitForSession(
      started.sessionId,
      (session) =>
        session.status === 'ready' &&
        session.verificationUri?.includes('redirect_uri=') === true &&
        session.verificationUri?.includes('code_challenge=') === true &&
        session.verificationUri?.includes('state=') === true,
    );
    expect(ready.verificationUri).toContain('https://claude.com/cai/oauth/authorize?code=true');
    expect(ready.verificationUri).toContain('redirect_uri=');
    expect(ready.verificationUri).toContain('code_challenge=');
    expect(ready.verificationUri).toContain('state=');
  });

  it('reassembles Claude terminal-wrapped OAuth URLs before becoming ready', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'claude-terminal-wrapped-url';

    const started = await service.start('claude');
    expect(started.verificationUri).toBeNull();

    const ready = await waitForSession(
      started.sessionId,
      (session) =>
        session.status === 'ready' &&
        session.verificationUri?.includes('redirect_uri=') === true &&
        session.verificationUri?.includes('code_challenge=') === true &&
        session.verificationUri?.includes('state=') === true,
    );
    expect(ready.verificationUri).toContain('https://claude.com/cai/oauth/authorize?code=true');
    expect(ready.verificationUri).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(ready.verificationUri).toContain('redirect_uri=https%3A%2F%2Fplatform.claude.com');
  });

  it('sends Claude auth login codes after ANSI-rendered Claude prompts', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'claude-ansi-prompt-pattern';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete.configured).toBe(true);
    expect(updates).toEqual([claudeCredentialsPatch()]);
  });

  it('drives Claude auth login through the expect-controlled PTY', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'success';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete.configured).toBe(true);
    expect(updates).toEqual([claudeCredentialsPatch()]);
  });

  it('isolates Claude auth login from server Claude env', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'success';
    process.env.CLAUDE_TEST_LEAK = 'server-env';
    try {
      const started = await service.start('claude');
      const ready = await waitForSession(
        started.sessionId,
        (session) => session.status === 'ready',
      );
      expect(ready.verificationUri).toContain('https://claude.com/cai/oauth/authorize?code=true');

      await service.submitCode(started.sessionId, ' claude-returned-code ');
      const complete = await waitForSession(
        started.sessionId,
        (session) => session.status === 'complete',
      );

      expect(complete.configured).toBe(true);
      expect(updates).toEqual([claudeCredentialsPatch()]);
    } finally {
      delete process.env.CLAUDE_TEST_LEAK;
    }
  });

  it('reads Claude auth login credentials from the transcript file', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'claude-token-transcript-only';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete.configured).toBe(true);
    expect(updates).toEqual([claudeCredentialsPatch()]);
  });

  it('reads versioned Claude auth login credentials from the transcript file', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'claude-versioned-token';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete.configured).toBe(true);
    expect(updates).toEqual([claudeCredentialsPatch('claude-access-v1-fixture')]);
  });

  it('joins wrapped versioned Claude auth login credentials from the transcript file', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'claude-versioned-wrapped-token';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete.configured).toBe(true);
    expect(updates).toEqual([claudeCredentialsPatch()]);
  });

  it('reconstructs Claude auth login credentials from terminal cursor reflow', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'claude-terminal-reflowed-token';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete.configured).toBe(true);
    expect(updates).toEqual([claudeCredentialsPatch()]);
  });

  it('reads Claude auth login credentials from the isolated Claude home', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'claude-token-home-file';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete.configured).toBe(true);
    expect(updates).toEqual([claudeCredentialsPatch()]);
  });

  it('automates Claude auth login login after the user submits the returned code', async () => {
    const started = await service.start('claude');

    expect(started.provider).toBe('claude');
    expect(started.needsCode).toBe(true);

    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    const waiting = await service.submitCode(started.sessionId, ' claude-returned-code ');
    expect(['waiting', 'complete']).toContain(waiting.status);

    const complete = await waitForSession(
      started.sessionId,
      (session) => session.status === 'complete',
    );

    expect(complete).toMatchObject({
      provider: 'claude',
      status: 'complete',
      configured: true,
      message: null,
    });
    expect(updates).toEqual([claudeCredentialsPatch()]);
  });

  it('surfaces missing Codex auth output as a failed login', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'missing-codex-auth';

    const started = await service.start('codex');
    const failed = await waitForSession(
      started.sessionId,
      (session) => session.status === 'failed',
    );

    expect(failed.message).toContain('Codex login did not produce auth.json');
    expect(updates).toEqual([]);
  });

  it('surfaces missing Claude credentials JSON as a failed login', async () => {
    process.env.VERITY_FAKE_AGENT_LOGIN_MODE = 'missing-claude-token';

    const started = await service.start('claude');
    const ready = await waitForSession(started.sessionId, (session) => session.status === 'ready');
    expect(ready.verificationUri).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state',
    );

    await service.submitCode(started.sessionId, ' claude-returned-code ');
    const failed = await waitForSession(
      started.sessionId,
      (session) => session.status === 'failed',
    );

    expect(failed.message).toContain('Claude login did not produce credentials.json');
    expect(updates).toEqual([]);
  });

  it('reports when the server image is missing expect for Claude login', async () => {
    rmSync(join(tempRoot, 'bin', 'expect'), { force: true });
    writeFileSync(join(tempRoot, 'bin', 'sh'), '#!/bin/sh\nexec /bin/sh "$@"\n');
    chmodSync(join(tempRoot, 'bin', 'sh'), 0o755);
    process.env.PATH = join(tempRoot, 'bin');

    const started = await service.start('claude');

    expect(started).toMatchObject({
      provider: 'claude',
      status: 'failed',
      configured: false,
      message:
        'expect is not installed in this Verity server image. Rebuild/redeploy the server image and try again.',
    });
  });

  it('rejects invalid code submissions before writing to the login process', async () => {
    const started = await service.start('codex');

    await expect(service.submitCode(started.sessionId, 'ABCD')).rejects.toThrow(
      'provider does not accept a pasted code',
    );
    await expect(service.submitCode('missing', 'ABCD')).rejects.toThrow('login session not found');
  });

  it('requires a non-empty Claude code for active sessions', async () => {
    const started = await service.start('claude');

    await expect(service.submitCode(started.sessionId, '   ')).rejects.toThrow('code is required');
  });
});
