import { describe, expect, it } from 'vitest';
import { packageInstallSummary, packageInstallDecision } from './packageInstallSummary.js';

describe('packageInstallSummary', () => {
  it('distinguishes Skip from cancellation and gives setup its own action', () => {
    expect(packageInstallDecision(true, 'secondary')).toEqual({
      behavior: 'allow',
      updatedInput: { action: 'skip' },
    });
    expect(packageInstallDecision(true, 'primary')).toEqual({
      behavior: 'allow',
      updatedInput: { action: 'configure' },
    });
    expect(packageInstallDecision(false, 'secondary')).toEqual({ behavior: 'deny' });
    expect(packageInstallDecision(false, 'primary')).toEqual({
      behavior: 'allow',
      updatedInput: { action: 'install' },
    });
  });
  it.each(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv'])(
    'offers the same setup choice for supported %s',
    (manager) => {
      const summary = packageInstallSummary({
        command: `${manager} install example`,
        manager,
        supported: true,
      });
      expect(summary).toMatchObject({
        command: `${manager} install example`,
        supported: true,
        allowLabel: 'Set up delay',
        denyLabel: 'Skip',
      });
      expect(summary?.explanation).toContain('at least 3 days');
    },
  );

  it('offers an explicit install or cancel decision when protection cannot be configured', () => {
    const summary = packageInstallSummary({
      command: 'yarn add example',
      manager: 'Yarn 1',
      supported: false,
    });
    expect(summary).toMatchObject({
      supported: false,
      allowLabel: 'Install anyway',
      denyLabel: 'Cancel',
    });
    expect(summary?.explanation).toContain("can't delay new versions for Yarn 1");
  });

  it.each([null, [], {}, { command: 'npm install', manager: 'npm', supported: 'true' }])(
    'does not claim protection for malformed input',
    (input) => {
      expect(packageInstallSummary(input)).toBeNull();
    },
  );
});
