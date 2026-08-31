import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { attachmentUploadSchema } from '@verity/events';
import { z } from 'zod';
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

const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const boundedString = (max: number): z.ZodString => z.string().max(max);
const startTurnRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal('start-turn'),
    turnId: safeIdSchema,
    startCommandId: safeIdSchema,
    sessionId: safeIdSchema,
    backend: z.enum(['claude-acp', 'codex-acp', 'opencode-acp']),
    worktree: boundedString(4096).refine((value) => value.startsWith('/')),
    cwd: boundedString(4096).refine((value) => value.startsWith('/')),
    prompt: boundedString(1024 * 1024),
    attachments: z.array(attachmentUploadSchema).max(20).optional(),
    model: boundedString(256).optional(),
    steerable: z.boolean(),
    permissionControl: z.boolean(),
    appendSystemPrompt: boundedString(1024 * 1024).optional(),
    resumeSessionId: boundedString(256).optional(),
    permissionMode: boundedString(128).optional(),
    allowedTools: z.array(boundedString(4096)).max(256).optional(),
    disallowedTools: z.array(boundedString(4096)).max(256).optional(),
    timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
    trustedCliExecution: z.boolean().optional(),
    mcpGatewayToken: boundedString(512).min(1).optional(),
    sessionEnv: z
      .strictObject({
        VERITY_SESSION_BACKEND: boundedString(256).optional(),
        VERITY_SESSION_MODEL: boundedString(256).optional(),
      })
      .optional(),
  })
  .superRefine((request, context) => {
    const worktree = resolve(request.worktree);
    const cwd = resolve(request.cwd);
    if (cwd !== worktree && !cwd.startsWith(`${worktree}/`)) {
      context.addIssue({ code: 'custom', message: 'cwd outside worktree', path: ['cwd'] });
    }
  });

type StartTurnRequest = z.infer<typeof startTurnRequestSchema>;

async function consumeStartRequest(path: string): Promise<StartTurnRequest> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    const uid = process.getuid?.();
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o022) !== 0) {
      throw new Error('runner worker received an insecure request file');
    }
    if (stats.size > 16 * 1024 * 1024) {
      throw new Error('runner worker request exceeds size limit');
    }
    // Remove the pathname while retaining the verified inode. No later path lookup
    // can swap the request between validation and use.
    await unlink(path);
    const raw: unknown = JSON.parse(await handle.readFile('utf8'));
    return startTurnRequestSchema.parse(raw);
  } finally {
    await handle.close();
  }
}

const requestPath = process.argv[2];
const turnDir = process.env.VERITY_RUNNER_TURN_DIR;
if (requestPath === undefined || turnDir === undefined) {
  throw new Error('runner worker requires request path and turn directory');
}
const request = await consumeStartRequest(requestPath);
if (!isRunnerSupervisorBackend(request.backend)) throw new Error('unsupported runner backend');
// The ACP SDK logs malformed wire messages verbatim through the global console.
// Those frames can contain prompts, tool inputs, or credentials. Keep diagnostics
// useful without ever copying dependency-controlled payloads to supervisor logs.
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.error = (): void => originalConsoleError('runner worker dependency reported an error');
console.warn = (): void => originalConsoleWarn('runner worker dependency reported a warning');
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
  controlCapability: request.startCommandId,
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
