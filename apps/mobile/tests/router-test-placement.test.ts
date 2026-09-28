import { readdirSync } from 'node:fs';
import { join } from 'node:path';

it('keeps Jest files outside Expo Router routes', () => {
  // Expo Router includes files in app/ in production bundles, even when they are tests.
  const visit = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? visit(path) : [path];
    });

  expect(
    visit(join(__dirname, '../app')).filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path)),
  ).toEqual([]);
});
