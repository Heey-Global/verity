import type { MockupSpec } from '../types';
import HomeUpdatingMockup from './home-updating';
import SessionPhoneMockup from './session-phone';
import SessionUnreachableMockup from './session-unreachable';
import SettingsReconnectedMockup from './settings-reconnected';

/**
 * Central server connection status: one strip under the top bar replaces the
 * per-screen "server maintenance" banners and reconnects by itself. Sample content only.
 */
export const connectionStatusSpec: MockupSpec = {
  id: 'connection-status',
  title: 'Central server connection status',
  screens: {
    'home-updating': { title: 'Verity', Component: HomeUpdatingMockup },
    'session-unreachable': { title: 'Verity', Component: SessionUnreachableMockup },
    'settings-reconnected': { title: 'Settings', Component: SettingsReconnectedMockup },
    'session-phone': { title: 'Teammitglieder Einladen', Component: SessionPhoneMockup },
  },
};
