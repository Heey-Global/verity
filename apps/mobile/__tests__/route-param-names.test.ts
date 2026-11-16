// React Navigation reserves a few param names for nested navigation: a route
// param called `screen` (or `params`, `initial`, `state`, `path`, `merge`) is
// read as an instruction to navigate inside a nested navigator. A deep link to
// such a route finds no nested screen and lands on Home without an error, so
// the route never renders and every test that renders it directly stays green.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const RESERVED = new Set(['screen', 'params', 'initial', 'state', 'path', 'merge']);
const APP_DIR = join(__dirname, '..', 'app');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? routeFiles(path) : [path];
  });
}

it('names no dynamic route segment after a reserved navigation param', () => {
  const segments = routeFiles(APP_DIR).flatMap((file) =>
    relative(APP_DIR, file)
      .replace(/\.tsx?$/, '')
      .split(/[\\/]/)
      .map((segment) => /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(segment)?.[1])
      .filter((name): name is string => name !== undefined)
      .map((name) => ({ file: relative(APP_DIR, file), name })),
  );
  expect(segments.length).toBeGreaterThan(0);
  expect(segments.filter(({ name }) => RESERVED.has(name))).toEqual([]);
});
