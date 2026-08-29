import { describe, expect, it } from 'vitest';

import {
  secretAuditEventInputSchema,
  secretAuditEventPreimage,
  type SecretAuditEventInput,
} from './audit.js';
import { toolChannelSchema } from './tool.js';

const REQUEST_HASH = 'a'.repeat(64);
const PROFILE = { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) };

function input(overrides: Partial<SecretAuditEventInput> = {}): SecretAuditEventInput {
  return {
    projectId: 'project-1',
    kind: 'grant_issued',
    requestHash: REQUEST_HASH,
    grantId: 'grant-1',
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    profile: PROFILE,
    recordedAt: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

describe('secret audit event contract', () => {
  it('rejects any field outside the safe projection (no secret can be recorded)', () => {
    expect(() =>
      secretAuditEventInputSchema.parse({ ...input(), secretValue: 'super-secret' }),
    ).toThrow();
    expect(() => secretAuditEventInputSchema.parse({ ...input(), envelope: 'x' })).toThrow();
  });

  it('requires the reference each event kind is about', () => {
    expect(() =>
      secretAuditEventInputSchema.parse(input({ kind: 'grant_issued', grantId: undefined })),
    ).toThrow(/grantId/);
    expect(() =>
      secretAuditEventInputSchema.parse(
        input({ kind: 'approval_approved', approvalId: undefined, grantId: undefined }),
      ),
    ).toThrow(/approvalId/);
    expect(() =>
      secretAuditEventInputSchema.parse(input({ kind: 'job_succeeded', jobId: undefined })),
    ).toThrow(/jobId/);
  });

  it('computes a pre-image that excludes the event hash itself', () => {
    const base = {
      protocolVersion: 1 as const,
      sequence: 0,
      projectId: 'project-1',
      kind: 'grant_issued' as const,
      requestHash: REQUEST_HASH,
      grantId: 'grant-1',
      aliases: [{ id: 'alias-1', version: 1 }],
      providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' as const }],
      profile: PROFILE,
      recordedAt: '2026-07-20T00:00:00Z',
      prevHash: '0'.repeat(64),
    };
    const withHash = { ...base, eventHash: 'c'.repeat(64) };
    expect(secretAuditEventPreimage(withHash)).toBe(secretAuditEventPreimage(base));
  });
});

const REQUEST_MAC = 'd'.repeat(64);

/** A served gateway call — the shape every case below narrows from. */
function gatewayInput(
  kind: SecretAuditEventInput['kind'],
  // Values are `unknown` so a case can drop a required field or name a channel the schema
  // refuses — the point of most cases here is what the parser rejects.
  gateway: Partial<Record<keyof NonNullable<SecretAuditEventInput['gateway']>, unknown>> = {},
): Record<string, unknown> {
  return {
    ...input({ kind, grantId: undefined, requestHash: undefined }),
    gateway: {
      channel: 'acp-mcp',
      callId: 'gateway-call-1',
      toolName: 'verity_http_request',
      requestMac: REQUEST_MAC,
      macKeyId: 'key-1',
      ...gateway,
    },
  };
}

describe('MCP gateway audit events (ADR 0014 D3)', () => {
  it('records a served call with its decision and the key its MAC was taken under', () => {
    const served = secretAuditEventInputSchema.parse(
      gatewayInput('gateway_call_served', { decision: 'grant' }),
    );
    expect(served.gateway).toEqual({
      channel: 'acp-mcp',
      callId: 'gateway-call-1',
      toolName: 'verity_http_request',
      requestMac: REQUEST_MAC,
      macKeyId: 'key-1',
      decision: 'grant',
    });
    expect(served.requestHash).toBeUndefined();
  });

  it('refuses an unkeyed request hash on a gateway event', () => {
    // The parameters are attacker-supplied, so a sha256 over them is a durable verifier to
    // guess against — the exact failure the keyed MAC exists to avoid. Rejecting it outright
    // keeps it from riding along beside the MAC that was supposed to replace it.
    expect(() =>
      secretAuditEventInputSchema.parse({
        ...gatewayInput('gateway_call_received'),
        requestHash: REQUEST_HASH,
      }),
    ).toThrow(/requestHash/);
  });

  it('refuses a lifecycle event that carries a gateway call, and vice versa', () => {
    expect(() =>
      secretAuditEventInputSchema.parse({
        ...input(),
        gateway: {
          channel: 'acp-mcp',
          callId: 'gateway-call-1',
          toolName: 'verity_http_request',
        },
      }),
    ).toThrow(/gateway/);
    expect(() =>
      secretAuditEventInputSchema.parse({
        ...gatewayInput('gateway_call_served'),
        gateway: undefined,
      }),
    ).toThrow(/gateway/);
  });

  it('keeps the start record free of a decision it could not yet know', () => {
    // `received` is written before the secret resolves, which is before the call is
    // decided. A decision on it would mean it was written after — and the whole point of
    // the record is that it exists even when the call never completes.
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_received', { decision: 'card' }),
      ),
    ).toThrow(/decision/);
    expect(() => secretAuditEventInputSchema.parse(gatewayInput('gateway_call_served'))).toThrow(
      /decision/,
    );
  });

  it('records a malformed body with a reason and no MAC at all', () => {
    const rejected = secretAuditEventInputSchema.parse(
      gatewayInput('gateway_call_rejected', {
        rejection: 'malformed_request',
        toolName: undefined,
        requestMac: undefined,
        macKeyId: undefined,
      }),
    );
    expect(rejected.gateway?.requestMac).toBeUndefined();
    // Nothing parsed, so there is no canonical request to key — and a MAC over an
    // uninterpreted body would reconcile against nothing.
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_rejected', { rejection: 'malformed_request' }),
      ),
    ).toThrow(/requestMac/);
  });

  it('requires a MAC on every other rejection, and a reason on all of them', () => {
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_rejected', {
          rejection: 'denied',
          requestMac: undefined,
          macKeyId: undefined,
        }),
      ),
    ).toThrow(/requestMac/);
    expect(() => secretAuditEventInputSchema.parse(gatewayInput('gateway_call_rejected'))).toThrow(
      /rejection/,
    );
  });

  it('names a tool on exactly the rejections that identified one', () => {
    // `unknown_tool` keys — the body was well-formed — but the name it asked for is not one
    // of the served tools, so any value recorded here would name a tool the call was not
    // for. `denied` happens after a served tool was identified, and omitting it there
    // describes a call that could equally have been the other one.
    const unknownTool = secretAuditEventInputSchema.parse(
      gatewayInput('gateway_call_rejected', { rejection: 'unknown_tool', toolName: undefined }),
    );
    expect(unknownTool.gateway).toMatchObject({ requestMac: REQUEST_MAC, toolName: undefined });
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_rejected', { rejection: 'unknown_tool' }),
      ),
    ).toThrow(/toolName/);
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_rejected', {
          rejection: 'malformed_request',
          requestMac: undefined,
          macKeyId: undefined,
        }),
      ),
    ).toThrow(/toolName/);
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_rejected', { rejection: 'denied', toolName: undefined }),
      ),
    ).toThrow(/toolName/);
  });

  it('refuses to record a gateway call on an attested native channel', () => {
    // The attested relays carry a call on the same channel the turn runs on, so one can
    // never arrive here. Accepting the name would let a record borrow the trust of a
    // channel it did not come in on — and put an unauthenticated value into the switches
    // written for the attested relays.
    //
    // Parsed as a ToolChannel first, so the rejection below is about a name that IS an
    // attested relay. A string that no enum accepts would throw here too, and this test
    // would keep passing while testing nothing.
    const attested = toolChannelSchema.parse('codex-mcp');
    const result = secretAuditEventInputSchema.safeParse(
      gatewayInput('gateway_call_served', { decision: 'card', channel: attested }),
    );
    expect(result.success).toBe(false);
    // On the issue's path, not on the message text: a schema error that merely mentions
    // "channel" for some other reason — a future field named `channelId`, a union arm
    // reporting the whole object — would satisfy a regex over the message while the
    // channel itself was accepted.
    expect(result.error?.issues.some((issue) => issue.path.includes('channel'))).toBe(true);
  });

  it('requires a correlation id on every gateway record', () => {
    // Two identical concurrent calls key to the same MAC, so without it a `received` cannot
    // be paired with the outcome that belongs to it — one served and one denied would be
    // indistinguishable in the trail.
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_rejected', { rejection: 'denied', callId: undefined }),
      ),
    ).toThrow(/callId/);
  });

  it('never records a MAC without the key it was taken under', () => {
    // After a rotation an unattributed MAC cannot be recomputed against any key, so it
    // stops comparing to the records it was written to be compared with.
    expect(() =>
      secretAuditEventInputSchema.parse(
        gatewayInput('gateway_call_served', { decision: 'card', macKeyId: undefined }),
      ),
    ).toThrow(/macKeyId/);
  });
});
