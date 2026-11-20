import type { MockupSpec } from '../types';
import Ready from './ready';
import Loading from './loading';
import ErrorState from './error';
export const nativeMcpAppsSpec: MockupSpec = {
  id: 'native-mcp-apps',
  title: 'Native MCP Apps',
  screens: {
    ready: { title: 'Interactive app', Component: Ready },
    loading: { title: 'Loading', Component: Loading },
    error: { title: 'Last result and retry', Component: ErrorState },
  },
};
