import { describe, expect, it } from 'vitest';

import { preselectModel } from './session-create-route.js';

describe('preselectModel', () => {
  // A person's own project default wins only when they can use it; otherwise the
  // model they last started with, otherwise the first their accounts offer.
  it('takes the first candidate the person can use', () => {
    const usable = (model: string) => model.startsWith('codex/');
    expect(preselectModel(['claude-opus-5-5', 'codex/gpt-5.5', 'codex/x'], usable)).toBe(
      'codex/gpt-5.5',
    );
    expect(preselectModel([null, null, 'codex/x'], usable)).toBe('codex/x');
    expect(preselectModel(['claude-opus-5-5', null], usable)).toBeUndefined();
  });
});
