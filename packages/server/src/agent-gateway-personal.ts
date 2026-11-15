import { createHash } from 'node:crypto';

import type {
  AgentGatewayPersonalConfiguration,
  CodexCredentialUpdate,
} from './agent-gateway-control.js';
import { CodexCredentialAuthority } from './codex-credential-authority.js';
import { CodexCredentialSpill } from './codex-credential-spill.js';

/**
 * Whose provider login serves one request: the instance login, the person's own,
 * or none at all.
 */
export type PersonalCredential<T> =
  { kind: 'instance' } | { kind: 'own'; value: T } | { kind: 'none' };

interface PersonCodex {
  sourceRevision: string;
  authority: CodexCredentialAuthority;
  spill: CodexCredentialSpill;
}

interface Person {
  claude?: string;
  codex?: PersonCodex;
  opencode?: { baseUrl: string; apiKey: string };
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The gateway's per-person provider logins (ADR 0023 §3). A person's own login
 * serves every sandbox of theirs; the instance login serves only the person it
 * belonged to (the administrator) and sandboxes without a person. Anyone else
 * without a login of their own gets nothing — never another person's account.
 *
 * Until a Server sends a personal section, every peer keeps the instance login:
 * such a Server routes only the administrator's sandboxes.
 */
export class AgentGatewayPersonalCredentials {
  private instanceUserId: string | undefined;
  private people = new Map<string, Person>();
  private readonly pending = new Map<string, CodexCredentialUpdate>();

  constructor(private readonly codexSpillPathFor: (userId: string) => string) {}

  /** Whether a personal section is installed, so the instance login is no longer
   *  everyone's. */
  get enforced(): boolean {
    return this.instanceUserId !== undefined;
  }

  /**
   * `userId` is the peer's person: `null` for a sandbox without one, `undefined`
   * when the peer could not be identified at all.
   */
  claude(userId: string | null | undefined): PersonalCredential<string> {
    return this.pick(userId, (person) => person.claude);
  }

  codex(userId: string | null | undefined): PersonalCredential<CodexCredentialAuthority> {
    return this.pick(userId, (person) => person.codex?.authority);
  }

  opencode(
    userId: string | null | undefined,
  ): PersonalCredential<{ baseUrl: string; apiKey: string }> {
    return this.pick(userId, (person) => person.opencode);
  }

  /** Whether any person's own Codex or OpenCode login needs the Codex listener. */
  needsCodexListener(): boolean {
    return [...this.people.values()].some(
      (person) => person.codex !== undefined || person.opencode !== undefined,
    );
  }

  count(): number {
    return this.people.size;
  }

  readCodexUpdate(): CodexCredentialUpdate | undefined {
    return this.pending.values().next().value;
  }

  ackCodexUpdate(userId: string, sourceRevision: string, updatedRevision: string): void {
    const update = this.pending.get(userId);
    if (update?.sourceRevision === sourceRevision && update.updatedRevision === updatedRevision)
      this.pending.delete(userId);
  }

  /**
   * Install the personal section. Revocation takes effect before any spill I/O,
   * so a failing disk can never keep a withdrawn login in service.
   */
  async configure(next: AgentGatewayPersonalConfiguration | undefined): Promise<void> {
    const previous = this.people;
    const people = new Map<string, Person>();
    const spillWrites: Array<() => Promise<void>> = [];
    for (const entry of next?.people ?? []) {
      const person: Person = {};
      if (entry.claude !== undefined) person.claude = entry.claude.accessToken;
      if (entry.opencode !== undefined) person.opencode = { ...entry.opencode };
      if (entry.codex !== undefined && next !== undefined) {
        const codex = await this.codexFor(
          entry.userId,
          entry.codex,
          next.unsealKey,
          previous.get(entry.userId)?.codex,
          spillWrites,
        );
        if (codex !== undefined) person.codex = codex;
      }
      people.set(entry.userId, person);
    }
    this.instanceUserId = next?.instanceUserId;
    this.people = people;
    for (const userId of this.pending.keys()) {
      const update = this.pending.get(userId);
      if (people.get(userId)?.codex?.sourceRevision !== update?.sourceRevision)
        this.pending.delete(userId);
    }
    const errors: unknown[] = [];
    for (const write of spillWrites) await write().catch((error: unknown) => errors.push(error));
    for (const [userId, person] of previous) {
      if (person.codex !== undefined && people.get(userId)?.codex === undefined)
        await person.codex.spill.clear().catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Agent gateway personal Codex spill failed');
  }

  private async codexFor(
    userId: string,
    source: { sourceRevision: string; authJson: string },
    unsealKey: string,
    current: PersonCodex | undefined,
    spillWrites: Array<() => Promise<void>>,
  ): Promise<PersonCodex | undefined> {
    // The authority rotates the refresh token; the Server's copy is stale until it
    // acknowledges the update. Keep the live authority for the same source, and
    // after a restart recover the rotated login from this person's spill.
    if (current?.sourceRevision === source.sourceRevision) return current;
    const spill = new CodexCredentialSpill(this.codexSpillPathFor(userId));
    const recovered = await spill.read(unsealKey).catch(() => undefined);
    const recoverable = recovered?.sourceRevision === source.sourceRevision;
    const authJson = recoverable ? recovered.authJson : source.authJson;
    let authority: CodexCredentialAuthority;
    try {
      authority = new CodexCredentialAuthority(authJson, {
        persist: async (updated) => {
          await spill.write(unsealKey, source.sourceRevision, updated);
          this.pending.set(userId, {
            userId,
            sourceRevision: source.sourceRevision,
            updatedRevision: digest(updated),
            authJson: updated,
          });
        },
      });
    } catch {
      // An unusable login serves nobody; the person signs in again.
      return undefined;
    }
    if (recoverable && recovered.authJson !== source.authJson) {
      this.pending.set(userId, {
        userId,
        sourceRevision: source.sourceRevision,
        updatedRevision: digest(recovered.authJson),
        authJson: recovered.authJson,
      });
    } else if (!recoverable) {
      spillWrites.push(() => spill.write(unsealKey, source.sourceRevision, authJson));
    }
    return { sourceRevision: source.sourceRevision, authority, spill };
  }

  private pick<T>(
    userId: string | null | undefined,
    own: (person: Person) => T | undefined,
  ): PersonalCredential<T> {
    if (this.instanceUserId === undefined) return { kind: 'instance' };
    if (userId === undefined) return { kind: 'none' };
    if (userId === null) return { kind: 'instance' };
    const person = this.people.get(userId);
    const value = person === undefined ? undefined : own(person);
    if (value !== undefined) return { kind: 'own', value };
    return userId === this.instanceUserId ? { kind: 'instance' } : { kind: 'none' };
  }
}
