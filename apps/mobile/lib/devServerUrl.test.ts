import type { DevServer } from '@verity/mobile';

import { devServerUrl } from './devServerUrl';

const server = {
  id: 'dev-1',
  projectId: 'project-1',
  sourceKey: null,
  name: 'Web',
  command: 'npm run dev',
  url: null,
  workdir: null,
  hostPort: '3099',
  containerPort: '3000',
  previewSessionId: null,
  autoStart: false,
  running: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies DevServer;

describe('devServerUrl', () => {
  it.each(['http://0.0.0.0:3000', 'http://[::]:3000'])(
    'rewrites wildcard bind URL %s to the published Verity host',
    (url) => {
      expect(devServerUrl('https://verity.example.test:8082', { ...server, url })).toBe(
        'http://verity.example.test:3099/',
      );
    },
  );
  it('uses the Verity host and the published Dev Server port', () => {
    expect(devServerUrl('https://verity.example.test:8082', server)).toBe(
      'http://verity.example.test:3099/',
    );
  });

  it('rewrites loopback URLs for the mobile device', () => {
    expect(
      devServerUrl('http://192.168.1.20:8082', {
        ...server,
        url: 'http://localhost:3000/dashboard',
      }),
    ).toBe('http://192.168.1.20:3099/dashboard');
  });

  it('keeps an explicitly configured remote URL', () => {
    expect(
      devServerUrl('http://192.168.1.20:8082', {
        ...server,
        url: 'https://preview.example.test/app',
      }),
    ).toBe('https://preview.example.test/app');
  });

  it('rejects non-web URL schemes', () => {
    expect(
      devServerUrl('http://192.168.1.20:8082', { ...server, url: 'javascript:alert(1)' }),
    ).toBe(null);
    expect(devServerUrl('file:///tmp/verity', server)).toBe(null);
  });

  it('validates configured URLs even without a published host port', () => {
    expect(
      devServerUrl('https://verity.example.test', {
        ...server,
        hostPort: null,
        url: 'https://preview.example.test/app',
      }),
    ).toBe('https://preview.example.test/app');
    expect(
      devServerUrl('https://verity.example.test', {
        ...server,
        hostPort: null,
        url: 'javascript:alert(1)',
      }),
    ).toBeNull();
  });
});
