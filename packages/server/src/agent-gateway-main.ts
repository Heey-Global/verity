import { startAgentGatewayRuntime } from './agent-gateway-runtime.js';
import { parseAgentGatewayUrl } from './agent-gateway-url.js';

const controlSocketPath =
  process.env.VERITY_AGENT_GATEWAY_CONTROL_SOCKET ?? '/run/verity-agent-gateway/control.sock';
const healthPort = parsePort(process.env.VERITY_AGENT_GATEWAY_HEALTH_PORT ?? '9080');
const healthHost = process.env.VERITY_AGENT_GATEWAY_HEALTH_HOST ?? '127.0.0.1';
const claudePort = parsePort(process.env.VERITY_AGENT_GATEWAY_CLAUDE_PORT ?? '9443');
const claudeHost = process.env.VERITY_AGENT_GATEWAY_CLAUDE_HOST ?? '127.0.0.1';
const gatewayUrl = parseAgentGatewayUrl(
  process.env.VERITY_AGENT_GATEWAY_URL ?? 'https://verity-agent-gateway:9443',
  claudePort,
);
const claudeListenerAuthority =
  process.env.VERITY_AGENT_GATEWAY_CLAUDE_AUTHORITY ?? gatewayUrl.host;
const codexPort = parsePort(process.env.VERITY_AGENT_GATEWAY_CODEX_PORT ?? '9444');
const codexHost = process.env.VERITY_AGENT_GATEWAY_CODEX_HOST ?? '127.0.0.1';
const codexListenerAuthority =
  process.env.VERITY_AGENT_GATEWAY_CODEX_AUTHORITY ?? `127.0.0.1:${String(codexPort)}`;
const spillPath =
  process.env.VERITY_AGENT_GATEWAY_SPILL_PATH ??
  '/var/lib/verity-agent-gateway/claude-access-token.enc';
const codexSpillPath =
  process.env.VERITY_AGENT_GATEWAY_CODEX_SPILL_PATH ??
  '/var/lib/verity-agent-gateway/codex-auth.enc';

const runtime = await startAgentGatewayRuntime({
  controlSocketPath,
  healthPort,
  healthHost,
  claudePort,
  claudeHost,
  claudeListenerAuthority,
  spillPath,
  codexPort,
  codexHost,
  codexListenerAuthority,
  codexSpillPath,
});
console.log(`verity-agent-gateway: ready (health port ${String(runtime.healthPort)})`);

let closing: Promise<void> | undefined;
const close = (): Promise<void> =>
  (closing ??= runtime.close().finally(() => {
    process.exitCode = 0;
  }));

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('VERITY_AGENT_GATEWAY_HEALTH_PORT must be a valid TCP port');
  }
  return port;
}
