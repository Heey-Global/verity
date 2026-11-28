import type { MockupSpec } from '../types';
import HomePhoneMockup from './home-phone';

/**
 * The server's machine at a glance, last on Home below Shared knowledge: CPU and
 * memory with their last five minutes, and the disk as one fill bar.
 */
export const homeServerWidgetSpec: MockupSpec = {
  id: 'home-server-widget',
  title: 'Server widget on Home',
  screens: {
    'home-phone': { title: 'Home', Component: HomePhoneMockup },
  },
};
