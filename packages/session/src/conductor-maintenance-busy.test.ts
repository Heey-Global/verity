import { describe, expect, it } from 'vitest';
import { Conductor } from './conductor.js';

// Maintenance claims the turn lock so turns wait, but it is not a turn: status
// overlays ask with `turnOnly` and must not see storage reclamation as work.
describe('Conductor.isBusy turnOnly', () => {
  it('reports a maintenance lock as busy but not as a turn', async () => {
    const conductor = new Conductor({
      store: {} as never,
      backend: {} as never,
      worktreeExists: async () => true,
    });
    const seen = await conductor.tryRunExclusive('s1', async () => ({
      busy: conductor.isBusy('s1'),
      turn: conductor.isBusy('s1', { turnOnly: true }),
    }));
    expect(seen).toEqual({ ran: true, value: { busy: true, turn: false } });
    expect(conductor.isBusy('s1')).toBe(false);
  });
});
