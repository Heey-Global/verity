import { describeRunningUpdate, readRunningUpdate, type RunningUpdate } from './updateStatus';

describe('readRunningUpdate', () => {
  it('reports disabled without touching the other constants', () => {
    const result = readRunningUpdate({
      isEnabled: false,
      // Getters that throw if touched — proves readRunningUpdate short-circuits on
      // `isEnabled === false` and never reads the other constants.
      get isEmbeddedLaunch(): never {
        throw new Error('should not read isEmbeddedLaunch when disabled');
      },
      get updateId(): never {
        throw new Error('should not read updateId when disabled');
      },
      get createdAt(): never {
        throw new Error('should not read createdAt when disabled');
      },
    });
    expect(result).toEqual({
      isEnabled: false,
      isEmbeddedLaunch: false,
      updateId: null,
      createdAt: null,
    });
  });

  it('passes through the constants when enabled', () => {
    const createdAt = new Date('2026-07-17T18:25:41Z');
    expect(
      readRunningUpdate({
        isEnabled: true,
        isEmbeddedLaunch: false,
        updateId: 'abc12345-6789',
        createdAt,
      }),
    ).toEqual({ isEnabled: true, isEmbeddedLaunch: false, updateId: 'abc12345-6789', createdAt });
  });
});

describe('describeRunningUpdate', () => {
  const base: RunningUpdate = {
    isEnabled: true,
    isEmbeddedLaunch: false,
    updateId: 'abc12345-6789-0000',
    createdAt: new Date('2026-07-17T18:25:41Z'),
  };

  it('labels a disabled runtime as off', () => {
    expect(describeRunningUpdate({ ...base, isEnabled: false })).toEqual({
      active: false,
      text: 'off',
    });
  });

  it('labels the embedded bundle as built-in', () => {
    expect(describeRunningUpdate({ ...base, isEmbeddedLaunch: true })).toEqual({
      active: false,
      text: 'built-in',
    });
  });

  it('labels a missing updateId as built-in', () => {
    expect(describeRunningUpdate({ ...base, updateId: null })).toEqual({
      active: false,
      text: 'built-in',
    });
  });

  it('shows the short id and timestamp for a live OTA update', () => {
    const result = describeRunningUpdate(base);
    expect(result.active).toBe(true);
    expect(result.text.startsWith('abc12345 · ')).toBe(true);
    // The timestamp half is locale-formatted; assert the id + separator are present.
    expect(result.text).toContain(base.createdAt!.toLocaleString());
  });

  it('falls back to just the short id when createdAt is missing', () => {
    expect(describeRunningUpdate({ ...base, createdAt: null })).toEqual({
      active: true,
      text: 'abc12345',
    });
  });
});
