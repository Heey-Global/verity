// Server self-update compatibility foundation (ADR 0008, "slice 1").
//
// This module is the READ-ONLY, side-effect-free description of what a given
// Verity Server build is compatible with: its schema generation window and the
// protocol versions it speaks to the Runner, event log, Gateway, and Updater.
// A future Updater compares two builds' `ServerCompat` before a blue-green
// cutover so it never activates a target that cannot be rolled back to the
// previous Server (D4/D9 and the "Required compatibility contracts" section).
//
// Everything here is pure data + a pure comparison. It starts no server, opens
// no connection, and reads no argv — so both the normal Server and the preflight
// entrypoint can import it cheaply.

import { RUNNER_FRAME_PROTOCOL_VERSION, schemaCompatibilityWindow } from '@verity/store';
import { runtimeServerVersion } from '../runtime-version.js';
import { runtimeSchemaForwardMax } from '../runtime-schema-compat.js';

/**
 * A monotonic protocol version window. `current` is the version this build
 * speaks; `min` is the oldest peer version it still accepts. A pair is
 * compatible when each side's `current` is at least the other side's `min`
 * (so N/N−1 is accepted while an N/N−2 gap is rejected).
 */
export interface ProtocolRange {
  readonly min: number;
  readonly current: number;
}

/**
 * The database schema-generation window (ADR 0008 D9). Values are migration
 * keys (`@verity/store` migration names such as `0047_project_overview_visible`),
 * ordered by the same lexicographic sort Kysely applies. `current` is the
 * generation this build targets; `[min, max]` is the generation range this build
 * can read/write, which is what preserves N−1 rollback across an additive
 * (expand/contract) migration.
 */
export interface SchemaRange {
  readonly min: string;
  readonly current: string;
  readonly max: string;
}

/**
 * The full compatibility surface a Verity Server build advertises. Baked into
 * the image (see {@link SERVER_COMPAT}) and, in later slices, exchanged between
 * the running and candidate Servers so the Updater can gate a cutover.
 */
export interface ServerCompat {
  readonly serverVersion: string;
  readonly schema: SchemaRange;
  readonly runner: ProtocolRange;
  readonly eventLog: ProtocolRange;
  readonly gateway: ProtocolRange;
  readonly updater: ProtocolRange;
}

/**
 * The structured result of {@link isCompatible}. `reasons` is empty iff
 * `compatible` is true; otherwise it lists one human-readable explanation per
 * failing dimension (schema, runner, event log, gateway, updater).
 */
export interface CompatResult {
  readonly compatible: boolean;
  readonly reasons: string[];
}

/**
 * Compare two migration keys by the same ordering Kysely uses to apply them
 * (`Array.prototype.sort` default, i.e. lexicographic over UTF-16 code units).
 * Our keys are zero-padded, so this matches the intended numeric generation
 * order. Returns <0, 0, or >0.
 */
