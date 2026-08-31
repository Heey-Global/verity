import { z } from 'zod';
import {
  brokeredSecretsProtocolVersionSchema,
  canonicalJson,
  isoUtcTimestampSchema,
  secretContractIdSchema,
  sha256HexSchema,
} from './common.js';
import {
  executionProfileRefSchema,
  providerBindingRefSchema,
  secretAliasRefSchema,
} from './catalog.js';

/**
 * Append-only, hash-chained provenance trail for the Brokered Secrets control plane (ADR 0009,
 * Phase 1). Every security-relevant lifecycle transition — approval decided, grant issued, grant
 * redeemed, redemption refused, job terminal, cleanup — is recorded as one {@link SecretAuditEvent}
 * in a per-project chain.
 *
 * The `gateway_*` kinds (ADR 0014 D3) join that chain from a different place: not a
 * lifecycle transition Verity decided, but each `tools/call` the loopback MCP gateway
 * served for an ACP session — including the ones it refused. They are the only record of
 * a call the model did not make, so they carry a keyed request MAC rather than the
 * lifecycle `requestHash`; see {@link secretAuditGatewayCallSchema} for why the
 * distinction is not cosmetic.
 *
 * Two properties make the trail trustworthy:
 *
 *  - **Safe projection.** An event carries only opaque identifiers, versioned refs, and hashes. Raw
 *    argv, provider keys, ciphertext, envelope bytes, actor identities, and any secret value are
 *    ABSENT by construction — the schema is `.strict()`, so an attempt to record one is rejected.
 *  - **Tamper evidence.** Each event pins the previous event's hash (`prevHash`) and its own
 *    `eventHash = sha256(domain \0 canonicalJson(event without eventHash))`. A per-project sequence
 *    starts at 0 and is contiguous. Mutating, reordering, or deleting an event from the interior of
 *    a chain breaks it and is detectable by {@link verifySecretAuditChain} without needing any
 *    secret. A bare hash chain cannot, on its own, detect truncation of the newest events (dropping
 *    the tail leaves a shorter but still-valid prefix): to catch that, a caller passes the last head
 *    it trusts (`sequence` + `eventHash`) as `expectedHead` — the verifier then rejects any chain
 *    that does not end exactly at that head. Defeating detection thus requires forging a preimage
 *    (sha256) or possessing the trusted head, not merely DB write access.
 *
 * The genesis link of every chain is {@link SECRET_AUDIT_GENESIS_HASH}. Hashing itself is done by the
 * server (node:crypto) over {@link secretAuditEventPreimage}; this module stays runtime-neutral.
 */

/** Fixed `prevHash` of the first event in any project chain (all-zero sha256, never a real hash). */
export const SECRET_AUDIT_GENESIS_HASH = '0'.repeat(64);

/** Domain separation tag folded into every event hash pre-image. */
export const SECRET_AUDIT_EVENT_DOMAIN = 'verity.secret-audit-event.v1';

export const secretAuditEventKindSchema = z.enum([
  'approval_approved',
  'approval_denied',
  'grant_issued',
  'grant_redeemed',
  'grant_redemption_refused',
  'job_succeeded',
  'job_failed',
  'job_cancelled',
  'cleanup_complete',
  'cleanup_attention',
  'gateway_call_received',
  'gateway_call_served',
  'gateway_call_rejected',
]);
export type SecretAuditEventKind = z.infer<typeof secretAuditEventKindSchema>;

/** The three `gateway_*` kinds, which carry {@link SecretAuditGatewayCall} instead of a
 *  `requestHash`. Kept as one predicate so the schema, the recorder, and the store all
 *  split the two families the same way. */
export function isGatewayAuditKind(kind: SecretAuditEventKind): boolean {
  return kind.startsWith('gateway_');
}

/**
 * The transport a gateway record is about — deliberately NOT {@link ToolChannel}.
 *
 * That enum names the attested native relays, where the call arrives on the same channel
 * the turn runs on and the server therefore knows the model made it. Everything reached
 * over this one is the opposite case: any workspace process holding the loopback endpoint
 * and its token produces an indistinguishable request. Sharing one enum would let a
 * gateway record claim a channel that never reaches the gateway, and would put an
 * unauthenticated value into every switch written for the attested relays.
 */
