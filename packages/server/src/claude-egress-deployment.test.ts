import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('Claude egress reference deployment', () => {
  it('stages the internal gateway and connector with no un-routed fallback', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');

    expect(compose).toContain(
      'VERITY_CLAUDE_EGRESS_GATEWAY_URL: ${VERITY_CLAUDE_EGRESS_GATEWAY_URL:-https://verity:9443}',
    );
    expect(compose).toContain(
      'VERITY_CLAUDE_CONNECTOR_PORT: ${VERITY_CLAUDE_CONNECTOR_PORT:-47821}',
    );
    // Routing is unconditional: no switch may reintroduce direct token injection.
    expect(compose).not.toContain('VERITY_CLAUDE_EGRESS_ROUTE_AGENTS');
    expect(compose).not.toMatch(/^\s*- ['"]?9443:9443/m);
  });

  it('runs the standalone gateway under stable DNS with a private control volume', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');
    const dockerfile = await readFile('deploy/Dockerfile', 'utf8');

    expect(compose).toMatch(/^ {2}verity-agent-gateway:\s*$/m);
    expect(compose).not.toMatch(/^\s+profiles:.*agent-gateway/m);
    expect(compose).toMatch(
      /depends_on:[\s\S]*?verity-agent-gateway:\s*\n\s+condition: service_started/,
    );
    expect(compose).toContain(
      'image: ${VERITY_SERVER_IMAGE:?set the digest-pinned server image containing the agent gateway}',
    );
    // Defaulted rather than required: the gateway process defaults to the same path, so
    // a deployment sets it only for a non-standard topology.
    expect(compose).toContain(
      'VERITY_AGENT_GATEWAY_CONTROL_SOCKET: ${VERITY_AGENT_GATEWAY_CONTROL_SOCKET:-/run/verity-agent-gateway/control.sock}',
    );
    expect(compose).toContain('packages/server/dist/agent-gateway-main.js');
    expect(compose).toContain(
      'VERITY_AGENT_GATEWAY_CONTROL_SOCKET: /run/verity-agent-gateway/control.sock',
    );
    expect(compose).toContain('verity-agent-gateway-control:/run/verity-agent-gateway');
    expect(compose).toContain('verity-agent-gateway-state:/var/lib/verity-agent-gateway');
    expect(compose).toMatch(/aliases:\s*\n\s*- verity-agent-gateway/m);
    // Optional: nothing outside the Server reads this, so the Server generates and
    // persists its own on first use. A deployment only sets it to keep an existing key.
    expect(compose).toContain(
      'VERITY_AGENT_GATEWAY_UNSEAL_KEY: ${VERITY_AGENT_GATEWAY_UNSEAL_KEY:-}',
    );
    expect(compose.match(/^\s+VERITY_AGENT_GATEWAY_UNSEAL_KEY:/gmu)).toHaveLength(1);
    expect(compose).not.toContain('VERITY_AGENT_GATEWAY_CLAUDE_AUTHORITY:');
    expect(compose).toContain('VERITY_AGENT_GATEWAY_CLAUDE_HOST: 0.0.0.0');
    expect(compose).toContain(
      'VERITY_AGENT_GATEWAY_URL: ${VERITY_AGENT_GATEWAY_URL:-https://verity-agent-gateway:9443}',
    );
    // No per-project selection survives: every project is routed.
    expect(compose).not.toContain('VERITY_AGENT_GATEWAY_CANARY_PROJECTS');
    expect(compose).not.toContain('VERITY_AGENT_GATEWAY_ROUTE_ALL');
    expect(compose.match(/^\s+VERITY_AGENT_GATEWAY_CLAUDE_PORT: '9443'$/gmu)).toHaveLength(2);
    expect(compose.match(/^\s+VERITY_AGENT_GATEWAY_CODEX_PORT: '9444'$/gmu)).toHaveLength(1);
    expect(compose).toContain('VERITY_AGENT_GATEWAY_CODEX_HOST: 0.0.0.0');
    expect(compose).toContain('VERITY_AGENT_GATEWAY_CODEX_AUTHORITY: verity-agent-gateway:9444');
    expect(compose).toContain(
      'VERITY_CODEX_EGRESS_GATEWAY_URL: ${VERITY_CODEX_EGRESS_GATEWAY_URL:-https://verity-agent-gateway:9444}',
    );
    expect(compose).toContain("fetch('http://127.0.0.1:9080/healthz')");
    expect(compose).not.toMatch(/^\s*- ['"]?9080:9080/m);
    expect(dockerfile).toContain('/run/verity-agent-gateway');
    expect(dockerfile).toContain('/var/lib/verity-agent-gateway');
  });

  it('ships an authenticated Canary and non-Canary isolation smoke check', async () => {
    const smoke = await readFile('deploy/bin/verity-claude-egress-smoke', 'utf8');

    expect(smoke).toContain('/__verity/gateway-ready');
    expect(smoke).toContain('"authenticated":true');
    expect(smoke).toContain('VERITY_CLAUDE_EGRESS_KEY');
    expect(smoke).toContain('VERITY_AGENT_GATEWAY_URL');
    expect(smoke).toContain('expected 403');
    expect(smoke).toContain('[non-canary-container]');
    await expect(execFileAsync('deploy/bin/verity-claude-egress-smoke')).rejects.toMatchObject({
      code: 2,
    });
  });

  it('runs the two-container Canary/isolation gate through Docker observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-egress-deployment-smoke-'));
    const docker = join(root, 'docker');
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
if [ "$1" = inspect ]; then
  container="$4"
  if [ "$container" = canary ]; then
    printf '%s\\n' \\
      VERITY_CLAUDE_CONNECTOR_PORT=47821 \\
      VERITY_CLAUDE_CONNECTOR_AUTHORITY=127.0.0.1:47821 \\
      VERITY_CLAUDE_EGRESS_URL=https://verity-agent-gateway:9443 \\
      VERITY_CLAUDE_EGRESS_CA=/run/ca.crt \\
      VERITY_CLAUDE_EGRESS_CERT=/run/client.crt \\
      VERITY_CLAUDE_EGRESS_KEY=/run/client.key
  else
    printf '%s\\n' \\
      VERITY_CLAUDE_CONNECTOR_PORT=47821 \\
      VERITY_CLAUDE_CONNECTOR_AUTHORITY=127.0.0.1:47821 \\
      VERITY_CLAUDE_EGRESS_URL=https://verity:9443 \\
      VERITY_CLAUDE_EGRESS_CA=/run/ca.crt \\
      VERITY_CLAUDE_EGRESS_CERT=/run/client.crt \\
      VERITY_CLAUDE_EGRESS_KEY=/run/client.key
  fi
elif [ "$1" = exec ] && [ "$2" = canary ]; then
  case "$*" in
    *http://127.0.0.1:47821/__verity/gateway-ready*) ;;
    *) exit 98 ;;
  esac
  printf '%s\\n' '{"authenticated":true}'
elif [ "$1" = exec ] && [ "$2" = legacy ]; then
  arguments="$*"
  for expected in \\
    '--cacert /run/ca.crt' \\
    '--cert /run/client.crt' \\
    '--key /run/client.key' \\
    'https://verity-agent-gateway:9443/__verity/gateway-ready'; do
    case "$arguments" in
      *"$expected"*) ;;
      *) exit 97 ;;
    esac
  done
  printf '%s' 403
