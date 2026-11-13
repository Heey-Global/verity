import type { MockupSpec } from '../types';
import Accounts from './accounts';
import DeviceCode from './device-code';

export const aiAccountsSpec: MockupSpec = {
  id: 'ai-accounts',
  title: 'AI accounts per person',
  screens: {
    accounts: { title: 'AI accounts', Component: Accounts },
    'device-code': { title: 'Codex', Component: DeviceCode },
  },
};