export const gatewayChannelSchema = z.enum(['acp-mcp']);
export type GatewayChannel = z.infer<typeof gatewayChannelSchema>;

/** Tools the loopback MCP gateway serves. `verity_secret_job` is not among them: it is a
 *  native-relay tool and never reached over this channel.
 *
 *  The first two are the brokered-secret tools every project may reach. The rest are
 *  served only to the control-plane project (`extraToolsForProject`) and hold no secret at
 *  all — they are here because the gateway's approval card, keyed MAC and audit record are
 *  exactly the envelope a cross-project action needs, not because they resolve credentials. */
export const gatewayToolNameSchema = z.enum([
  'verity_http_request',
  'verity_secret_run',
  'verity_create_delivery',
  'verity_list_sessions',
  'verity_session_handoff',
  'verity_session_progress',
  'verity_recent_session_messages',
  'verity_publish_session_progress',
]);
export type GatewayToolName = z.infer<typeof gatewayToolNameSchema>;

/** Why the gateway refused a call. Coarse on purpose — a reason is operator-facing
 *  provenance, not a diagnostic channel back to a caller the server did not authenticate. */
export const gatewayCallRejectionSchema = z.enum([
  /** The body did not parse, or failed the tool's request schema. No MAC exists for it. */
  'malformed_request',
  /** A well-formed call for a tool this gateway does not serve. It keys, but it cannot
   *  record a `toolName`: the name it asked for is not one of the served tools. */
  'unknown_tool',
  /** No usable gateway credential on the request. */
  'unauthenticated',
  /** The operator denied the card, or the turn settled with it unanswered. */
  'denied',
  /** The server could not serve the call — sealed store, missing binding, resolver failure. */
  'unavailable',
]);
export type GatewayCallRejection = z.infer<typeof gatewayCallRejectionSchema>;

/** How a served call was approved. `card` is a decision the operator made for this call;
 *  `grant` is a standing grant redeemed with no card shown (ADR 0014 D3). */
export const gatewayCallDecisionSchema = z.enum(['card', 'grant']);
export type GatewayCallDecision = z.infer<typeof gatewayCallDecisionSchema>;

/**
 * The gateway's own record of one `tools/call` (ADR 0014 D3).
 *
 * It exists because a call made with a stolen endpoint never reaches the ACP transcript:
 * it goes straight to the loopback MCP server, so the transcript shows exactly the calls
 * the model made — precisely the set such a call is not in. This is therefore the only
 * place it can appear at all.
 *
 * `requestMac` is a **keyed** MAC over the call's complete canonical form, not a digest.
 * The parameters here are attacker-supplied by construction — the premise is a caller the
 * server did not authenticate — and an unkeyed digest over a short token, an account id or
 * a command line is a durable verifier to guess against. Narrowing it to the non-argv
 * fields would remove that risk and with it the property the record exists for: two
 * `verity_secret_run` invocations that differ only in argv would reconcile against one
 * entry. The key is server-held and versioned, so `macKeyId` travels with every MAC and
 * rotation stays additive rather than retiring the comparable history.
 *
 * What the record supports: that a call matching this MAC was served under this decision.
 * What it does not: attribution. There is no per-call identity shared between the ACP and
 * MCP channels, so no gateway event can be matched to the `tool_call` it claims to be.
 */
