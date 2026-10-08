import { describe, expect, it } from 'vitest';
import { localPreviewPorts } from './local-preview-ports.js';

describe('local preview port range', () => {
  it('allocates every port in the configured range', () => {
    expect(localPreviewPorts('9200-9202')).toEqual([9200, 9201, 9202]);
  });
  it.each(['8081-8084', '1-20', '8100-8300', '9202-9200', 'foo', '65530-65536'])(
    'rejects invalid or conflicting range %s',
    (value) => {
      expect(() => localPreviewPorts(value)).toThrow();
    },
  );
});