else
  exit 99
fi
`,
    );
    await chmod(docker, 0o755);
    try {
      await expect(
        execFileAsync('deploy/bin/verity-claude-egress-smoke', ['canary', 'legacy'], {
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH ?? ''}`,
            VERITY_AGENT_GATEWAY_URL: 'https://verity-agent-gateway:9443',
          },
        }),
      ).resolves.toMatchObject({ stdout: expect.stringContaining('Canary gate passed') });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gates the production gateway image across a real Docker restart', async () => {
    const scriptPath = 'deploy/bin/verity-agent-gateway-deployment-smoke';
    const [script, workflow] = await Promise.all([
      readFile(scriptPath, 'utf8'),
      readFile('.github/workflows/ci.yml', 'utf8'),
    ]);

    expect(script).toContain('packages/server/dist/agent-gateway-main.js');
    expect(script).toContain('--network-alias verity-agent-gateway');
    expect(script).toContain('configure_gateway initial');
    expect(script).toContain('docker restart "$gateway"');
    expect(script).toContain('gateway PID did not change across Docker restart');
    expect(script).toContain('configure_gateway recovered');
    expect(script).toContain('enc:v1:');
    expect(script).toContain('VERITY_AGENT_GATEWAY_CODEX_PORT=9444');
    expect(script).toContain('VERITY_AGENT_GATEWAY_CODEX_AUTHORITY=verity-agent-gateway:9444');
    expect(script).toContain("codexRequest('allowed', '/codex/not-allowlisted')");
    expect(script).toContain("codexRequest('denied', '/codex/responses', 'POST')");
    expect(script).toContain('status.codexListenerReady');
    expect(script).toContain("fs.readFileSync('/state/codex.enc', 'utf8')");
    expect(script).toContain('/__verity/gateway-ready');
    expect(script).toContain("request('denied', '/__verity/gateway-ready')");
    expect(script).toContain("request('allowed', '/v1/models', 'GET')");
    expect(workflow).toContain(
      'deploy/bin/verity-agent-gateway-deployment-smoke "$VERITY_CI_IMAGE"',
    );
    expect(workflow).toContain(
      'deploy/bin/verity-transcribe-meeting|deploy/bin/verity-agent-gateway-deployment-smoke',
    );
    await expect(execFileAsync('bash', ['-n', scriptPath])).resolves.toMatchObject({
      stderr: '',
    });
    await expect(execFileAsync(scriptPath)).rejects.toMatchObject({ code: 2 });
  });

  it('runs the fail-closed Phase 2C fleet preflight policy', async () => {
    const [script, workflow] = await Promise.all([
      readFile('deploy/bin/verity-agent-gateway-cutover-check.mjs', 'utf8'),
      readFile('.github/workflows/ci.yml', 'utf8'),
    ]);

    expect(script).toContain('verity.claude-egress.gateway-url');
    expect(script).not.toContain('VERITY_AGENT_GATEWAY_ROUTE_ALL');
    expect(script).toContain('verity-agent-gateway');
    // The Compose service key and the DNS identity are the same constant, so a
    // rename cannot leave the preflight looking for a service that no longer exists.
    expect(script).toContain('const GATEWAY_SERVICE = STABLE_GATEWAY_HOST;');
    expect(script).toContain('INSPECT_BATCH_SIZE = 50');
    expect(script).toContain('maxBuffer: DOCKER_OUTPUT_MAX_BUFFER');
    expect(workflow).toContain(
      'deploy/bin/verity-agent-gateway-cutover-check.mjs|deploy/bin/verity-agent-gateway-cutover-check.test.mjs',
    );
    await expect(
      execFileAsync('node', ['deploy/bin/verity-agent-gateway-cutover-check.test.mjs']),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('tests 23'),
      stderr: '',
    });
  });
});
