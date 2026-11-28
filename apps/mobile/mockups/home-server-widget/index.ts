import type { MockupSpec } from '../types';
import HomeCollapsedMockup from './home-collapsed';
import HomePhoneMockup from './home-phone';

/**
 * The server's machine at a glance, last on Home below Shared knowledge: one row
 * with the three figures that opens to CPU and memory with their last five
 * minutes and the disk as one fill bar.
 */
export const homeServerWidgetSpec: MockupSpec = {
  id: 'home-server-widget',
  title: 'Server widget on Home',
  screens: {
    'home-collapsed': { title: 'Home', Component: HomeCollapsedMockup },
    'home-phone': { title: 'Home', Component: HomePhoneMockup },
  },
};
