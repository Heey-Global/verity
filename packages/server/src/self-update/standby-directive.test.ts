import { describe, expect, it } from 'vitest';
import {
  createStandbyExchange,
  parseStandbyDirective,
  standbyDirectiveForPhase,
} from './standby-directive.js';

describe('standbyDirectiveForPhase', () => {
  /** Everything from the request to the end of the forward path: the old Server
   *  must not be the control plane while a candidate is becoming it. */
  it('asks for a standby across the whole promotion', () => {
    for (const phase of [
      'handing-off-key',
      'activating-candidate',
      'checking-candidate',
      'draining-gateway',
      'switching-gateway',
      'observing-candidate',
      'committed',
      'rollback-quiescing-candidate',
    ])
      expect(standbyDirectiveForPhase(phase, false)).toBe('quiesced');
  });

  /** A cutover has not fenced anything yet, and a rollback is putting the old
   *  generation back — both are states in which it serves. */
  it('leaves the old generation serving before and after the promotion', () => {
    for (const phase of [
      'requested',
      'pulling',
      'verifying-image',
      'preflight',
      'creating-standby',
      'standby',
      'rollback-activating-old',
      'rollback-switching-gateway',
      'rolled-back',
      'failed',
    ])
      expect(standbyDirectiveForPhase(phase, false)).toBe('serving');
  });

  /**
   * `quiescing-old` is journalled before the Gateway drains, and the drain only
   * means something while the old Server is still listening. So the phase alone
   * must not quiesce it — the cutover asks once it has drained.
   */
  it('waits for the drain before quiescing, then quiesces on request', () => {
    expect(standbyDirectiveForPhase('quiescing-old', false)).toBe('serving');
    expect(standbyDirectiveForPhase('quiescing-old', true)).toBe('quiesced');
  });

  /** The request is the Updater's RAM. A crash loses it, and losing it has to be
   *  safe: the phase reads as `serving`, so a standby comes back and the resumed
   *  cutover drains and asks again. */
  it('reads a phase past the request as quiesced without any request at all', () => {
    expect(standbyDirectiveForPhase('activating-candidate', false)).toBe('quiesced');
  });

  /** A request cannot make a rollback's own phases quiesce the Server they are
   *  bringing back. */
  it('never lets a stale request outvote a phase that means serving', () => {
    expect(standbyDirectiveForPhase('rollback-activating-old', true)).toBe('serving');
  });
});

describe('createStandbyExchange', () => {
  it('knows nothing until something is asked or answered', () => {
    const exchange = createStandbyExchange();
    expect(exchange.requested('generation-2')).toBeNull();
    expect(exchange.acknowledged('generation-2')).toBeNull();
  });

  it('keeps the request and the acknowledgement of one operation apart', () => {
    const exchange = createStandbyExchange();
    exchange.request('generation-2', 'quiesced');
    expect(exchange.acknowledged('generation-2')).toBeNull();
    exchange.acknowledge('generation-2', 'quiesced');
    expect(exchange.requested('generation-2')).toBe('quiesced');
    expect(exchange.acknowledged('generation-2')).toBe('quiesced');
  });

  /** A rollback asks for the opposite of what the cutover asked for, under the
   *  same operation id. */
  it('lets the same operation be asked for the other state', () => {
    const exchange = createStandbyExchange();
    exchange.request('generation-2', 'quiesced');
    exchange.acknowledge('generation-2', 'quiesced');
    exchange.request('generation-2', 'serving');
    exchange.acknowledge('generation-2', 'serving');
    expect(exchange.requested('generation-2')).toBe('serving');
    expect(exchange.acknowledged('generation-2')).toBe('serving');
  });

  /**
   * A follower acknowledges whatever directive it reads, so an answer to the
   * phase-derived `serving` is normally already on record when the cutover asks
   * for a quiesce. It answers a different question than the one now being asked.
   */
  it('drops an answer to a question that is no longer being asked', () => {
    const exchange = createStandbyExchange();
    exchange.acknowledge('generation-2', 'serving');
    exchange.request('generation-2', 'quiesced');
    expect(exchange.acknowledged('generation-2')).toBeNull();

    exchange.acknowledge('generation-2', 'quiesced');
    exchange.request('generation-2', 'serving');
    expect(exchange.acknowledged('generation-2')).toBeNull();
  });

  /** Asking again for what was already asked is the ordinary case — a resumed
   *  cutover re-entering the same phase — and must not throw the answer away. */
  it('keeps the answer when the same state is asked for again', () => {
    const exchange = createStandbyExchange();
    exchange.request('generation-2', 'quiesced');
    exchange.acknowledge('generation-2', 'quiesced');
    exchange.request('generation-2', 'quiesced');
    expect(exchange.acknowledged('generation-2')).toBe('quiesced');
  });

  /** An answer belongs to the operation it was given for. A later operation
   *  reusing it would promote a candidate on the strength of a Server that
   *  quiesced for a different update. */
  it('answers nothing for an operation it is not tracking', () => {
    const exchange = createStandbyExchange();
    exchange.request('generation-2', 'quiesced');
    exchange.acknowledge('generation-2', 'quiesced');
    expect(exchange.requested('generation-3')).toBeNull();
    expect(exchange.acknowledged('generation-3')).toBeNull();
  });

  /** One operation at a time, because the journal only ever has one — and
   *  moving on must not leave the previous answer readable. */
  it('drops the previous exchange when a new operation starts', () => {
    const exchange = createStandbyExchange();
    exchange.request('generation-2', 'quiesced');
    exchange.acknowledge('generation-2', 'quiesced');
    exchange.request('generation-3', 'quiesced');
    expect(exchange.acknowledged('generation-2')).toBeNull();
    expect(exchange.requested('generation-2')).toBeNull();
    expect(exchange.acknowledged('generation-3')).toBeNull();
  });

  /** An acknowledgement describes a process that is running right now; it may
   *  not outlive the boundary that collected it. */
  it('forgets everything when discarded', () => {
    const exchange = createStandbyExchange();
    exchange.request('generation-2', 'quiesced');
    exchange.acknowledge('generation-2', 'quiesced');
    exchange.discard();
    expect(exchange.requested('generation-2')).toBeNull();
    expect(exchange.acknowledged('generation-2')).toBeNull();
  });
});

describe('parseStandbyDirective', () => {
  it('accepts the two states and nothing else', () => {
    expect(parseStandbyDirective('serving')).toBe('serving');
    expect(parseStandbyDirective('quiesced')).toBe('quiesced');
    for (const value of ['SERVING', '', null, undefined, 0, {}, ['quiesced']])
      expect(parseStandbyDirective(value)).toBeNull();
  });
});
