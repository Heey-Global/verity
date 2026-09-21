import { describe, expect, it } from 'vitest';
import {
  isSandboxNotReadyError,
  markSandboxNotReady,
  SANDBOX_NOT_READY_ERROR_KIND,
  sandboxNotReadyError,
  turnFailureErrorKind,
} from './sandbox-lifecycle.js';

describe('the transient Sandbox-lifecycle failure class', () => {
  it('recognises only what was marked, and survives a re-wrap', () => {
    expect(isSandboxNotReadyError(sandboxNotReadyError('asleep'))).toBe(true);
    expect(isSandboxNotReadyError(new Error('the agent died'))).toBe(false);
    // Seams between the state check and the conductor re-raise with a `cause`. If
    // the class did not travel through one, the wrapped failure would quietly go
    // back to badging the session `crashed` — the exact bug, one layer deeper.
    const wrapped = new Error('could not prepare the turn', {
      cause: sandboxNotReadyError('asleep'),
    });
    expect(isSandboxNotReadyError(wrapped)).toBe(true);
  });

  it('does not serialize the marker into the transcript', () => {
    // The marker is plumbing between two server modules. Enumerable, it would ride
    // along into anything that spreads or JSON-encodes the error on its way to a
    // log line or an event payload.
    const error = markSandboxNotReady(new Error('asleep'));
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.parse(JSON.stringify({ ...error }))).toEqual({});
  });

  it('terminates on a cause cycle instead of spinning', () => {
    // A cause chain is operator-supplied structure in the end; a cycle must cost a
    // bounded walk, not the event loop.
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.defineProperty(first, 'cause', { value: second, configurable: true });
    expect(isSandboxNotReadyError(second)).toBe(false);
  });

  it('keeps the persisted kind for each class distinct', () => {
    expect(turnFailureErrorKind(sandboxNotReadyError('asleep'))).toBe(SANDBOX_NOT_READY_ERROR_KIND);
    expect(turnFailureErrorKind(new Error('the agent died'))).toBe('run_failed');
    // Non-Errors reach the reporter too (a rejected non-Error, a string throw).
    expect(turnFailureErrorKind('boom')).toBe('run_failed');
    expect(turnFailureErrorKind(undefined)).toBe('run_failed');
  });
});
