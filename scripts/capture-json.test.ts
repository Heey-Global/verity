import { expect, it } from 'vitest';
import { captureJson } from './capture-json.mjs';

it('reads paginated JSON larger than the subprocess buffer limit', () => {
  const size = 2 * 1024 * 1024;
  const value = captureJson(process.execPath, [
    '-e',
    `process.stdout.write(JSON.stringify({body: 'x'.repeat(${size})}))`,
  ]) as { body: string };
  expect(value.body).toHaveLength(size);
});

it('propagates a failed API command instead of using incomplete JSON', () => {
  expect(() => captureJson(process.execPath, ['-e', 'process.exit(1)'])).toThrow();
});
