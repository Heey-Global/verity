import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const script = fileURLToPath(new URL('./verity-pairing-material', import.meta.url));

function run(state, extra = {}) {
  return spawnSync(script, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VERITY_STATE_DIR: state,
      VERITY_PAIRING_IPS: '192.168.1.42',
      ...extra,
    },
  });
}

test('creates stable identity and TLS material with a fresh compact one-time code', () => {
  const state = mkdtempSync(join(tmpdir(), 'verity-pairing-'));
  const first = run(state);
  assert.equal(first.status, 0, first.stderr);
  const firstIdentity = readFileSync(join(state, 'pairing-identity.pem'), 'utf8');
  const firstKey = readFileSync(join(state, 'tls-key.pem'), 'utf8');
  const firstCode = readFileSync(join(state, 'pairing-code'), 'utf8');
  const parsed = new URL(first.stdout.trim());
  const payload = JSON.parse(
    Buffer.from(parsed.searchParams.get('payload'), 'base64url').toString(),
  );
  assert.equal(payload.v, 1);
  assert.equal(payload.url, 'https://192.168.1.42:8082');
  assert.match(payload.tlsPin, /^sha256-[A-Za-z0-9_-]{43}$/);
  assert.equal(payload.code, firstCode);
  assert.ok(Date.parse(payload.expiresAt) > Date.now());
  assert.equal(statSync(join(state, 'pairing-code')).mode & 0o777, 0o600);

  // Certificate renewal keeps the stable public-key pin.
  unlinkSync(join(state, 'tls-cert.pem'));
  const second = run(state);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(state, 'pairing-identity.pem'), 'utf8'), firstIdentity);
  assert.equal(readFileSync(join(state, 'tls-key.pem'), 'utf8'), firstKey);
  assert.notEqual(readFileSync(join(state, 'pairing-code'), 'utf8'), firstCode);
  const secondPayload = JSON.parse(
    Buffer.from(new URL(second.stdout.trim()).searchParams.get('payload'), 'base64url').toString(),
  );
  assert.equal(secondPayload.tlsPin, payload.tlsPin);

  const certificate = spawnSync(
    'openssl',
    ['x509', '-in', join(state, 'tls-cert.pem'), '-noout', '-ext', 'subjectAltName'],
    { encoding: 'utf8' },
  );
  assert.equal(certificate.status, 0, certificate.stderr);
  assert.match(certificate.stdout, /IP Address:192\.168\.1\.42/);
});

test('refuses a symlink at every generated-material boundary', () => {
  const state = mkdtempSync(join(tmpdir(), 'verity-pairing-link-'));
  const victim = join(state, 'victim');
  writeFileSync(victim, 'unchanged');
  symlinkSync(victim, join(state, 'pairing-code'));
  const result = run(state);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pairing-code must not be a symlink/);
  assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
});