export const secretAuditGatewayCallSchema = z
  .object({
    channel: gatewayChannelSchema,
    /** The gateway's own id for this call, minted server-side before anything is recorded
     *  and carried by every record the call produces. Two identical concurrent calls key
     *  to the same MAC, so without it a `received` cannot be paired with the outcome that
     *  belongs to it. It identifies nothing outside this trail: it is not the ACP tool call
     *  id and is never shown to the caller. */
    callId: secretContractIdSchema,
    /** Absent only when the request never parsed far enough to name a tool. */
    toolName: gatewayToolNameSchema.optional(),
    /** HMAC-SHA256 (hex) over the canonical request. Absent iff there is no canonical
     *  request to key — a rejected malformed body has nothing to reconcile with. */
    requestMac: sha256HexSchema.optional(),
    /** Id of the server-held key `requestMac` was taken under. Present with the MAC. */
    macKeyId: secretContractIdSchema.optional(),
    decision: gatewayCallDecisionSchema.optional(),
    rejection: gatewayCallRejectionSchema.optional(),
  })
  .strict();
export type SecretAuditGatewayCall = z.infer<typeof secretAuditGatewayCallSchema>;

/** The safe, non-secret fields a caller supplies; the log assigns sequence, prevHash, eventHash. */
export const secretAuditEventInputSchema = z
  .object({
    projectId: secretContractIdSchema,
    kind: secretAuditEventKindSchema,
    /** Required on every lifecycle kind; absent on the `gateway_*` kinds, which carry a
     *  keyed `gateway.requestMac` instead — see {@link secretAuditGatewayCallSchema}. */
    requestHash: sha256HexSchema.optional(),
    grantId: secretContractIdSchema.optional(),
    jobId: secretContractIdSchema.optional(),
    approvalId: secretContractIdSchema.optional(),
    profile: executionProfileRefSchema.optional(),
    aliases: z.array(secretAliasRefSchema).max(16),
    providerBindings: z.array(providerBindingRefSchema).max(16),
    /** Hash of the deciding actor's identity — never the raw actor id. */
    actorHash: sha256HexSchema.optional(),
    gateway: secretAuditGatewayCallSchema.optional(),
    recordedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine(requireKindReferences);

export type SecretAuditEventInput = z.infer<typeof secretAuditEventInputSchema>;

/** A persisted event: the input plus the chain fields the log assigned. */
export const secretAuditEventSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    projectId: secretContractIdSchema,
    kind: secretAuditEventKindSchema,
    requestHash: sha256HexSchema.optional(),
    grantId: secretContractIdSchema.optional(),
    jobId: secretContractIdSchema.optional(),
    approvalId: secretContractIdSchema.optional(),
    profile: executionProfileRefSchema.optional(),
    aliases: z.array(secretAliasRefSchema).max(16),
    providerBindings: z.array(providerBindingRefSchema).max(16),
    actorHash: sha256HexSchema.optional(),
    gateway: secretAuditGatewayCallSchema.optional(),
    recordedAt: isoUtcTimestampSchema,
    prevHash: sha256HexSchema,
    eventHash: sha256HexSchema,
  })
  .strict()
  .superRefine(requireKindReferences);

export type SecretAuditEvent = z.infer<typeof secretAuditEventSchema>;

