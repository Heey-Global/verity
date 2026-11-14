import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Per-turn sandbox credentials ("the turn's badge").
 *
 * A project's sandbox container is shared by every session in the project, so
 * the container-wide capabilities it holds (signing, forge push, package
 * install) can only ever say "this project". Turns of different people run in
 * that same container at the same time. A route that must act for one person —
 * their GitHub token, their signing key, their AI account — needs to know which
 * turn, and therefore whose turn, is calling.
 *
 * Each supervised turn is issued one of these when it starts and loses it when
 * it settles. The sandbox presents it as `VERITY_TURN_CAPABILITY`; a route
 * resolves it to the project, session, turn and the user the turn runs for.
 * Only a digest is kept, so a dump of this registry cannot be replayed.
 *
 * A container-wide capability stays valid alongside it and keeps meaning
 * "the project, no person": a route may serve project-default behaviour for it
 * but must never select a personal credential from it.
 */
export interface TurnCredentialBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** The person the turn runs for; null for a turn without an initiator. */
  readonly userId: string | null;
}

export interface TurnCredentials {
  issue(binding: TurnCredentialBinding): string;
  /** The binding only for a live credential presented from its own project. */
  resolve(input: { projectId: string; token: string }): TurnCredentialBinding | undefined;
  release(token: string): void;
  /** Drop every credential of a project, e.g. when its container is retired. */
  revokeProject(projectId: string): void;
}

/** The longest a supervised turn may run (24 h) plus slack for its settle path. */
const DEFAULT_TTL_MS = 25 * 60 * 60_000;
const DEFAULT_CAPACITY = 4_096;
const TOKEN_BYTES = 32;
/** 32 bytes as unpadded base64url: the exact shape the sandbox helpers accept. */
export const TURN_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function tokenDigest(token: string): string {
  return createHash('sha256').update(`verity.turn-capability.v1\0${token}`).digest('hex');
}

export function createTurnCredentials(options?: {
  now?: () => number;
  ttlMs?: number;
  capacity?: number;
  /**
   * Where the registry keeps its digests across a restart. Supervised turns
   * outlive a Server restart (the conductor reattaches them); without this their
   * badges would be unknown afterwards and signing or pushing would fail for
   * the rest of the turn. Only digests are written, never a badge.
   */
  persistPath?: string;
}): TurnCredentials {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const capacity = options?.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('invalid turn credential TTL');
  if (!Number.isSafeInteger(capacity) || capacity <= 0)
    throw new Error('invalid turn credential capacity');

  interface Entry extends TurnCredentialBinding {
    readonly expiresAt: number;
  }
  const byDigest = new Map<string, Entry>();
  const purgeExpired = (instant: number): void => {
    for (const [digest, entry] of byDigest) if (entry.expiresAt <= instant) byDigest.delete(digest);
  };
  const path = options?.persistPath;
  if (path !== undefined) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (Array.isArray(saved))
        for (const item of saved as Array<[string, Entry]>) {
          const [digest, entry] = item;
          if (
            typeof digest === 'string' &&
            /^[a-f0-9]{64}$/u.test(digest) &&
            typeof entry?.projectId === 'string' &&
            typeof entry.sessionId === 'string' &&
            typeof entry.turnId === 'string' &&
            (entry.userId === null || typeof entry.userId === 'string') &&
            Number.isSafeInteger(entry.expiresAt) &&
            entry.expiresAt > now() &&
            byDigest.size < capacity
          )
            byDigest.set(digest, entry);
        }
    } catch {
      // No or unreadable state: start empty, as before persistence.
    }
  }
  const save = (): void => {
    if (path === undefined) return;
    try {
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify([...byDigest]), { mode: 0o600 });
      renameSync(temp, path);
    } catch {
      // Persistence is best effort: a failed write costs badges only on restart.
    }
  };

  return {
    issue(binding) {
      const instant = now();
      purgeExpired(instant);
      if (byDigest.size >= capacity) throw new Error('turn credential capacity exhausted');
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      byDigest.set(tokenDigest(token), {
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        userId: binding.userId,
        expiresAt: instant + ttlMs,
      });
      save();
      return token;
    },
    resolve({ projectId, token }) {
      if (!TURN_CAPABILITY_PATTERN.test(token)) return undefined;
      const digest = tokenDigest(token);
      const entry = byDigest.get(digest);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        byDigest.delete(digest);
        return undefined;
      }
      // A credential is only ever good inside the container of its own project.
      if (entry.projectId !== projectId) return undefined;
      return {
        projectId: entry.projectId,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
        userId: entry.userId,
      };
    },
    release(token) {
      if (TURN_CAPABILITY_PATTERN.test(token) && byDigest.delete(tokenDigest(token))) save();
    },
    revokeProject(projectId) {
      let changed = false;
      for (const [digest, entry] of byDigest)
        if (entry.projectId === projectId) changed = byDigest.delete(digest) || changed;
      if (changed) save();
    },
  };
}

/**
 * Whether a turn's badge may be presented from a sandbox (ADR 0023 §4). A badge
 * naming a person belongs only in that person's own sandbox; a badge without one
 * only in the project's original sandbox, the only place such turns run. Anything
 * else is a badge carried out of the sandbox it was issued into.
 */
export function turnFitsSandbox(
  turn: { readonly userId: string | null },
  sandbox: { readonly userId: string; readonly projectDefault: boolean },
): boolean {
  return turn.userId === null ? sandbox.projectDefault : turn.userId === sandbox.userId;
}
