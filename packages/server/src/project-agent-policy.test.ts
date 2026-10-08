import { describe, expect, it } from 'vitest';
import {
  filterModelListForProject,
  modelAgent,
  PROJECT_AGENTS,
  resolveProjectDefaultModel,
} from './project-agent-policy.js';

const list = {
  models: ['claude-haiku-4-5', 'claude-opus-5-5', 'codex/gpt-5.6-sol', 'verity/kimi-k2'],
  moreModels: ['claude-haiku-4-5'],
  default: 'claude-opus-5-5',
};

describe('project agent policy', () => {
  // A stored rule naming an agent no model id routes to could never be satisfied.
  it('routes some model id to every agent a project can allow', () => {
    expect(new Set(list.models.map(modelAgent))).toEqual(new Set(PROJECT_AGENTS));
  });

  it('keeps the server default for an unrestricted project without its own default', () => {
    expect(resolveProjectDefaultModel(list, { defaultModel: null, allowedAgents: null })).toBe(
      'claude-opus-5-5',
    );
  });

  it('preserves an allowed Codex fallback when catalog discovery has no models', () => {
    expect(
      resolveProjectDefaultModel(
        { models: [], default: 'codex/default' },
        { defaultModel: null, allowedAgents: ['codex'] },
      ),
    ).toBe('codex/default');
    expect(
      resolveProjectDefaultModel(
        { models: [], default: 'codex/default' },
        { defaultModel: null, allowedAgents: ['claude'] },
      ),
    ).toBeUndefined();
  });

  it('ignores an explicit default the rule excludes and picks the first allowed primary model', () => {
    const settings = {
      defaultModel: 'claude-opus-5-5',
      allowedAgents: ['claude', 'opencode'] as const,
    };
    expect(resolveProjectDefaultModel(list, settings)).toBe('claude-opus-5-5');
    expect(
      resolveProjectDefaultModel(list, {
        defaultModel: 'claude-opus-5-5',
        allowedAgents: ['opencode'],
      }),
    ).toBe('verity/kimi-k2');
  });

  it('prefers primary models over the "More models" disclosure', () => {
    const onlyClaude = { ...list, default: undefined };
    expect(
      resolveProjectDefaultModel(onlyClaude, { defaultModel: null, allowedAgents: ['claude'] }),
    ).toBe('claude-opus-5-5');
  });

  it('filters every list a client renders, not only the flat one', () => {
    expect(
      filterModelListForProject(
        { ...list, modelOrder: [...list.models] },
        { defaultModel: null, allowedAgents: ['codex'] },
      ),
    ).toEqual({
      models: ['codex/gpt-5.6-sol'],
      modelOrder: ['codex/gpt-5.6-sol'],
      default: 'codex/gpt-5.6-sol',
      allowedAgents: ['codex'],
    });
  });
});
