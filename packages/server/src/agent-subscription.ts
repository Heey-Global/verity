/**
 * The subscription plan behind a stored agent login, as a short label for the
 * provider's settings page ("Max 20x", "Plus").
 *
 * Both CLIs record the plan next to their tokens: Claude Code writes
 * `subscriptionType` (and, for Max, a `rateLimitTier` naming the 5x/20x
 * multiplier) into `.credentials.json`; Codex keeps the ChatGPT plan as a claim
 * in the `id_token` of `auth.json`. Neither is a secret, but both live inside
 * documents that are, so only the derived label may leave the server.
 *
 * Every reader returns `null` rather than throwing: a credential written by an
 * older CLI simply has no plan to show, and that must not break `GET /settings`.
 */

/** Plan identifiers as the CLIs spell them; anything else is not shown. */
const PLAN_ID = /^[a-z][a-z0-9_-]{0,39}$/u;

const CLAUDE_PLANS: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
};

const CODEX_PLANS: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

/** The OpenAI namespace the ChatGPT account claims live under in the id token. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

export function claudeSubscriptionPlan(credentialsJson: string | null | undefined): string | null {
  const oauth = record(parseJson(credentialsJson))?.claudeAiOauth;
  const fields = record(oauth);
  const plan = planLabel(fields?.subscriptionType, CLAUDE_PLANS);
  if (plan === null) return null;
  // `default_claude_max_20x` → "Max 20x": the multiplier is what separates the
  // two Max plans, and the quota meters below make no sense without it.
  const tier = typeof fields?.rateLimitTier === 'string' ? fields.rateLimitTier : '';
  const multiplier = /_(\d{1,3}x)$/u.exec(tier)?.[1];
  return multiplier === undefined ? plan : `${plan} ${multiplier}`;
}

export function codexSubscriptionPlan(authJson: string | null | undefined): string | null {
  const tokens = record(record(parseJson(authJson))?.tokens);
  const idToken = tokens?.id_token;
  if (typeof idToken !== 'string') return null;
  const payload = jwtPayload(idToken);
  const namespaced = record(payload?.[OPENAI_AUTH_CLAIM]);
  return planLabel(namespaced?.chatgpt_plan_type ?? payload?.chatgpt_plan_type, CODEX_PLANS);
}

function planLabel(value: unknown, known: Record<string, string>): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  if (!PLAN_ID.test(id)) return null;
  return (
    known[id] ??
    id
      .split(/[_-]/u)
      .filter((part) => part.length > 0)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(' ')
  );
}

function parseJson(value: string | null | undefined): unknown {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const encoded = token.split('.')[1];
  if (encoded === undefined) return undefined;
  try {
    return record(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