export function compareSchemaGenerations(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function schemaReasons(a: ServerCompat, b: ServerCompat): string[] {
  const reasons: string[] = [];
  // Both builds must be able to operate on BOTH declared current generations —
  // the live schema advances to the higher `current` at cutover, and the older
  // Server must remain able to read it for the rollback window. A `current`
  // above a side's `max` is a destructive change (that side cannot read the new
  // generation); below its `min` is too old (support has been dropped).
  const points: ReadonlyArray<{ label: string; generation: string }> = [
    { label: `server ${a.serverVersion}`, generation: a.schema.current },
    { label: `server ${b.serverVersion}`, generation: b.schema.current },
  ];
  for (const side of [a, b]) {
    for (const point of points) {
      if (compareSchemaGenerations(point.generation, side.schema.min) < 0) {
        reasons.push(
          `schema generation "${point.generation}" (${point.label}) is older than ` +
            `server ${side.serverVersion}'s minimum supported generation "${side.schema.min}"`,
        );
      } else if (compareSchemaGenerations(point.generation, side.schema.max) > 0) {
        reasons.push(
          `destructive schema change: generation "${point.generation}" (${point.label}) is ` +
            `newer than server ${side.serverVersion}'s maximum readable generation "${side.schema.max}"`,
        );
      }
    }
  }
  return reasons;
}

function protocolReasons(
  dimension: string,
  a: ServerCompat,
  b: ServerCompat,
  select: (compat: ServerCompat) => ProtocolRange,
): string[] {
  const reasons: string[] = [];
  const ra = select(a);
  const rb = select(b);
  if (ra.current < rb.min) {
    reasons.push(
      `${dimension} protocol mismatch: server ${a.serverVersion} speaks v${ra.current} but ` +
        `server ${b.serverVersion} requires at least v${rb.min}`,
    );
  }
  if (rb.current < ra.min) {
    reasons.push(
      `${dimension} protocol mismatch: server ${b.serverVersion} speaks v${rb.current} but ` +
        `server ${a.serverVersion} requires at least v${ra.min}`,
    );
  }
  return reasons;
}

/**
 * PURE compatibility check between two Server builds (order-independent). The
 * two builds are compatible when, on every dimension, they can coexist across a
 * blue-green cutover and its rollback window:
 *
 * - schema: both builds' `[min, max]` windows contain both declared `current`
 *   generations (rejects destructive contraction and dropped-support downgrades);
 * - runner / event log / gateway / updater: each build's `current` protocol is
 *   at least the other build's `min` (accepts N/N−1, rejects a two-version gap).
 *
 * Returns a structured {@link CompatResult}; `reasons` enumerates every failing
 * dimension rather than short-circuiting on the first.
 */
export function isCompatible(a: ServerCompat, b: ServerCompat): CompatResult {
  // Dedupe: the schema window is probed from both sides against both current
  // generations, so a symmetric failure can produce the same sentence twice.
  const reasons = [
    ...new Set([
      ...schemaReasons(a, b),
      ...protocolReasons('runner', a, b, (c) => c.runner),
      ...protocolReasons('event log', a, b, (c) => c.eventLog),
      ...protocolReasons('gateway', a, b, (c) => c.gateway),
      ...protocolReasons('updater', a, b, (c) => c.updater),
    ]),
  ];
  return { compatible: reasons.length === 0, reasons };
}

// The server's own release version. Mirrors `SERVER_VERSION` in server.ts through
// the same immutable image stamp, but is read here independently so the
// lightweight self-update/preflight path never imports the full server module.
const SERVER_VERSION = runtimeServerVersion();

/**
 * The compatibility surface baked into THIS Server build.
 *
 * The schema window is the real declared range from `@verity/store`
 * ({@link schemaCompatibilityWindow}): `current` is the latest in-code migration
 * and `min` the earliest, so the build advertises the whole additive
 * (expand/contract) history it can still read/write as its N−1 rollback range —
 * this is what makes a genuine cross-version schema comparison possible. `max`
 * currently equals `current`; advertising forward tolerance (`max > current`, so
 * an older Server can read a newer build's additive generation) is a
 * release-controlled forward promise deferred to a later, per-release
 * declaration (see {@link schemaCompatibilityWindow}).
 *
 * The protocol versions anchor to the concrete constants that exist today: the
 * Runner frame protocol from `@verity/store`; the event log, Gateway, and
 * Updater protocols start at v1 (the Gateway and Updater services themselves are
 * deferred to later slices), with each `min`/`max` equal to `current` until a
 * second version exists.
 */
const SCHEMA_COMPATIBILITY = schemaCompatibilityWindow();

export const SERVER_COMPAT: ServerCompat = {
  serverVersion: SERVER_VERSION,
  schema: {
    ...SCHEMA_COMPATIBILITY,
    max: runtimeSchemaForwardMax(SCHEMA_COMPATIBILITY.current),
  },
  runner: { min: RUNNER_FRAME_PROTOCOL_VERSION, current: RUNNER_FRAME_PROTOCOL_VERSION },
  eventLog: { min: 1, current: 1 },
  gateway: { min: 1, current: 1 },
  updater: { min: 1, current: 1 },
};

/**
 * Compare a PEER build's advertised compatibility surface against THIS build
 * (the one baked into {@link SERVER_COMPAT}). Convenience over {@link isCompatible}
 * for the common self-update question — "can I coexist with the server currently
 * running / the candidate I am about to activate?" — so a passive preflight
 * instance can fetch a live server's `/server/compat` and compare it against its
 * own window without re-plumbing the argument order. `isCompatible` is
 * order-independent, so the direction of this call does not matter.
 */
export function isCompatibleWith(peer: ServerCompat): CompatResult {
  return isCompatible(SERVER_COMPAT, peer);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseSchemaRange(value: unknown): SchemaRange | null {
  if (!isObject(value) || !hasExactKeys(value, ['min', 'current', 'max'])) return null;
  const { min, current, max } = value;
  if (
    typeof min !== 'string' ||
    typeof current !== 'string' ||
    typeof max !== 'string' ||
    min.length === 0 ||
    current.length === 0 ||
    max.length === 0 ||
    compareSchemaGenerations(min, current) > 0 ||
    compareSchemaGenerations(current, max) > 0
  ) {
    return null;
  }
  return { min, current, max };
}

function parseProtocolRange(value: unknown): ProtocolRange | null {
  if (!isObject(value) || !hasExactKeys(value, ['min', 'current'])) return null;
  const { min, current } = value;
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(current) ||
    (min as number) < 1 ||
    (current as number) < (min as number)
  )
    return null;
  return { min: min as number, current: current as number };
}

/**
 * Structurally validate a value decoded from a peer's `/server/compat` response
 * into a {@link ServerCompat}, or return `null` when it does not match. A passive
 * preflight instance fetches another Server's advertised window as untyped JSON,
 * so it must validate before handing it to {@link isCompatible}/
 * {@link isCompatibleWith}. Pure and defensive: it accepts only the exact shape
 * this build emits and never throws on malformed input.
 */
export function parseServerCompat(value: unknown): ServerCompat | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ['serverVersion', 'schema', 'runner', 'eventLog', 'gateway', 'updater'])
  )
    return null;
  if (typeof value.serverVersion !== 'string') return null;
  const schema = parseSchemaRange(value.schema);
  const runner = parseProtocolRange(value.runner);
  const eventLog = parseProtocolRange(value.eventLog);
  const gateway = parseProtocolRange(value.gateway);
  const updater = parseProtocolRange(value.updater);
  if (
    schema === null ||
    runner === null ||
    eventLog === null ||
    gateway === null ||
    updater === null
  ) {
    return null;
  }
  return { serverVersion: value.serverVersion, schema, runner, eventLog, gateway, updater };
}
