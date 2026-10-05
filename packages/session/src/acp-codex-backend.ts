import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions } from './backend-contract.js';
import {
  promptWithSystemDirectives,
  runAcpTurn,
  type AcpBackendProfile,
  type AcpSessionSetup,
} from './acp-backend.js';
import { toolNameFromKind } from './acp-adapter.js';
import { applySelectOption } from './acp-session-config.js';
import { PLANNING_PERMISSION_MODE } from './runner.js';
import { CODEX_DEFAULT_MODEL, parseCodexModel } from './codex-model.js';

/** codex-acp's own `_meta` key, distinct from the Claude adapter's `claudeCode`. */
const CODEX_ACP_META = 'codex';

/** codex-acp exposes the model as an ACP session config option rather than a
 *  `session/new` parameter, and its values are bare model ids — exactly the slug
 *  behind Verity's `codex/<slug>`. Its reasoning effort is a SEPARATE option, so
 *  setting the model here never resets the session's effort. */
const MODEL_CONFIG_ID = 'model';

/** Runs Codex with `approvalPolicy: 'never'` plus `sandbox: 'danger-full-access'`. The project
 *  container is Verity's isolation boundary and there is no Codex approval UI,
 *  so a second, divergent permission layer would only add failure modes. The
 *  spawn broker sets the same value as `INITIAL_AGENT_MODE`; this is the
 *  in-session confirmation, not a second source of truth. */
const CODEX_AGENT_MODE = 'agent-full-access';

/** A planning turn runs in Codex's read-only sandbox instead: it can read the
 *  workspace and run read-only commands, and anything further needs an approval
 *  that a planning turn refuses (`acp-backend.ts`). */
const CODEX_PLANNING_MODE = 'read-only';

/** The only two modes this profile ever asks for. It reads `opts.permissionMode`
 *  solely to tell a planning turn apart, so no caller-supplied string can become
 *  the session's mode. */
export function codexMode(permissionMode: string | undefined): string {
  return permissionMode === PLANNING_PERMISSION_MODE ? CODEX_PLANNING_MODE : CODEX_AGENT_MODE;
}

async function selectModel(setup: AcpSessionSetup, opts: RunTurnOptions): Promise<void> {
  const wanted = parseCodexModel(opts.model);
  // `codex/default` — leave the account's own current model alone.
  if (wanted === undefined) return;
  await applySelectOption(
    setup,
    MODEL_CONFIG_ID,
    wanted,
    // Names the model that DOES run: the `session` event was written before this and
    // records the requested id, so this note is the only place the transcript says
    // what the turn actually used. "Was not applied" covers both ways of getting
    // here — a value the session never offered, and one it took and then reported
    // itself off again — where "unavailable" would only be true of the first.
    (value, current) => `Codex model "${value}" was not applied; this turn runs on "${current}".`,
  );
}

const CODEX_ACP_PROFILE: AcpBackendProfile = {
  defaultCommand: 'codex-acp',
  telemetryBackend: 'codex-acp',
  loadSessionUnsupported: 'Codex ACP adapter does not support persistent session loading',
  // codex-acp advertises no tool `name`, only ACP's `kind` and a `title` that for
  // a command execution IS the command line.
  adapter: { metaNamespace: CODEX_ACP_META, resolveToolName: toolNameFromKind },
  // codex-acp takes no session-level options: the model and mode are configured
  // once the session answers with what this account can actually serve.
  sessionMeta: () => ({}),
  defaultModelLabel: () => CODEX_DEFAULT_MODEL,
  promptText: (opts) => promptWithSystemDirectives(opts),
  sessionMode: (opts) => codexMode(opts.permissionMode),
  // No vocabulary, stated rather than omitted: `codexMode` maps every caller value
  // onto one of two constants, so no caller-supplied string can become this
  // session's mode and there is nothing for a §5b allowlist to bound. The day it
  // starts passing a value through, this line has to change with it.
  permissionModes: undefined,
  configureSession: selectModel,
};

/**
 * Codex behind the stable ACP-v1 client protocol. The adapter process is launched
 * through Verity's Spawner, so the sandbox spawn broker stays the credential and
 * process boundary and pins the adapter to the image's own `codex` binary.
 *
 * This is the only Codex transport. Verity's brokered tools reach it through
 * the per-turn, approval-gated HTTP-MCP gateway from ADR 0014. That channel does
 * not rely on a second, model-specific tool relay.
 */
export class AcpCodexBackend implements Backend {
  readonly runnerSupervisorBackend = 'codex-acp' as const;

  run(opts: RunTurnOptions): Promise<RunResult> {
    return runAcpTurn(opts, CODEX_ACP_PROFILE);
  }
}
