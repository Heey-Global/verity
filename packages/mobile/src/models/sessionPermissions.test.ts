import { describe, expect, it } from 'vitest';

import { VerityApiError } from '../api.js';
import { permissionDecisionFailure, scopedDecisionNotice } from './sessionPermissions.js';

describe('scopedDecisionNotice', () => {
  // A notice that said "Decision failed" over an action that already ran sent
  // operators to answer again; each text must match what the server reported.
  it('says nothing ran when the server stopped the action', () => {
    const text = scopedDecisionNotice({ scopeSaved: false, actionContinued: false });
    expect(text).toMatch(/^Not run: /);
    expect(text).toContain('could not be saved');
    expect(text).toContain('Review again');
    expect(text).toContain('ask the agent for a new request');
    expect(text).not.toContain('allowed');
    expect(scopedDecisionNotice({ scopeSaved: true, actionContinued: false })).toMatch(
      /^Not run: the approval was saved/,
    );
  });

  it('says the request ran when only the reusable approval was lost', () => {
    const text = scopedDecisionNotice({ scopeSaved: false, actionContinued: true });
    expect(text).toMatch(/^Request allowed/);
    expect(text).not.toContain('Not run');
  });

  it('stays quiet when the approval was saved and the action went on', () => {
    expect(scopedDecisionNotice({ scopeSaved: true, actionContinued: true })).toBeUndefined();
    expect(scopedDecisionNotice({})).toBeUndefined();
  });

  it('does not claim either outcome for a server that does not report it', () => {
    const text = scopedDecisionNotice({ scopeSaved: false });
    expect(text).not.toMatch(/Not run|Request allowed/);
  });
});

describe('permissionDecisionFailure', () => {
  it('keeps the server message and replaces anything else with one sentence', () => {
    expect(permissionDecisionFailure(new VerityApiError(500, 'boom'))).toBe(
      'Decision failed: boom',
    );
    expect(permissionDecisionFailure(new Error('raw'))).toBe(
      'Decision failed: the decision could not be sent',
    );
  });
});
