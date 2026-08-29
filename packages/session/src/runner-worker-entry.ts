import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentUpload } from '@verity/events';
import {
  isRunnerSupervisorBackend,
  type Backend,
  type RunnerSupervisorBackend,
} from './backend.js';
import { AcpClaudeBackend } from './acp-claude-backend.js';
import { AcpCodexBackend } from './acp-codex-backend.js';
import { AcpOpenCodeBackend } from './acp-opencode-backend.js';
import { createBrokerSpawner } from './broker-spawner.js';
import { RunnerServer } from './runner-server.js';

type StartTurnRequest = {
  protocolVersion: 1;
  kind: 'start-turn';
  turnId: string;
  startCommandId: string;
  sessionId: string;
  backend: RunnerSupervisorBackend;
  worktree: string;
  cwd: string;
  prompt: string;
  attachments?: AttachmentUpload[];
  model?: string;
  steerable: boolean;
  permissionControl: boolean;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutMs?: number;
  trustedCliExecution?: boolean;
  /** Per-turn bearer for the loopback MCP gateway (ADR 0014 D1). ACP only: the
   *  endpoint itself comes from the Sandbox's own broker environment. */
  mcpGatewayToken?: string;
  /** Verity's own per-turn runtime context (VERITY_SESSION_*), allowlisted by the
   *  client. Never the Server's ambient environment — the worker keeps the Sandbox's
   *  own env as the base and merges only these keys on top. */
  sessionEnv?: Record<string, string>;
};

const requestPath = process.argv[2];
const turnDir = process.env.VERITY_RUNNER_TURN_DIR;
if (requestPath === undefined || turnDir === undefined) {
  throw new Error('runner worker requires request path and turn directory');
}
const request = JSON.parse(await readFile(requestPath, 'utf8')) as StartTurnRequest;
if (
  request.protocolVersion !== 1 ||
  request.kind !== 'start-turn' ||
  !isRunnerSupervisorBackend(request.backend)
) {
  throw new Error('runner worker received an unsupported request');
}
if (
  request.trustedCliExecution === true &&
  request.backend !== 'claude-acp' &&
  request.backend !== 'codex-acp'
) {
  throw new Error('trusted CLI execution requires a supported brokered-tool backend');
}
// Brokered tools are exposed only through the ACP MCP gateway — and, within ACP,
// only to the agents admitted to it. `opencode-acp` is an ACP backend and is
// deliberately not one of them (see `carriesBrokeredSecretTools` in conductor.ts),
// so both gates above name their members rather than asking whether the transport
// is ACP: the two questions have the same answer today only by decision.
if (
  request.mcpGatewayToken !== undefined &&
  request.backend !== 'claude-acp' &&
  request.backend !== 'codex-acp'
) {
  throw new Error('the MCP gateway bearer is not supported by this runner backend');
}
// Validate independently of the client: this process trusts the request file only as
// far as it can re-check it. Anything outside the VERITY_SESSION_* allowlist would be
// an attempt to push Server-side environment across the Sandbox boundary.
if (request.sessionEnv !== undefined) {
  const entries = Object.entries(request.sessionEnv);
  if (
    entries.length > 8 ||
    entries.some(
      ([key, value]) =>
        !['VERITY_SESSION_BACKEND', 'VERITY_SESSION_MODEL'].includes(key) ||
        typeof value !== 'string' ||
        value.length > 256,
    )
  ) {
    throw new Error('runner worker received an unsupported session env');
  }
}
const mcpGatewayUrl = process.env.VERITY_MCP_GATEWAY_URL;
// A bearer is the Server's decision that this turn is entitled to brokered tools.
// Without a URL to redeem it against, the container is misprovisioned and no retry or
// prompt can recover. Fail closed instead of silently starting a tool-less agent;
// empty counts as absent, matching `supervisorWorkerEnv`.
if (
  request.mcpGatewayToken !== undefined &&
  (mcpGatewayUrl === undefined || mcpGatewayUrl === '')
) {
  throw new Error(
    'the MCP gateway bearer has no VERITY_MCP_GATEWAY_URL to redeem it against; the runner container was provisioned without the gateway URL',
  );
}
const brokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
if (brokerSocket === undefined) throw new Error('runner worker requires the agent spawn broker');
const backends: Readonly<Record<RunnerSupervisorBackend, () => Backend>> = {
  'claude-acp': () => new AcpClaudeBackend(),
  'codex-acp': () => new AcpCodexBackend(),
  'opencode-acp': () => new AcpOpenCodeBackend(),
};
const server = new RunnerServer(backends[request.backend]());
const turn = await server.run(join(turnDir, 'events.jsonl'), {
  turnId: request.turnId,
  controlSocketPath: join(turnDir, 'control.sock'),
  exclusiveEventFile: true,
  terminalizeErrors: true,
  worktree: request.worktree,
  cwd: request.cwd,
  prompt: request.prompt,
  storeSessionId: request.sessionId,
  // Inline image attachments ride the backend's prompt path as one image content
  // block per upload. Omitted entirely when absent so an attachment-free turn is
  // unchanged.
  ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
  ...(request.model !== undefined ? { model: request.model } : {}),
  steerable: request.steerable,
  permissionControl: request.permissionControl,
  ...(request.appendSystemPrompt !== undefined
    ? { appendSystemPrompt: request.appendSystemPrompt }
    : {}),
  ...(request.resumeSessionId !== undefined ? { resumeSessionId: request.resumeSessionId } : {}),
  ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
  ...(request.allowedTools !== undefined ? { allowedTools: request.allowedTools } : {}),
  ...(request.disallowedTools !== undefined ? { disallowedTools: request.disallowedTools } : {}),
  ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  // The Sandbox's own environment stays the base; only Verity's per-turn runtime
  // context is layered on, so in-Sandbox helpers resolve this turn's backend/model.
  ...(request.sessionEnv !== undefined ? { env: { ...process.env, ...request.sessionEnv } } : {}),
  // The gateway URL is the Sandbox's view of the Server's project-bound broker; it is
  // provisioned into the container, never carried by the request. A bearer without a
  // URL was refused above, so this condition can no longer make a turn run tool-less.
  ...(request.mcpGatewayToken !== undefined && mcpGatewayUrl !== undefined
    ? { mcpGateway: { url: mcpGatewayUrl, token: request.mcpGatewayToken } }
    : {}),
  spawner: createBrokerSpawner(brokerSocket),
});
const result = await turn.result;
process.exitCode = result.exitCode;
