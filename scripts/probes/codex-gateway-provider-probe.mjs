#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const expectedVersion = 'codex-cli 0.147.0';
const codex = process.env.CODEX_PATH || '/usr/local/bin/codex';
const version = await output(codex, ['--version']);
if (version.trim() !== expectedVersion) {
  throw new Error(`expected ${expectedVersion}, got ${version.trim()}`);
}

let observed;
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    };
    // The probe validates routing, not an inference response. A deterministic
    // rejection makes Codex stop without any provider credential or network.
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"probe complete"}}');
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (typeof address !== 'object' || address === null) throw new Error('probe listener failed');
const baseUrl = `http://127.0.0.1:${String(address.port)}/codex`;

const child = spawn(
  codex,
  [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'danger-full-access',
    '--color',
    'never',
    '-m',
    'gpt-5.4',
    '-c',
    'model_provider="verity_gateway_probe"',
    '-c',
    `model_providers.verity_gateway_probe.name="Verity Gateway Probe"`,
    '-c',
    `model_providers.verity_gateway_probe.base_url="${baseUrl}"`,
    '-c',
    'model_providers.verity_gateway_probe.env_key="VERITY_CODEX_PLACEHOLDER"',
    '-c',
    'model_providers.verity_gateway_probe.wire_api="responses"',
    '-c',
    'model_providers.verity_gateway_probe.requires_openai_auth=false',
    'Reply with probe.',
  ],
  {
    env: {
      ...process.env,
      VERITY_CODEX_PLACEHOLDER: 'verity-codex-gateway-placeholder',
      NO_BROWSER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => (stderr += chunk));
const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
timer.unref();
await once(child, 'exit');
clearTimeout(timer);
await new Promise((resolve) => server.close(resolve));

if (observed === undefined) {
  throw new Error(`Codex did not reach the gateway provider: ${sanitize(stderr)}`);
}
if (observed.method !== 'POST' || observed.url !== '/codex/responses') {
  throw new Error(`unexpected Codex gateway request: ${observed.method} ${observed.url}`);
}
if (observed.authorization !== 'Bearer verity-codex-gateway-placeholder') {
  throw new Error('Codex did not send the configured placeholder credential');
}
if (!observed.body.includes('"model":"gpt-5.4"')) {
  throw new Error('Codex gateway request did not preserve the selected model');
}
console.log(`${expectedVersion} custom provider gateway probe passed`);

function output(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(sanitize(stderr))),
    );
  });
}

function sanitize(value) {
  return value.replace(/[\r\n]+/gu, ' ').slice(0, 500);
}