function requireKindReferences(
  event: {
    kind: SecretAuditEventKind;
    requestHash?: string | undefined;
    grantId?: string | undefined;
    jobId?: string | undefined;
    approvalId?: string | undefined;
    gateway?: SecretAuditGatewayCall | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const reject = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message: `${event.kind} audit event ${message}` });
  };
  const requireField = (field: 'grantId' | 'jobId' | 'approvalId'): void => {
    if (event[field] === undefined) reject([field], `requires ${field}`);
  };
  if (event.kind.startsWith('approval_')) requireField('approvalId');
  if (event.kind.startsWith('grant_')) requireField('grantId');
  if (event.kind.startsWith('job_') || event.kind.startsWith('cleanup_')) {
    requireField('jobId');
    requireField('grantId');
  }
  if (!isGatewayAuditKind(event.kind)) {
    if (event.requestHash === undefined) reject(['requestHash'], 'requires requestHash');
    if (event.gateway !== undefined) reject(['gateway'], 'does not carry a gateway call');
    return;
  }
  // A gateway kind takes the keyed MAC and refuses the unkeyed digest outright, rather
  // than merely not requiring it: `requestHash` is a sha256 over the request, and these
  // parameters are attacker-supplied, so accepting one here would persist exactly the
  // guessable verifier ADR 0014 D3 rules out — with the MAC alongside it hiding that it
  // had.
  if (event.requestHash !== undefined) reject(['requestHash'], 'does not carry a requestHash');
  const gateway = event.gateway;
  if (gateway === undefined) {
    reject(['gateway'], 'requires a gateway call');
    return;
  }
  const keyed = gateway.requestMac !== undefined;
  if (keyed !== (gateway.macKeyId !== undefined)) {
    // A MAC whose key is unnamed cannot be recomputed after a rotation, and a key id with
    // no MAC names a key nothing was taken under. Neither half is meaningful alone.
    reject(['gateway', 'macKeyId'], 'requires requestMac and macKeyId together');
  }
  if (event.kind === 'gateway_call_rejected') {
    if (gateway.rejection === undefined) reject(['gateway', 'rejection'], 'requires a rejection');
    if (gateway.decision !== undefined) reject(['gateway', 'decision'], 'carries no decision');
    // A malformed body is rejected before a canonical request exists, so it is the one
    // case with no MAC at all. `unknown_tool` does have one — a well-formed body still
    // keys, which is what makes repeated probing show up as one recurring MAC.
    if (gateway.rejection === 'malformed_request') {
      if (keyed) reject(['gateway', 'requestMac'], 'has no canonical request to key');
    } else if (!keyed) {
      reject(['gateway', 'requestMac'], 'requires requestMac');
    }
    // Neither of those two can name a tool: nothing parsed in the first case, and in the
    // second the name is by definition not one this gateway serves — so recording any
    // value here would name a tool the call was not for. The remaining rejections happen
    // after a served tool was identified, and a record that omits which one describes a
    // call that could have been either.
    const namesATool =
      gateway.rejection !== 'malformed_request' && gateway.rejection !== 'unknown_tool';
    if (namesATool && gateway.toolName === undefined) {
      reject(['gateway', 'toolName'], 'requires toolName');
    }
    if (!namesATool && gateway.toolName !== undefined) {
      reject(['gateway', 'toolName'], 'names no tool this gateway serves');
    }
    return;
  }
  // received/served: the call parsed, so it has both a tool and a MAC.
  if (gateway.rejection !== undefined) reject(['gateway', 'rejection'], 'carries no rejection');
  if (gateway.toolName === undefined) reject(['gateway', 'toolName'], 'requires toolName');
  if (!keyed) reject(['gateway', 'requestMac'], 'requires requestMac');
  if (event.kind === 'gateway_call_received') {
    // The start record is written BEFORE the secret resolves, which is before the call is
    // decided. A decision here would mean it was written after.
    if (gateway.decision !== undefined) reject(['gateway', 'decision'], 'carries no decision');
  } else if (gateway.decision === undefined) {
    reject(['gateway', 'decision'], 'requires a decision');
  }
}

/**
 * Canonical hash pre-image for an event: the domain tag, a NUL separator, and the canonical JSON of
 * the event with its own `eventHash` removed (so the hash covers every other field, including
 * `sequence` and `prevHash`). The server sha256-hashes this string to obtain `eventHash`. Taking the
 * event as input — rather than rebuilding a field list — guarantees the recorder and any verifier
 * hash exactly the same bytes.
 */
export function secretAuditEventPreimage(event: Omit<SecretAuditEvent, 'eventHash'>): string {
  // Defensively strip eventHash even if a full event is passed at runtime, so the hash can never
  // accidentally cover itself. canonicalJson sorts keys, so field order is irrelevant.
  const withoutHash: Record<string, unknown> = { ...event };
  delete withoutHash.eventHash;
  return `${SECRET_AUDIT_EVENT_DOMAIN}\0${canonicalJson(withoutHash)}`;
}

