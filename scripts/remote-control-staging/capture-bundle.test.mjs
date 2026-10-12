import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, collect, report } from './capture-bundle.mjs';

const now = 1800000000000;
const installation = '1111111111111111';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'capture-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'bundle');
  prepare(dir, installation, 120, now);
  const put = (source, value) => {
    const path = join(root, `${source}.input`);
    const input =
      source === 'uplink' && value.event === 'remote.return_path'
        ? {
            ...value,
            at: new Date(value.time).toISOString(),
            direction: 'in',
            stage: 'emitted_message',
            outcome: 'observed',
            eventOrder: 1,
            elapsedMs: 3,
          }
        : value;
    writeFileSync(path, JSON.stringify(input));
    collect(dir, source, path);
  };
  const row = {
    event: 'remote.return_path',
    schemaVersion: 1,
    time: now,
    session: '2222222222222222',
    generation: '3333333333333333',
    party: 'installation',
    events: [],
    droppedEvents: 0,
    droppedStreamObservations: 0,
  };
  const status = {
    enabled: true,
    installationFingerprint: installation,
    currentUtc: new Date(now).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
  };
  return { dir, put, row, status };
}
test('missing evidence stays incomplete; private output and bounded duration', (t) => {
  const { dir } = fixture(t);
  const result = report(dir, now);
  assert.equal(result.observationsAvailable, false);
  assert.deepEqual(result.missing, ['core', 'uplink', 'app']);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'manifest.json')).mode & 0o777, 0o600);
  assert.throws(() => prepare(`${dir}-long`, installation, 121, now));
});
test('retrieved matching observations are only preflight evidence and expire', (t) => {
  const { dir, put, row, status } = fixture(t);
  put('core-status', status);
  put('core', row);
  put('uplink', { ...row, generation: '4444444444444444' });
  const result = report(dir, now + 1);
  assert.equal(result.observationsAvailable, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['app']);
  assert.equal(report(dir, now + 120000).observationsAvailable, false);
  // Tampered collected bytes must never retain their original integrity claim.
  writeFileSync(join(dir, 'core.json'), JSON.stringify({ ...row, emittedBytes: 100 }));
  assert.throws(() => report(dir, now + 1), /Integrity mismatch/u);
});
test('wrong installation, missing activation and incomplete detail block preflight', (t) => {
  const { dir, put, row, status } = fixture(t);
  put('core-status', { ...status, installationFingerprint: 'aaaaaaaaaaaaaaaa' });
  put('core', row);
  put('uplink', { ...row, droppedEvents: 1 });
  const result = report(dir, now + 1);
  assert.equal(result.observationsAvailable, false);
  assert.ok(result.gaps.includes('core_activation_unverified'));
  assert.ok(result.gaps.includes('uplink_detail_incomplete'));
});
test('different sessions cannot be joined by equal local generation', (t) => {
  const { dir, put, row, status } = fixture(t);
  put('core-status', status);
  put('core', row);
  put('uplink', { ...row, session: '5555555555555555' });
  assert.equal(report(dir, now + 1).observationsAvailable, false);
});
test('unknown source formats and empty evidence are rejected', (t) => {
  const { put } = fixture(t);
  assert.throws(() => put('uplink', { complete: true, sections: {} }));
  assert.throws(() => put('app', []));
  assert.throws(() => put('core-status', { enabled: true }));
});
test('app imports require DATA identity and retain explicit join and capture gaps', (t) => {
  const { dir, put, row, status } = fixture(t);
  put('core-status', status);
  put('core', row);
  put('uplink', row);
  assert.throws(() => put('app', [{ events: [] }]));
  const app = {
    version: 1,
    channel: 'DATA',
    generation: '01234567-0123-4123-8123-0123456789ab',
    sessionHash: '9999999999999999',
    clockOffsetKnown: false,
    startedLate: false,
    delegateAvailable: false,
    expired: true,
    captureLimitMs: 120000,
    dropped: 0,
    events: [
      { sequence: 1, elapsedMs: 0, utc: new Date(now).toISOString(), event: 'capture_started' },
    ],
  };
  assert.throws(() => put('app', [{ ...app, events: [app.events[0], app.events[0]] }]));
  put('app', [app]);
  const result = report(dir, now + 1);
  assert.equal(result.observationsAvailable, true);
  assert.ok(result.gaps.includes('app_session_join_ambiguous_or_missing'));
  assert.ok(result.gaps.includes('app_detail_incomplete'));
  assert.ok(result.gaps.includes('app_capture_expired'));
});

test('Uplink accepts its at timestamp and flat event without a Core events array', (t) => {
  const { dir, put, row, status } = fixture(t);
  put('core-status', status);
  put('core', row);
  const path = join(dir, '..', 'uplink-exact.jsonl');
  const exact = {
    at: new Date(now).toISOString(),
    event: 'remote.return_path',
    schemaVersion: 1,
    session: row.session,
    generation: '4444444444444444',
    party: 'installation',
    direction: 'in',
    stage: 'emitted_message',
    outcome: 'observed',
    eventOrder: 1,
    elapsedMs: 3,
    encodedBytes: 100,
  };
  writeFileSync(path, JSON.stringify({ ...exact, at: 'invalid' }));
  assert.throws(() => collect(dir, 'uplink', path));
  writeFileSync(path, JSON.stringify(exact));
  collect(dir, 'uplink', path);
  assert.equal(report(dir, now + 1).observationsAvailable, true);
  assert.equal(report(dir, now + 1).complete, false);
});
test('Uplink dropped streams and logger failures remain explicit gaps', (t) => {
  const { dir, put, row, status } = fixture(t);
  put('core-status', status);
  put('core', row);
  put('uplink', { ...row, droppedStreams: 1, loggerErrors: 1 });
  assert.ok(report(dir, now + 1).gaps.includes('uplink_detail_incomplete'));
  assert.equal(report(dir, now + 1).observationsAvailable, false);
});
