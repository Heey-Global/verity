import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { canonicalJson } from '@verity/secret-contracts';
import type { Database, SecretCipher } from '@verity/store';
import { sql, type Kysely } from 'kysely';

/**
 * Keyed request MACs for the loopback MCP gateway's audit records (ADR 0014 D3).
 *
 * The gateway serves calls from a caller Verity did not authenticate, so its audit event
 * is the only record a call the model never made can appear in at all. Identifying that
 * call needs something that separates two invocations differing only in argv — and argv is
 * exactly what `BROKERED_SECRETS_W3_W4_CONTRACTS.md` §3.4 forbids storing.
 *
 * An unkeyed digest would do the separating and nothing else: it is a durable verifier
 * against attacker-chosen input with little entropy — a short token, an account id, a
 * command line — so anyone who reads the audit trail can guess candidates offline until
 * one matches, recovering the very parameters the projection withheld. Keying it removes
 * that: without the server-held key a record is opaque, and with it two records still
 * compare exactly.
 *
 * The key is therefore never derived from the request, never sent anywhere, and never
 * ephemeral — a per-process key would silently partition the history at every restart,
 * and comparing records across time is the entire purpose.
 *
 * No caller yet: the loopback MCP listener that mints these records lands with the gateway
 * itself. Until it does, an ACP session reaches no brokered tool at all, so there is no
 * unaudited call — the keyring and the schema are the half that has to exist first,
 * because a gateway shipped before them would have nowhere to write.
 */

/** Domain tag folded into every MAC pre-image, so a MAC can only ever be read as one. */
export const GATEWAY_REQUEST_MAC_DOMAIN = 'verity.gateway-request-mac.v1';

/** Advisory-lock key serializing keyring writes across Server processes. */
const KEYRING_LOCK = 'verity.gateway-request-mac-keyring';

/** 256 bits — HMAC-SHA256's block-independent full strength, and the size a forgery
 *  attempt has to search even with the whole audit trail in hand. */
const KEY_BYTES = 32;

export interface GatewayMacKey {
  /** Recorded as `gateway.macKeyId` on every event the key MACs, so rotation is additive. */
  readonly keyId: string;
  readonly material: Buffer;
}

export interface GatewayRequestMacKeyring {
  /** The key to MAC new calls under, minting one on first use. */
  active(): Promise<GatewayMacKey>;
  /** A specific key, for recomputing an older event's MAC. Undefined if it never existed. */
  byId(keyId: string): Promise<GatewayMacKey | undefined>;
  /** Retire the active key and mint its successor. Events keyed under the retired key stay
   *  verifiable — it is kept, not deleted — so history remains comparable among itself. */
  rotate(): Promise<GatewayMacKey>;
}

/**
 * The MAC of one gateway call: HMAC-SHA256 over the domain tag, the project, and the
 * request's canonical JSON, hex-encoded.
 *
 * `request` must be the **complete** validated call — for `verity_secret_run` that includes
 * argv. Narrowing it to the fields the audit projection already carries would produce a
 * value that no longer distinguishes the invocations it exists to distinguish, while still
 * looking like it does.
 *
 * `projectId` is bound in because reconciliation only ever happens within one project's
 * chain: a `received` is matched to its `served` in the same trail, never across trails.
 * Leaving it out would make the same command produce the same value in every project — an
 * equality oracle over the argv the projection withheld, offered to anyone reading two
 * trails, in exchange for nothing the record uses.
 */
export function gatewayRequestMac(key: GatewayMacKey, projectId: string, request: unknown): string {
  return createHmac('sha256', key.material)
    .update(`${GATEWAY_REQUEST_MAC_DOMAIN}\0${projectId}\0${canonicalJson(request)}`)
    .digest('hex');
}

/**
 * The durable keyring, encrypted at rest under the store cipher: a database copy taken
 * without the master password yields neither forgeries nor an offline guessing oracle
 * against the recorded MACs. Reads therefore require an unlocked store — the same
 * condition serving a brokered call already has, since resolving the secret needs it too.
 */
export function createGatewayRequestMacKeyring(
  db: Kysely<Database>,
  cipher: SecretCipher,
): GatewayRequestMacKeyring {
  const decode = (row: { key_id: string; key_material: string }): GatewayMacKey => ({
    keyId: row.key_id,
    material: Buffer.from(cipher.decrypt(row.key_material), 'base64'),
  });
  const mint = async (tx: Kysely<Database>): Promise<{ key_id: string; key_material: string }> => {
    const row = {
      key_id: randomUUID(),
      key_material: cipher.encrypt(randomBytes(KEY_BYTES).toString('base64')),
    };
    await tx
      .insertInto('audit_mac_keys')
      .values({ ...row, state: 'active' })
      .execute();
    return row;
  };
  return {
    async active() {
      const existing = await db
        .selectFrom('audit_mac_keys')
        .select(['key_id', 'key_material'])
        .where('state', '=', 'active')
        .executeTakeFirst();
      if (existing !== undefined) return decode(existing);
      // Mint under the lock and re-read inside it: two Servers serving their first gateway
      // call at once would otherwise both insert, and the loser's rows would be MACed under
      // a key the winner's partial unique index rejected — recorded against a key id no
      // longer active, which reads as a rotation that never happened.
      return await db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${KEYRING_LOCK}))`.execute(tx);
        const raced = await tx
          .selectFrom('audit_mac_keys')
          .select(['key_id', 'key_material'])
          .where('state', '=', 'active')
          .executeTakeFirst();
        return decode(raced ?? (await mint(tx)));
      });
    },
    async byId(keyId) {
      const row = await db
        .selectFrom('audit_mac_keys')
        .select(['key_id', 'key_material'])
        .where('key_id', '=', keyId)
        .executeTakeFirst();
      return row === undefined ? undefined : decode(row);
    },
    async rotate() {
      return await db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${KEYRING_LOCK}))`.execute(tx);
        // Retire first: the partial unique index permits one active key, so the successor
        // cannot be inserted while the incumbent still holds that slot. Both statements are
        // in one transaction, so a failure between them cannot leave the keyring with no
        // active key — which would make the next call mint a third one and split the
        // history for no reason.
        await tx
          .updateTable('audit_mac_keys')
          .set({ state: 'retired' })
          .where('state', '=', 'active')
          .execute();
        return decode(await mint(tx));
      });
    },
  };
}
