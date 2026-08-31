/**
 * What a brokered HTTP approval card shows (ADR 0011 D1): which request, which
 * secret, and — decisively — what the secret is used *for*.
 *
 * The two auth modes are nothing alike to whoever approves them. Under `static`
 * the secret is the credential and travels to the API verbatim in a header.
 * Under `jwt` the secret is a private key that never leaves the server; what
 * reaches the API is an assertion Verity mints, and its algorithm, audience,
 * claim sources and lifetime are the thing being authorized — a standing grant
 * is keyed on exactly those fields. A card that read the JWT case as static
 * would name the wrong mechanism and hide every field that tells one assertion
 * apart from another, which is what "Always" would then be kept for.
 *
 * Null when the input does not parse, including an auth block that is only
 * partly readable. The caller then shows the raw input rather than a confident
 * summary of a shape it did not understand.
 */
export type BrokeredJwtClaimSummary = {
  /** Human name of the claim: `issuer`, `key id`, `subject`, `scope`. */
  claim: string;
  /** `from secret ASC_ISSUER_ID` for a resolved alias, or the public literal. */
  source: string;
};

export type BrokeredAuthSummary =
  | { kind: 'static'; header: string; scheme: string | null }
  | {
      kind: 'jwt';
      algorithm: string;
      audience: string;
      claims: BrokeredJwtClaimSummary[];
      /**
       * Null when the request names no lifetime and the server applies the
       * contract default. Stated as "default" rather than restating the number
       * here, so the card can never quote a window the server has moved on from.
       */
      expiresInSeconds: number | null;
    };

export type BrokeredHttpSummary = {
  method: string;
  host: string;
  path: string;
  secretAlias: string;
  auth: BrokeredAuthSummary;
  body: string | null;
};

/**
 * A non-empty string safe to drop into the card sentence, or null.
 *
 * `brokeredHttpRequestSchema` already holds these fields to printable ASCII, so
 * on every path that reaches approval through it this is a second lock on the
 * same door. It is here anyway because this function's whole contract is that it
 * takes `unknown`: it is the last thing between a tool input and a sentence the
 * operator approves, and it should not depend on having been fed by a validator
 * to stay honest. A control character splits that sentence, and a bidi override
 * reverses what follows it, so a value carrying either would render a card that
 * misdescribes the assertion being signed.
 *
 * Refusing yields `null` up the chain, which drops the card back to the raw tool
 * view — the operator then reads the escaped JSON instead of prose built from a
 * string chosen to deceive. That is the same "unreadable is a parse failure,
 * never a quiet omission" rule the claim loop below already follows.
 */
function cardText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return /^[\x20-\x7e]+$/.test(raw) ? raw : null;
}

/** Alias names are not secret (ADR 0011 D3), so the card can name the source. */
function claimSource(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const alias = cardText(value['alias']);
  if (alias !== null) return `from secret ${alias}`;
  const literal = cardText(value['literal']);
  if (literal !== null) return literal;
  return null;
}

const JWT_CLAIMS = [
  { claim: 'key id', key: 'keyId', required: false },
  { claim: 'issuer', key: 'issuer', required: true },
  { claim: 'subject', key: 'subject', required: false },
] as const;

function parseJwtAuth(auth: Record<string, unknown>): BrokeredAuthSummary | null {
  const algorithm = cardText(auth['algorithm']);
  const audience = cardText(auth['audience']);
  if (algorithm === null || audience === null) return null;
  const claims: BrokeredJwtClaimSummary[] = [];
  for (const { claim, key, required } of JWT_CLAIMS) {
    const raw = auth[key];
    if (raw === undefined) {
      if (required) return null;
      continue;
    }
    // Present but unreadable is a parse failure, never a quiet omission: a claim
    // dropped from the card is a claim approved unseen.
    const source = claimSource(raw);
    if (source === null) return null;
    claims.push({ claim, source });
  }
  const rawScope = auth['scope'];
  if (rawScope !== undefined) {
    const scope = cardText(rawScope);
    if (scope === null) return null;
    claims.push({ claim: 'scope', source: scope });
  }
  const lifetime = auth['expiresInSeconds'];
  if (lifetime !== undefined && (typeof lifetime !== 'number' || !Number.isFinite(lifetime))) {
    return null;
  }
  return {
    kind: 'jwt',
    algorithm,
    audience,
    claims,
    expiresInSeconds: lifetime === undefined ? null : lifetime,
  };
}

function parseAuth(raw: unknown): BrokeredAuthSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const auth = raw as Record<string, unknown>;
  if (auth['kind'] === 'jwt') return parseJwtAuth(auth);
  const header = cardText(auth['header']);
  const rawScheme = auth['scheme'];
  if (header === null) return null;
  // `null` is the meaningful "no scheme" spelling for x-api-key, not a failure.
  const scheme = rawScheme === null ? null : cardText(rawScheme);
  if (rawScheme !== null && scheme === null) return null;
  return { kind: 'static', header, scheme };
}

export function brokeredHttpSummary(rawInput: unknown): BrokeredHttpSummary | null {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return null;
  const input = rawInput as Record<string, unknown>;
  const url = typeof input['url'] === 'string' ? input['url'] : null;
  // Both name the request in the card's title and sentence. The URL is not run
  // through cardText: `new URL` below punycodes the host and percent-escapes the
  // path, which is a stricter normalization than a character class would be.
  const secretAlias = cardText(input['secretAlias']);
  const method = input['method'] === undefined ? 'GET' : cardText(input['method']);
  if (url === null || secretAlias === null || method === null) return null;
  const auth = parseAuth(input['auth']);
  if (auth === null) return null;
  try {
    const parsed = new URL(url);
    return {
      method,
      host: parsed.host,
      path: `${parsed.pathname}${parsed.search}` || '/',
      secretAlias,
      auth,
      body: input['body'] === undefined ? null : (JSON.stringify(input['body'], null, 2) ?? null),
    };
  } catch {
    return null;
  }
}

/** Card headline. Signing with a key is a different act from sending a token. */
export function brokeredHttpTitle(summary: BrokeredHttpSummary): string {
  return summary.auth.kind === 'jwt'
    ? `Sign with key ${summary.secretAlias}?`
    : `Use secret ${summary.secretAlias}?`;
}

/** The sentence under the request: what Verity does with the named secret. */
export function brokeredAuthSentence(summary: BrokeredHttpSummary): string {
  if (summary.auth.kind === 'static') {
    const scheme = summary.auth.scheme === null ? '' : ` using ${summary.auth.scheme}`;
    return `Verity sends ${summary.secretAlias} in the ${summary.auth.header} header${scheme} to ${summary.host}. The secret stays server-side; the agent gets the status and the response with the secret redacted.`;
  }
  const claims = summary.auth.claims.map((entry) => `${entry.claim} ${entry.source}`).join(', ');
  const lifetime =
    summary.auth.expiresInSeconds === null
      ? "Verity's default lifetime"
      : `${summary.auth.expiresInSeconds} seconds`;
  return `Verity signs a ${summary.auth.algorithm} assertion with the private key ${summary.secretAlias} and sends it to ${summary.host} as authorization: Bearer. Audience ${summary.auth.audience}${claims === '' ? '' : `, ${claims}`}; valid for ${lifetime}. The key itself never leaves the server; the agent gets the status and the response with every named secret redacted.`;
}
