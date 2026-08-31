import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions } from './backend-contract.js';
import { runAcpTurn, type AcpBackendProfile } from './acp-backend.js';
import { ALLOWED_PERMISSION_MODES } from './runner.js';

const CLAUDE_ACP_PROFILE: AcpBackendProfile = {
  defaultCommand: 'claude-agent-acp',
  telemetryBackend: 'claude-acp',
  loadSessionUnsupported: 'Claude ACP adapter does not support persistent session loading',
  clientCapabilitiesMeta: { 'subagent-transcript': true },
  sessionMeta: (opts) => ({
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
      },
    },
  }),
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
