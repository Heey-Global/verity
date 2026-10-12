import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 4 * 1024 * 1024;
const sources = ['core', 'uplink', 'app'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (value) => typeof value === 'string' && /^[a-f0-9]{16}$/u.test(value);
const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function validApp(row) {
  if (
    !row ||
    row.version !== 1 ||
    row.channel !== 'DATA' ||
    !uuid(row.generation) ||
    (row.sessionHash != null && !fingerprint(row.sessionHash)) ||
    row.clockOffsetKnown !== false ||
    !['startedLate', 'delegateAvailable', 'expired'].every(
      (key) => typeof row[key] === 'boolean',
    ) ||
    !integer(row.captureLimitMs) ||
    row.captureLimitMs > 120000 ||
    !integer(row.dropped) ||
    !Array.isArray(row.events) ||
    row.events.length > 128 ||
    JSON.stringify(row).length > 65536 ||
    (row.streams !== undefined &&
      (!Array.isArray(row.streams) ||
        row.streams.length > 16 ||
        !integer(row.streamUpdatesDropped)))
  )
    return false;
  let sequence = 0;
  let elapsed = 0;
  for (const event of row.events) {
    if (
      !event ||
      !integer(event.sequence) ||
      event.sequence <= sequence ||
      !integer(event.elapsedMs) ||
      event.elapsedMs < elapsed ||
      event.elapsedMs > row.captureLimitMs ||
      typeof event.event !== 'string' ||
      !/^[a-z_]{1,40}$/u.test(event.event) ||
      typeof event.utc !== 'string' ||
      !Number.isFinite(Date.parse(event.utc))
    )
      return false;
    sequence = event.sequence;
    elapsed = event.elapsedMs;
  }
  return true;
}
function read(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Expected a bounded regular file');
  const bytes = readFileSync(path);
  if (bytes.length > LIMIT) throw new Error('Artifact exceeds limit');
  return bytes;
}
function save(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function records(bytes, source) {
  const text = bytes.toString('utf8').trim();
  const rows =
    source === 'app' ? JSON.parse(text) : text.split('\n').map((line) => JSON.parse(line));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Empty recording');
  if (source === 'app') {
    if (
      rows.length > 3 ||
      rows.some((row) => !validApp(row)) ||
      new Set(rows.map((row) => row.generation)).size !== rows.length
    )
      throw new Error('Expected native snapshot array');
    return rows;
  }
  if (source === 'uplink') {
    const stages = [
      'emitted_message',
      'parser',
      'tracker',
      'accepted',
      'send',
      'callback',
      'ws_error',
      'summary',
      'close',
    ];
    if (
      rows.some(
        (row) =>
          !row ||
          row.event !== 'remote.return_path' ||
          row.schemaVersion !== 1 ||
          !fingerprint(row.session) ||
          !fingerprint(row.generation) ||
          !['app', 'installation'].includes(row.party) ||
          !['in', 'out'].includes(row.direction) ||
          !stages.includes(row.stage) ||
          !['observed', 'accepted', 'error'].includes(row.outcome) ||
          !integer(row.eventOrder) ||
          !Number.isFinite(row.elapsedMs) ||
          row.elapsedMs < 0 ||
          typeof row.at !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(row.at) ||
          !Number.isFinite(Date.parse(row.at)) ||
          ['droppedEvents', 'droppedStreams', 'loggerErrors'].some(
            (key) => row[key] !== undefined && !integer(row[key]),
          ),
      )
    )
      throw new Error('Expected Uplink remote.return_path schema v1 JSONL');
    // Normalize only for local analysis; original imported bytes remain intact.
    return rows.map((row) => ({ ...row, time: Date.parse(row.at) }));
  }
  if (
    rows.some(
      (row) =>
        row.event !== 'remote.return_path' ||
        row.schemaVersion !== 1 ||
        !fingerprint(row.session) ||
        !fingerprint(row.generation) ||
        !Array.isArray(row.events) ||
        !['app', 'installation'].includes(row.party) ||
        !Number.isFinite(row.time),
    )
  )
    throw new Error('Expected timestamped remote.return_path schema v1 JSONL');
  return rows;
}
export function prepare(directory, installation, seconds = 120, now = Date.now()) {
  if (!fingerprint(installation) || !Number.isInteger(seconds) || seconds < 1 || seconds > 120)
    throw new Error('Use an installation fingerprint and duration of 1–120 seconds');
  mkdirSync(directory, { mode: 0o700 });
  const manifest = {
    version: 1,
    runId: randomUUID(),
    installationFingerprint: installation,
    startedAt: now,
    expiresAt: now + seconds * 1000,
    artifacts: {},
  };
  save(join(directory, 'manifest.json'), manifest);
  return manifest;
}
function manifestAt(directory) {
  const manifest = JSON.parse(read(join(directory, 'manifest.json')));
  if (
    manifest.version !== 1 ||
    !uuid(manifest.runId) ||
    !Number.isFinite(manifest.startedAt) ||
    !Number.isFinite(manifest.expiresAt) ||
    manifest.expiresAt <= manifest.startedAt ||
    manifest.expiresAt - manifest.startedAt > 120000 ||
    !fingerprint(manifest.installationFingerprint)
  )
    throw new Error('Invalid manifest');
  return manifest;
}
export function collect(directory, source, input) {
  if (![...sources, 'core-status'].includes(source)) throw new Error('Unknown source');
  const manifest = manifestAt(directory);
  if (manifest.artifacts[source]) throw new Error('Source already imported; prepare a new bundle');
  const bytes = read(input);
  if (source === 'core-status') {
    const status = JSON.parse(bytes);
    if (
      typeof status.enabled !== 'boolean' ||
      !Number.isFinite(Date.parse(status.currentUtc)) ||
      !fingerprint(status.installationFingerprint)
    )
      throw new Error('Invalid Core activation status');
  } else records(bytes, source);
  const filename = `${source}.json`;
  writeFileSync(join(directory, filename), bytes, { flag: 'wx', mode: 0o600 });
  manifest.artifacts[source] = { bytes: bytes.length, sha256: hash(bytes) };
  save(join(directory, 'manifest.json'), manifest);
}
export function report(directory, now = Date.now()) {
  const manifest = manifestAt(directory);
  const parsed = {};
  const missing = sources.filter((source) => !manifest.artifacts[source]);
  for (const source of [...sources, 'core-status']) {
    const expected = manifest.artifacts[source];
    if (!expected) continue;
    const bytes = read(join(directory, `${source}.json`));
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
      throw new Error(`Integrity mismatch: ${source}`);
    parsed[source] = source === 'core-status' ? JSON.parse(bytes) : records(bytes, source);
  }
  const gaps = [];
  const status = parsed['core-status'];
  if (
    !status ||
    !status.enabled ||
    status.installationFingerprint !== manifest.installationFingerprint ||
    Date.parse(status.currentUtc) < manifest.startedAt ||
    Date.parse(status.currentUtc) > now ||
    !Number.isFinite(Date.parse(status.expiresAt)) ||
    Date.parse(status.expiresAt) < manifest.expiresAt
  )
    gaps.push('core_activation_unverified');
  const sessions = {};
  for (const source of ['core', 'uplink']) {
    const rows = parsed[source] ?? [];
    const relevant = rows.filter(
      (row) => row.time >= manifest.startedAt && row.time <= Math.min(now, manifest.expiresAt),
    );
    sessions[source] = new Set(relevant.map((row) => row.session));
    if (!relevant.length) gaps.push(`${source}_initial_sample_missing`);
    if (
      rows.some((row) =>
        source === 'core'
          ? row.droppedEvents !== 0 || row.droppedStreamObservations !== 0
          : (row.droppedEvents ?? 0) > 0 ||
            (row.droppedStreams ?? 0) > 0 ||
            (row.loggerErrors ?? 0) > 0,
      )
    )
      gaps.push(`${source}_detail_incomplete`);
  }
  if (
    parsed.uplink?.some(
      (row) =>
        row.stage === 'summary' &&
        (row.droppedEvents === undefined ||
          row.droppedStreams === undefined ||
          row.loggerErrors === undefined),
    )
  )
    gaps.push('uplink_summary_coverage_unknown');
  const commonSessions = [...sessions.core].filter((session) => sessions.uplink.has(session));
  if (commonSessions.length !== 1) gaps.push('session_join_ambiguous_or_missing');
  const observationsAvailable = now < manifest.expiresAt && gaps.length === 0;
  if (!parsed.app) gaps.push('app_recording_missing');
  else {
    const appSessions = new Set(parsed.app.map((row) => row.sessionHash));
    if (
      commonSessions.length !== 1 ||
      appSessions.size !== 1 ||
      !appSessions.has(commonSessions[0])
    )
      gaps.push('app_session_join_ambiguous_or_missing');
    if (
      parsed.app.some(
        (row) =>
          row.startedLate ||
          !row.delegateAvailable ||
          row.dropped > 0 ||
          row.streamUpdatesDropped > 0,
      )
    )
      gaps.push('app_detail_incomplete');
    if (parsed.app.some((row) => row.expired)) gaps.push('app_capture_expired');
  }
  // Imported samples prove retrieval, not continued collection or cross-host clock alignment.
  return {
    runId: manifest.runId,
    expiresAt: new Date(manifest.expiresAt).toISOString(),
    observationsAvailable,
    missing,
    gaps,
    commonSessions,
    complete: false,
    limitation:
      'Manual imports do not verify ongoing capture, clock alignment, or end-to-end success.',
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, source, input] = process.argv.slice(2);
    if (command === 'prepare')
      console.log(
        JSON.stringify(prepare(directory, source, input === undefined ? 120 : Number(input))),
      );
    else if (command === 'collect') collect(directory, source, input);
    else if (command === 'report' || command === 'preflight') {
      const result = report(directory);
      console.log(JSON.stringify(result, null, 2));
      if (command === 'preflight' && !result.observationsAvailable) process.exitCode = 1;
    } else
      throw new Error(
        'Usage: capture-bundle.mjs prepare DIR INSTALLATION_HASH [SECONDS] | collect DIR SOURCE FILE | preflight DIR | report DIR',
      );
  } catch {
    console.error(
      'Capture bundle failed: invalid input, unsupported schema, missing file, or integrity mismatch.',
    );
    process.exitCode = 1;
  }
}
