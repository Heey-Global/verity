import { describe, expect, it } from 'vitest';

import { claudeSubscriptionPlan, codexSubscriptionPlan } from './agent-subscription.js';

function idToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

function codexAuth(payload: Record<string, unknown>): string {
  return JSON.stringify({
    tokens: { id_token: idToken(payload), access_token: 'secret-access', refresh_token: 'r' },
  });
}

describe('claudeSubscriptionPlan', () => {
  it('names the Max multiplier, which is what separates the two Max plans', () => {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'secret-access',
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
    expect(claudeSubscriptionPlan(json)).toBe('Max 20x');
  });

  it('shows the plan alone when no tier is recorded', () => {
    const json = JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro' } });
    expect(claudeSubscriptionPlan(json)).toBe('Pro');
  });

  it.each([
    ['no credentials', null],
    ['unparseable JSON', '{'],
    ['a credential from a CLI that records no plan', JSON.stringify({ claudeAiOauth: {} })],
    // The label lands on screen verbatim; a token-shaped value must not.
    [
      'a value that is not a plan identifier',
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'sk-ant-oat01-' + 'a'.repeat(80) } }),
    ],
  ])('returns null for %s', (_label, json) => {
    expect(claudeSubscriptionPlan(json)).toBeNull();
  });
});

describe('codexSubscriptionPlan', () => {
  it('reads the plan from the namespaced ChatGPT claim of the id token', () => {
    const json = codexAuth({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } });
    expect(codexSubscriptionPlan(json)).toBe('Plus');
  });

  it('accepts the plan as a top-level claim', () => {
    expect(codexSubscriptionPlan(codexAuth({ chatgpt_plan_type: 'pro' }))).toBe('Pro');
  });

  it('title-cases a plan it does not know yet instead of hiding it', () => {
    expect(codexSubscriptionPlan(codexAuth({ chatgpt_plan_type: 'self_serve_business' }))).toBe(
      'Self Serve Business',
    );
  });

  it.each([
    ['no credentials', undefined],
    ['an API-key login without tokens', JSON.stringify({ OPENAI_API_KEY: 'sk-…' })],
    ['a malformed id token', JSON.stringify({ tokens: { id_token: 'not-a-jwt' } })],
  ])('returns null for %s', (_label, json) => {
    expect(codexSubscriptionPlan(json)).toBeNull();
  });
});
