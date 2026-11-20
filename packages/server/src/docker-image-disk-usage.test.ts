import { expect, it } from 'vitest';
import { readImageDiskUsage } from './docker-image-disk-usage.js';

it('separates exclusive bytes from apparent image sizes without adding shared layers twice', async () => {
  const sizes = await readImageDiskUsage(async () => ({
    Images: [
      { Id: 'one', Size: 100, SharedSize: 70 },
      { Id: 'two', Size: 120, SharedSize: 70 },
    ],
  }));
  expect([...sizes.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(80);
});

it.each([
  undefined,
  {},
  { Images: [{ Id: 'one', Size: 100 }] },
  { Images: [{ Id: 'one', Size: 100, SharedSize: -1 }] },
  { Images: [{ Id: 'one', Size: 100, SharedSize: 110 }] },
])('refuses incomplete or inconsistent daemon accounting: %j', async (body) => {
  await expect(readImageDiskUsage(async () => body)).rejects.toThrow();
});

it('reads daemon accounting through the injected Docker transport', async () => {
  const { createDockerClient } = await import('./docker.js');
  let requested = '';
  const docker = createDockerClient({
    baseUrl: 'http://docker/v1.45',
    fetch: async (url) => {
      requested = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ Images: [{ Id: 'one', Size: 100, SharedSize: 70 }] }),
      };
    },
  });
  expect(await docker.imageDiskUsage?.()).toEqual(new Map([['one', 30]]));
  expect(requested).toBe('http://docker/v1.45/system/df');
});
