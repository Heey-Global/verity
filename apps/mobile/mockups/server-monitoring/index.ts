import type { MockupSpec } from '../types';
import DetailMode from './detail-mode';
import DetailModeActive from './detail-mode-active';
import Diagnostics from './diagnostics';
import Report from './report';

/**
 * Server monitoring in Settings › Diagnostics: switches for measurement and
 * detail mode, and the shareable diagnostic report. Sample content only; nothing here talks to a server.
 */
export const serverMonitoringSpec: MockupSpec = {
  id: 'server-monitoring',
  title: 'Server monitoring',
  screens: {
    diagnostics: { title: 'Diagnostics', Component: Diagnostics },
    'detail-mode': { title: 'Diagnostics', Component: DetailMode },
    'detail-mode-active': { title: 'Diagnostics', Component: DetailModeActive },
    report: { title: 'Diagnostic report', Component: Report },
  },
};
