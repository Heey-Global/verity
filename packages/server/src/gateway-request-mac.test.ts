import { createSecretCipher } from '@verity/store';
import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createGatewayRequestMacKeyring,
  gatewayRequestMac,
  GATEWAY_REQUEST_MAC_DOMAIN,
  type GatewayRequestMacKeyring,
} from './gateway-request-mac.js';

const cipher = createSecretCipher('a'.repeat(64));
const PROJECT = 'project-1';

/** A complete `verity_secret_run` call — argv included, which is the part that
 *  distinguishes two invocations and the part the audit projection may not store. */
const request = {
  tool: 'verity_secret_run',
  executable: '/usr/bin/curl',
  args: ['-X', 'POST', 'https://api.example.com/charge'],
  secrets: [{ alias: 'STRIPE_KEY', target: 'STRIPE_KEY' }],
};

let ctx: TestDb;
let keyring: GatewayRequestMacKeyring;
beforeEach(async () => {
  // Isolated rather than shared: the keyring is a single-row global, so two files minting
  // into the same database would race each other's active key.
  ctx = await createIsolatedTestDb();
  keyring = createGatewayRequestMacKeyring(ctx.db, cipher);
});
afterEach(async () => ctx.close());

describe('gateway request MAC (ADR 0014 D3)', () => {
  it('mints one durable key on first use and reuses it', async () => {
    const first = await keyring.active();
    const second = await keyring.active();
    expect(second.keyId).toBe(first.keyId);
    expect(second.material).toEqual(first.material);
    // A second Server process reads the same key rather than minting its own — records
    // written on either of them have to stay comparable.
    const other = createGatewayRequestMacKeyring(ctx.db, cipher);
    expect((await other.active()).keyId).toBe(first.keyId);
  });

  it('separates two calls that differ only in argv', async () => {
    const key = await keyring.active();
    const other = { ...request, args: ['-X', 'POST', 'https://api.attacker.example/charge'] };
    expect(gatewayRequestMac(key, PROJECT, other)).not.toBe(
      gatewayRequestMac(key, PROJECT, request),
    );
    // Reconciliation depends on the same call producing the same value, regardless of the
    // key order the caller happened to build the object in.
    const reordered = {
      secrets: request.secrets,
      args: request.args,
      executable: request.executable,
      tool: request.tool,
    };
    expect(gatewayRequestMac(key, PROJECT, reordered)).toBe(
      gatewayRequestMac(key, PROJECT, request),
    );
  });

  it('does not let the same command compare across projects', async () => {
    const key = await keyring.active();
    // Reconciliation is always within one project's chain, so equality between two of them
    // carries nothing the record uses — and reading two trails would otherwise reveal that
    // the same withheld argv ran in both.
    expect(gatewayRequestMac(key, 'project-2', request)).not.toBe(
      gatewayRequestMac(key, PROJECT, request),
    );
  });

  it('is keyed, not a digest of the request', async () => {
    const key = await keyring.active();
    const rotated = await keyring.rotate();
    // Whoever supplied the parameters cannot recompute the MAC without the server-held
    // key, so the record is not an offline guessing oracle against them.
    expect(gatewayRequestMac(rotated, PROJECT, request)).not.toBe(
      gatewayRequestMac(key, PROJECT, request),
    );
    expect(gatewayRequestMac(key, PROJECT, request)).not.toContain(GATEWAY_REQUEST_MAC_DOMAIN);
  });

  it('keeps a retired key readable so its records stay verifiable', async () => {
    const retired = await keyring.active();
    const active = await keyring.rotate();
    expect(active.keyId).not.toBe(retired.keyId);
    expect((await keyring.active()).keyId).toBe(active.keyId);
    // Rotation is additive: events recorded under the old key id still recompute, which is
    // what keeps history comparable among itself instead of being quietly retired with it.
    const recovered = await keyring.byId(retired.keyId);
    expect(recovered?.material).toEqual(retired.material);
    expect(gatewayRequestMac(recovered!, PROJECT, request)).toBe(
      gatewayRequestMac(retired, PROJECT, request),
    );
    expect(await keyring.byId('never-minted')).toBeUndefined();
  });

  it('stores the key encrypted, so a database copy alone forges nothing', async () => {
    const key = await keyring.active();
    const row = await ctx.db
      .selectFrom('audit_mac_keys')
      .select(['key_material', 'state'])
      .where('key_id', '=', key.keyId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('active');
    expect(row.key_material).not.toContain(key.material.toString('base64'));
    expect(cipher.decrypt(row.key_material)).toBe(key.material.toString('base64'));
  });

  it('never leaves two active keys behind', async () => {
    await keyring.active();
    await keyring.rotate();
    await keyring.rotate();
    const active = await ctx.db
      .selectFrom('audit_mac_keys')
      .select('key_id')
      .where('state', '=', 'active')
      .execute();
    expect(active).toHaveLength(1);
    // Two active keys would mean two writers keying the same project's calls differently,
    // and MACs that no longer compare are the one failure the keyring exists to prevent.
    expect(await ctx.db.selectFrom('audit_mac_keys').select('key_id').execute()).toHaveLength(3);
  });
});
