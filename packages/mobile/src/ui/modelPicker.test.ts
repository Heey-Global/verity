import { describe, expect, it } from 'vitest';
import {
  defaultModel,
  engineLabel,
  modelDisplayName,
  orderModels,
  partitionModels,
} from './modelPicker.js';

describe('modelDisplayName', () => {
  it('title-cases a bare Claude id and fuses the version parts', () => {
    expect(modelDisplayName('claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(modelDisplayName('claude-sonnet-5')).toBe('Claude Sonnet 5');
  });

  it('drops an 8-digit date stamp from a dated Claude id', () => {
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
  });

  it('shows the Codex default as just "Codex"', () => {
    expect(modelDisplayName('codex/default')).toBe('Codex');
  });

  it('appends a named Codex slug', () => {
    expect(modelDisplayName('codex/gpt-5')).toBe('Codex gpt-5');
  });

  it('keeps the trailing segment of an OpenCode provider-qualified id', () => {
    expect(modelDisplayName('deepinfra/zai-org/GLM-5.2')).toBe('GLM-5.2');
    expect(modelDisplayName('deepinfra/moonshotai/Kimi-K2.7-Code')).toBe('Kimi-K2.7-Code');
  });

  it('falls back to "Claude" for the server default (undefined/empty)', () => {
    expect(modelDisplayName(undefined)).toBe('Claude');
    expect(modelDisplayName('')).toBe('Claude');
  });
});

describe('engineLabel', () => {
  it('maps each id shape to its ADR-0001 engine', () => {
    expect(engineLabel('claude-opus-4-8')).toBe('Claude');
    expect(engineLabel('codex/default')).toBe('Codex');
    expect(engineLabel('deepinfra/zai-org/GLM-5.2')).toBe('OpenCode');
    expect(engineLabel(undefined)).toBe('Claude');
  });
});

describe('orderModels (#143)', () => {
  it('sorts models alphabetically by id', () => {
    const models = [
      'claude-opus-4-8',
      'deepinfra/zai-org/GLM-5.2',
      'codex/default',
      'deepinfra/moonshotai/Kimi-K2.7-Code',
      'claude-haiku-4-5-20251001',
    ];
    expect(orderModels(models)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'codex/default',
      'deepinfra/moonshotai/Kimi-K2.7-Code',
      'deepinfra/zai-org/GLM-5.2',
    ]);
  });

  it('de-duplicates repeated ids before rendering sheet rows', () => {
    const out = orderModels(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-4-8']);
    expect(out).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(new Set(out).size).toBe(out.length);
  });

  it('does not mutate its input', () => {
    const models = ['deepinfra/zai-org/GLM-5.2', 'claude-opus-4-8'];
    const snapshot = [...models];
    orderModels(models);
    expect(models).toEqual(snapshot);
  });

  it('returns [] for an empty list', () => {
    expect(orderModels([])).toEqual([]);
  });
});

describe('defaultModel (#143)', () => {
  it('uses the server default when it is an offered model', () => {
    const models = ['claude-haiku-4-5-20251001', 'claude-opus-4-8'];
    expect(defaultModel(models, 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('falls back to the first offered model when the default is not offered', () => {
    const models = ['claude-haiku-4-5-20251001', 'deepinfra/zai-org/GLM-5.2'];
    expect(defaultModel(models, 'claude-opus-4-8')).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to the first offered model when no default is given', () => {
    const models = ['claude-haiku-4-5-20251001', 'claude-opus-4-8'];
    expect(defaultModel(models, undefined)).toBe('claude-haiku-4-5-20251001');
  });

  it('is undefined for an empty list (spawn sends no model -> server default)', () => {
    expect(defaultModel([], 'claude-opus-4-8')).toBeUndefined();
    expect(defaultModel([], undefined)).toBeUndefined();
  });
});

describe('partitionModels', () => {
  it('keeps Claude and priority Codex models visible and moves only nominated models', () => {
    expect(
      partitionModels(
        ['claude-opus-4-8', 'codex/gpt-5.6-sol', 'codex/gpt-5.4', 'claude-haiku-4-5'],
        ['codex/gpt-5.4'],
        ['claude-haiku-4-5', 'claude-opus-4-8', 'codex/gpt-5.6-sol', 'codex/gpt-5.4'],
      ),
    ).toEqual({
      primary: ['claude-haiku-4-5', 'claude-opus-4-8', 'codex/gpt-5.6-sol'],
      more: ['codex/gpt-5.4'],
    });
  });

  it('preserves provider priority within both groups', () => {
    expect(
      partitionModels(
        ['codex/gpt-5.6-luna', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra', 'codex/gpt-5.5'],
        ['codex/gpt-5.5'],
        ['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra', 'codex/gpt-5.6-luna', 'codex/gpt-5.5'],
      ),
    ).toEqual({
      primary: ['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra', 'codex/gpt-5.6-luna'],
      more: ['codex/gpt-5.5'],
    });
  });

  it('ignores stale and duplicate disclosure ids', () => {
    expect(partitionModels(['codex/a', 'codex/b'], ['codex/b', 'codex/b', 'codex/stale'])).toEqual({
      primary: ['codex/a'],
      more: ['codex/b'],
    });
  });
});