/** Filter for reading a project's audit trail. `sinceSequence` is an exclusive pagination cursor. */
export const secretAuditQuerySchema = z
  .object({
    projectId: secretContractIdSchema,
    kind: secretAuditEventKindSchema.optional(),
    grantId: secretContractIdSchema.optional(),
    jobId: secretContractIdSchema.optional(),
    requestHash: sha256HexSchema.optional(),
    /** Reconciliation reads the gateway's records by MAC — that is what it is for. */
    requestMac: sha256HexSchema.optional(),
    sinceSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
/** The caller-facing shape: `limit` is optional here and defaulted by the schema on parse. */
export type SecretAuditQuery = z.input<typeof secretAuditQuerySchema>;

/**
 * The authentic, hash-covered predicate for reading a trail. A caller re-applies this to the event
 * parsed from its canonical stored projection — never to a denormalized index column — so a mutated
 * index column can never surface a row whose true (hash-covered) content does not match the filter.
 */
export function secretAuditEventMatchesQuery(
  event: SecretAuditEvent,
  filter: Pick<
    SecretAuditQuery,
    'kind' | 'grantId' | 'jobId' | 'requestHash' | 'requestMac' | 'sinceSequence'
  >,
): boolean {
  return (
    (filter.kind === undefined || event.kind === filter.kind) &&
    (filter.grantId === undefined || event.grantId === filter.grantId) &&
    (filter.jobId === undefined || event.jobId === filter.jobId) &&
    (filter.requestHash === undefined || event.requestHash === filter.requestHash) &&
    (filter.requestMac === undefined || event.gateway?.requestMac === filter.requestMac) &&
    (filter.sinceSequence === undefined || event.sequence > filter.sinceSequence)
  );
}

/** The trusted head a caller can pin so tail truncation past it is detectable. */
export type SecretAuditChainHead = { sequence: number; eventHash: string };

export type SecretAuditChainVerification =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenAtSequence: number; reason: string };

/**
 * Verify a project's chain from an ordered event list and a hashing function (the server passes a
 * node:crypto sha256). Checks, fail-closed at the first break: the schema validates, the sequence
 * starts at 0 and is contiguous, the first `prevHash` is the genesis, each `prevHash` equals the
 * prior `eventHash`, and each `eventHash` equals the recomputed hash of the event pre-image.
 *
 * A bare chain still verifies after its newest events are dropped (a valid prefix). When the caller
 * knows the head it last trusted, it passes `expectedHead`; the verifier then also requires the
 * chain to end exactly at that `(sequence, eventHash)`, so tail truncation — or a fork that reused a
 * freed sequence — is rejected.
 */
export function verifySecretAuditChain(
  events: readonly SecretAuditEvent[],
  sha256Hex: (preimage: string) => string,
  expectedHead?: SecretAuditChainHead,
): SecretAuditChainVerification {
  let previousHash = SECRET_AUDIT_GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const parsed = secretAuditEventSchema.safeParse(event);
    if (!parsed.success) {
      return { ok: false, checked: index, brokenAtSequence: index, reason: 'invalid event' };
    }
    if (event.sequence !== index) {
      return {
        ok: false,
        checked: index,
        brokenAtSequence: index,
        reason: 'non-contiguous sequence',
      };
    }
    if (event.prevHash !== previousHash) {
      return { ok: false, checked: index, brokenAtSequence: index, reason: 'prev hash mismatch' };
    }
    const { eventHash, ...rest } = event;
    if (sha256Hex(secretAuditEventPreimage(rest)) !== eventHash) {
      return { ok: false, checked: index, brokenAtSequence: index, reason: 'event hash mismatch' };
    }
    previousHash = eventHash;
  }
  if (expectedHead !== undefined) {
    const last = events.at(-1);
    if (last === undefined || last.sequence !== expectedHead.sequence) {
      return {
        ok: false,
        checked: events.length,
        brokenAtSequence: expectedHead.sequence,
        reason: 'unexpected chain head',
      };
    }
    if (last.eventHash !== expectedHead.eventHash) {
      return {
        ok: false,
        checked: events.length,
        brokenAtSequence: expectedHead.sequence,
        reason: 'head hash mismatch',
      };
    }
  }
  return { ok: true, checked: events.length };
}
