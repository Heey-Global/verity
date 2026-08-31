import { describe, expect, it } from 'vitest';
import { buildRefinePrompt, parseRefinedTask } from './task-refine.js';

describe('buildRefinePrompt', () => {
  it('embeds the trimmed transcript and asks for a JSON-only blueprint', () => {
    const p = buildRefinePrompt('  add a dark mode toggle  ');
    expect(p).toContain('add a dark mode toggle');
    expect(p).toContain('Return ONLY a single JSON object');
    // The five blueprint keys are named so the model returns the expected shape.
    for (const key of [
      'title',
      'problem',
      'acceptanceCriteria',
      'affectedAreas',
      'openQuestions',
    ]) {
      expect(p).toContain(`"${key}"`);
    }
  });
});

describe('parseRefinedTask', () => {
  const full = {
    title: 'Add dark mode toggle',
    problem: 'Users want a dark theme.',
    acceptanceCriteria: ['Toggle in settings', 'Persists across restarts'],
    affectedAreas: ['settings.tsx'],
    openQuestions: ['Follow OS setting by default?'],
  };

  it('parses a clean JSON object', () => {
    expect(parseRefinedTask(JSON.stringify(full))).toEqual(full);
  });

  it('tolerates a ```json fence and surrounding prose', () => {
    const raw = 'Sure, here is the blueprint:\n```json\n' + JSON.stringify(full) + '\n```\nDone.';
    expect(parseRefinedTask(raw)).toEqual(full);
  });

  it('defaults missing arrays to empty and drops non-string / blank items', () => {
    const raw = JSON.stringify({
      title: 'T',
      problem: 'P',
      acceptanceCriteria: ['keep', 3, '', '  ', 'trim me  '],
      // affectedAreas + openQuestions omitted
    });
    expect(parseRefinedTask(raw)).toEqual({
      title: 'T',
      problem: 'P',
      acceptanceCriteria: ['keep', 'trim me'],
      affectedAreas: [],
      openQuestions: [],
    });
  });

  it('returns null for absent, unparseable, or title-less replies', () => {
    expect(parseRefinedTask(undefined)).toBeNull();
    expect(parseRefinedTask('not json at all')).toBeNull();
    expect(parseRefinedTask('{ broken')).toBeNull(); // no closing brace → never reaches JSON.parse
    expect(parseRefinedTask('{ "title": }')).toBeNull(); // braces present but invalid → JSON.parse throws (catch)
    expect(parseRefinedTask(JSON.stringify({ problem: 'no title' }))).toBeNull();
    expect(parseRefinedTask(JSON.stringify({ title: '   ' }))).toBeNull();
  });
});
