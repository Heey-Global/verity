#!/usr/bin/env node

import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const worktree = process.env.VERITY_LIVE_SMOKE_WORKTREE ?? '/work';
const continuePath = `${worktree}/continue`;
const invocationPath = `${worktree}/claude-invocations.jsonl`;
const sessionId = 'claude-live-container-session';

const forbiddenEnvironment = ['ANTHROPIC_API_KEY', 'DOPPLER_TOKEN', 'GITHUB_TOKEN'].filter(
  (name) => process.env[name] !== undefined,
);
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const expectedPlaceholder = 'verity-claude-egress-placeholder-v1';
if (
  forbiddenEnvironment.length > 0 ||
  (oauthToken !== undefined && oauthToken !== expectedPlaceholder)
) {
  process.stderr.write(
    `unsafe agent environment: ${JSON.stringify({
      forbiddenEnvironment,
      oauthToken: oauthToken === undefined ? 'absent' : 'unexpected',
    })}\n`,
  );
  process.exit(70);
}

await mkdir(worktree, { recursive: true });
await appendFile(
  invocationPath,
  `${JSON.stringify({
    argv: process.argv.slice(2),
    pid: process.pid,
    credentialBoundary: oauthToken === undefined ? 'no-credentials' : 'non-secret-placeholder',
  })}\n`,
);

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null;
// The SDK waits for Claude's initialization frame before it will forward the
// queued ACP prompt to the process stdin.
emit({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'oauth',
  claude_code_version: 'live-smoke',
  cwd: worktree,
  tools: [],
  mcp_servers: [],
  model: 'smoke',
  permissionMode: 'default',
  slash_commands: [],
  output_style: 'default',
  skills: [],
  plugins: [],
  uuid: '00000000-0000-4000-8000-000000000001',
  session_id: sessionId,
});

// The Agent SDK starts its Claude process while ACP creates the session, before
// `session/prompt`. After the required init handshake, wait for the stream-json
// user message so assistant output belongs to the active turn instead of being
// classified as autonomous pre-turn output.
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
        const requestId = frame.request_id;
        emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: {
              commands: [],
              agents: [],
              output_style: 'default',
              available_output_styles: ['default'],
              models: [
                {
                  value: 'smoke',
                  displayName: 'Smoke',
                  description: 'Deterministic live-smoke model',
                },
              ],
              account: {
                apiKeySource: 'oauth',
                apiProvider: 'firstParty',
              },
            },
            pending_permission_requests: [],
            pending_user_dialog_requests: [],
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
    id: 'before',
    type: 'message',
    role: 'assistant',
    model: 'smoke',
    content: [{ type: 'text', text: 'before server restart' }],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
    },
  },
  parent_tool_use_id: null,
  uuid: '00000000-0000-4000-8000-000000000002',
  session_id: sessionId,
});
await writeFile(`${worktree}/before`, 'ready\n');

for (;;) {
  try {
    await access(continuePath);
    break;
  } catch {
    await setTimeout(25);
  }
}

emit({
  type: 'assistant',
  message: {
    id: 'after',
    type: 'message',
    role: 'assistant',
    model: 'smoke',
    content: [{ type: 'text', text: 'after server restart' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 6,
    },
  },
  parent_tool_use_id: null,
  uuid: '00000000-0000-4000-8000-000000000003',
  session_id: sessionId,
});
emit({
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: 'before server restartafter server restart',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: {
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 6,
  },
  modelUsage: {},
  permission_denials: [],
  uuid: '00000000-0000-4000-8000-000000000004',
  session_id: sessionId,
});
