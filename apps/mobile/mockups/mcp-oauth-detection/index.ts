import type { MockupSpec } from '../types';
import DetectionFailed from './detection-failed';

export const mcpOAuthDetectionSpec: MockupSpec = {
  id: 'mcp-oauth-detection',
  title: 'Concrete OAuth detection errors for MCP connections',
  screens: {
    'detection-failed': { title: 'Add MCP connection', Component: DetectionFailed },
  },
};
