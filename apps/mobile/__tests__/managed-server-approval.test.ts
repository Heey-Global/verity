import { Alert } from 'react-native';
import type { ManagedDevServer } from '@verity/mobile';
import {
  confirmManagedServerApproval,
  managedServerApproval,
  managedServerSecretDescription,
} from '../components/project/managedServerApproval';

const server = (): ManagedDevServer => ({
  id: 'server',
  name: 'API',
  command: 'node server.mjs',
  workdir: '.',
  approved: false,
  secretBindings: [{ secretAlias: 'ATTENDEE_API_KEY', env: 'API_KEY' }],
  providerSnapshot: { provider: 'doppler', project: 'demo', config: 'staging' },
  instance: null,
  elsewhere: [],
});

it('keeps the displayed command, aliases and provider unchanged while either dialog is open', () => {
  const current = server();
  const seen = managedServerApproval(current);
  const description = managedServerSecretDescription(seen);
  current.command = 'node changed.mjs';
  current.secretBindings[0]!.env = 'OTHER';
  current.providerSnapshot!.config = 'production';
  expect(seen).toEqual({
    command: 'node server.mjs',
    workdir: '.',
    secretBindings: [{ secretAlias: 'ATTENDEE_API_KEY', env: 'API_KEY' }],
    providerSnapshot: { provider: 'doppler', project: 'demo', config: 'staging' },
  });
  expect(managedServerSecretDescription(seen)).toBe(description);
  expect(description).toContain('Doppler · demo / staging');
  expect(description).toContain('ATTENDEE_API_KEY → API_KEY');
});

it.each([null, undefined])(
  'refuses secret approvals without provider metadata: %s',
  (providerSnapshot) => {
    expect(() => managedServerApproval({ ...server(), providerSnapshot })).toThrow(
      'cannot be verified',
    );
  },
);

it('keeps secret-free servers compatible with older Cores', () => {
  const seen = managedServerApproval({
    ...server(),
    secretBindings: [],
    providerSnapshot: undefined,
  });
  expect(seen).toEqual({ command: 'node server.mjs', workdir: '.' });
  expect(managedServerSecretDescription(seen)).toBe('');
});

it.each(['Allow API locally?', 'Allow API on your network?'])(
  'confirms the captured provider in %s',
  async (title) => {
    const seen = managedServerApproval(server());
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const result = confirmManagedServerApproval(seen, {
      title,
      action: 'Allow',
      warning: 'Anyone on your network can open it while it runs.',
    });
    expect(alert.mock.calls[0]?.[0]).toBe(title);
    expect(alert.mock.calls[0]?.[1]).toContain('Doppler · demo / staging');
    alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Allow')?.onPress?.();
    expect(await result).toBe(true);
    alert.mockRestore();
  },
);

it('carries both displayed sources and the captured authority into approval', async () => {
  const current = server();
  current.providerSnapshot = {
    ...current.providerSnapshot!,
    authority: 'approved-sources',
    sources: [
      { connectionId: 'platform', connectionLabel: 'Platform', project: 'demo', config: 'staging' },
      { connectionId: 'payments', workplaceSlug: 'payments', project: 'billing', config: 'dev' },
    ],
  };
  const seen = managedServerApproval(current);
  current.providerSnapshot.authority = 'changed';
  current.providerSnapshot.sources![1]!.config = 'prd';
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    const confirmed = confirmManagedServerApproval(seen, {
      title: 'Allow API locally?',
      action: 'Allow',
      warning: 'The API will run locally.',
    });
    expect(alert.mock.calls[0]?.[1]).toContain('demo / staging · Platform (platform)');
    expect(alert.mock.calls[0]?.[1]).toContain('billing / dev · Connection (workplace payments)');
    alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Allow')?.onPress?.();
    await expect(confirmed).resolves.toBe(true);
    expect(seen.providerSnapshot).toMatchObject({
      authority: 'approved-sources',
      sources: [{ config: 'staging' }, { config: 'dev' }],
    });
  } finally {
    alert.mockRestore();
  }
});
