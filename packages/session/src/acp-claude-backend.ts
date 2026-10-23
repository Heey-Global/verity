import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions } from './backend-contract.js';
import { runAcpTurn, type AcpBackendProfile } from './acp-backend.js';
import { ALLOWED_PERMISSION_MODES } from './runner.js';

export const UNREADABLE_AGENTS_MD_DIRECTIVE =
  'Repository instructions: this worktree has an AGENTS.md that Verity could not import. ' +
  'Read AGENTS.md at the worktree root before you start and follow it.';

export const CLAUDE_ACP_PROFILE: AcpBackendProfile = {
  defaultCommand: 'claude-agent-acp',
  telemetryBackend: 'claude-acp',
  httpMcpWhenUnspecified: true,
  enforcesToolless: true,
  loadSessionUnsupported: 'Claude ACP adapter does not support persistent session loading',
  clientCapabilitiesMeta: { 'subagent-transcript': true },
  sessionMeta: async (opts) => {
    // Settings discovery is disabled, so import repository guidance only as text.
    if (opts.toolless !== true) {
      const handle = await open(
        join(opts.cwd, 'AGENTS.md'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ELOOP') return undefined;
        // This read runs as the Runner uid, which sees worktree files only through
        // their "other" bits. Agents run under umask 0077, so an AGENTS.md they
        // rewrote (an edit, a checkout, a merge) is 0600 and owned by the agent.
        // Failing here crashed every turn of such a session; the agent itself can
        // still read the file, so point it there instead of importing the text.
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          opts = {
            ...opts,
            appendSystemPrompt: [opts.appendSystemPrompt, UNREADABLE_AGENTS_MD_DIRECTIVE]
              .filter(Boolean)
              .join('\n\n'),
          };
          return undefined;
        }
        throw error;
      });
      if (handle !== undefined) {
        try {
          const metadata = await handle.stat();
          if (metadata.isFile() && metadata.size <= 256 * 1024) {
            const buffer = Buffer.alloc(256 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            opts = {
              ...opts,
              appendSystemPrompt: [
                opts.appendSystemPrompt,
                `Repository instructions (AGENTS.md):\n${text}`,
              ]
                .filter(Boolean)
                .join('\n\n'),
            };
          }
        } finally {
          await handle.close();
        }
      }
    }
    return {
      ...(opts.appendSystemPrompt
        ? {
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              append: opts.appendSystemPrompt,
            },
          }
        : {}),
      claudeCode: {
        options: {
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.allowedTools !== undefined ? { allowedTools: [...opts.allowedTools] } : {}),
          ...(opts.disallowedTools !== undefined
            ? { disallowedTools: [...opts.disallowedTools] }
            : {}),
          // Project settings and extensions cannot add another provider or MCP
          // server. Toolless queries additionally disable the built-in tool set.
          settingSources: [],
          strictMcpConfig: true,
          plugins: [],
          agents: {},
          settings: { apiKeyHelper: '' },
          ...(opts.toolless === true ? { tools: [] } : {}),
        },
      },
    };
  },
  defaultModelLabel: () => 'claude',
  promptText: (opts) => opts.prompt ?? '',
  // Match the native Claude runner's fleet default (`auto`). The ACP adapter
  // omits auto for models that cannot support it; the turn loop retains its
  // safely clamped current mode in that case.
  sessionMode: (opts) => opts.permissionMode ?? 'auto',
  // Approving a plan is the one Claude approval that also picks the posture the
  // rest of the turn runs in, so it is the only one whose options are read as
  // modes.
  modePickerTool: 'ExitPlanMode',
  // The operator-selectable postures plus `dontAsk`, which only Verity itself
  // sets: a meta query (`Conductor.query`) runs unattended, so a mode that can
  // raise a permission prompt would hang it. Deliberately NOT in
  // `ALLOWED_PERMISSION_MODES` — that list bounds what the turns API and project
  // config accept, and `dontAsk` must not be reachable from either.
  permissionModes: [...ALLOWED_PERMISSION_MODES, 'dontAsk'],
};

/** Claude Agent SDK behind the stable ACP-v1 client protocol. The ACP process is
 * still launched through Verity's Spawner, so the sandbox spawn broker remains
 * the credential and process boundary. */
export class AcpClaudeBackend implements Backend {
  readonly runnerSupervisorBackend = 'claude-acp' as const;

  // Intentionally no `query`: the former implementation escaped the supervised
  // ACP boundary by spawning `claude -p` in the Server. Callers already treat a
  // backend without one-shot support as unavailable; restoring this feature needs
  // an explicit supervisor query protocol, never a native fallback.

  run(opts: RunTurnOptions): Promise<RunResult> {
    return runAcpTurn(opts, CLAUDE_ACP_PROFILE);
  }
}
