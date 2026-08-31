#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const worktree = process.env.VERITY_LIVE_SMOKE_WORKTREE ?? '/work';
const claudeHome = process.env.CLAUDE_CONFIG_DIR;
if (claudeHome === undefined) throw new Error('missing CLAUDE_CONFIG_DIR');

/** @param {string} name @returns {string | undefined} */
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  if (index !== -1) return process.argv[index + 1];
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
};
const resumeId = argumentValue('--resume');
const resumed = resumeId !== undefined;
const sessionId = resumeId ?? argumentValue('--session-id');
if (sessionId === undefined) throw new Error('missing ACP-assigned Claude session id');
const transcriptFile = join(
  claudeHome,
  'projects',
  worktree.replaceAll('/', '-'),
  `${sessionId}.jsonl`,
);
const seedLine = JSON.stringify({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: worktree,
  sessionId,
  version: 'recreate-smoke',
  type: 'user',
  message: { role: 'user', content: 'seed before sandbox recreate' },
  uuid: '00000000-0000-4000-8000-000000000010',
  timestamp: '2026-08-13T00:00:00.000Z',
});
const resumedLine = JSON.stringify({
  parentUuid: '00000000-0000-4000-8000-000000000010',
  isSidechain: false,
  cwd: worktree,
  sessionId,
  version: 'recreate-smoke',
  type: 'assistant',
  message: {
    id: 'after-recreate-transcript',
    type: 'message',
    role: 'assistant',
    model: 'smoke',
    content: [{ type: 'text', text: 'after sandbox recreate' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 3 },
  },
  uuid: '00000000-0000-4000-8000-000000000016',
  timestamp: '2026-08-13T00:00:01.000Z',
});

const forbiddenEnvironment = ['ANTHROPIC_API_KEY', 'DOPPLER_TOKEN', 'GITHUB_TOKEN'].filter(
  (name) => process.env[name] !== undefined,
);
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const expectedPlaceholder = 'verity-claude-egress-placeholder-v1';
if (
  forbiddenEnvironment.length > 0 ||
  (oauthToken !== undefined && oauthToken !== expectedPlaceholder)
) {
  throw new Error(
    `unsafe agent environment: ${JSON.stringify({
      forbiddenEnvironment,
      oauthToken: oauthToken === undefined ? 'absent' : 'unexpected',
    })}`,
  );
}

await mkdir(dirname(transcriptFile), { recursive: true });
if (resumed) {
  const restored = await readFile(transcriptFile, 'utf8');
  if (restored !== `${seedLine}\n`) {
    throw new Error(`unexpected restored transcript: ${JSON.stringify(restored)}`);
  }
  const databaseEnvironment = Object.keys(process.env).filter((name) =>
    /(?:DATABASE|POSTGRES|_DB_)/u.test(name),
  );
  if (databaseEnvironment.length > 0) {
    throw new Error(`database environment reached Claude: ${databaseEnvironment.join(',')}`);
  }
  await appendFile(transcriptFile, `${resumedLine}\n`);
  await writeFile(
    join(worktree, 'recreate-observed.json'),
    `${JSON.stringify({ resumeId: sessionId, restored, databaseEnvironment })}\n`,
  );
} else {
  await writeFile(transcriptFile, `${seedLine}\n`, { mode: 0o600 });
}

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null;
emit({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'oauth',
  claude_code_version: 'recreate-smoke',
  cwd: worktree,
  tools: [],
  mcp_servers: [],
  model: 'smoke',
  permissionMode: 'default',
  slash_commands: [],
  output_style: 'default',
  skills: [],
  plugins: [],
  uuid: '00000000-0000-4000-8000-000000000011',
  session_id: sessionId,
});
if (resumed) {
  emit({
    type: 'user',
    message: { role: 'user', content: 'seed before sandbox recreate' },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000010',
    session_id: sessionId,
  });
}

// claude-agent-acp queues session/prompt until the SDK-side Claude process has
// completed its initialize exchange and received the stream-json user frame.
if (process.argv.includes('--input-format') && process.argv.includes('stream-json')) {
  process.stdin.setEncoding('utf8');
  let bufferedInput = '';
  let receivedUserPrompt = false;
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string') continue;
    bufferedInput += chunk;
    for (;;) {
      const newline = bufferedInput.indexOf('\n');
      if (newline < 0) break;
      const line = bufferedInput.slice(0, newline).trim();
      bufferedInput = bufferedInput.slice(newline + 1);
      if (line.length === 0) continue;
      const frame = /** @type {unknown} */ (JSON.parse(line));
      if (!isRecord(frame)) continue;
      const request = frame.request;
      if (
        frame.type === 'control_request' &&
        typeof frame.request_id === 'string' &&
        isRecord(request) &&
        request.subtype === 'initialize'
      ) {
        emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: frame.request_id,
            response: {
              commands: [],
              agents: [],
              output_style: 'default',
              available_output_styles: ['default'],
              models: [
                {
                  value: 'smoke',
                  displayName: 'Smoke',
                  description: 'Deterministic recreate-smoke model',
                },
              ],
              account: { apiKeySource: 'oauth', apiProvider: 'firstParty' },
            },
            pending_permission_requests: [],
            pending_user_dialog_requests: [],
          },
        });
      } else if (
        frame.type === 'control_request' &&
        typeof frame.request_id === 'string' &&
        isRecord(request) &&
        request.subtype === 'get_context_usage'
      ) {
        emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: frame.request_id,
            response: {
              categories: [],
              totalTokens: 1,
              maxTokens: 200_000,
              rawMaxTokens: 200_000,
              percentage: 0,
              gridRows: [],
              model: 'smoke',
              memoryFiles: [],
              mcpTools: [],
            },
          },
        });
      } else if (frame.type === 'user') {
        receivedUserPrompt = true;
        break;
      }
    }
    if (receivedUserPrompt) break;
  }
  if (!receivedUserPrompt) throw new Error('stream-json input ended before a user prompt');
}
emit({
  type: 'assistant',
  message: {
    id: resumed ? 'after-recreate' : 'before-recreate',
    type: 'message',
    role: 'assistant',
    model: 'smoke',
    content: [
      {
        type: 'text',
        text: resumed ? 'after sandbox recreate' : 'before sandbox recreate',
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
    },
  },
  parent_tool_use_id: null,
  uuid: resumed ? '00000000-0000-4000-8000-000000000013' : '00000000-0000-4000-8000-000000000012',
  session_id: sessionId,
});
emit({
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: resumed ? 'after sandbox recreate' : 'before sandbox recreate',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: {
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 3,
  },
  modelUsage: {},
  permission_denials: [],
  uuid: resumed ? '00000000-0000-4000-8000-000000000015' : '00000000-0000-4000-8000-000000000014',
  session_id: sessionId,
});
