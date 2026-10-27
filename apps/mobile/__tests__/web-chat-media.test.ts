import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

const appRoot = resolve(__dirname, '..');
const chat = readFileSync(resolve(appRoot, 'app/session/[id].tsx'), 'utf8');

// Native render mocks accept Unistyles objects directly, hiding the zero-height
// web container. Keep every chat image on the third-party style adapter.
it.each(['app/session/[id].tsx', 'components/ImageLightbox.tsx'])(
  '%s uses the shared styled image instead of the raw Expo component',
  (path) => {
    const source = readFileSync(resolve(appRoot, path), 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    const imports = ast.program.body.filter((node) => node.type === 'ImportDeclaration');
    const rawImages = imports.flatMap((node) =>
      node.source.value === 'expo-image'
        ? node.specifiers.filter(
            (specifier) =>
              specifier.type === 'ImportSpecifier' &&
              specifier.imported.type === 'Identifier' &&
              specifier.imported.name === 'Image',
          )
        : [],
    );
    expect(rawImages).toEqual([]);
    expect(imports.some((node) => /\/ui\/Image$/.test(node.source.value))).toBe(true);
  },
);

it('keeps the native selectable text view out of unhighlighted web code blocks', () => {
  // The third-party native UITextView falls back to an unadapted Text on web;
  // the route's own Text receives the Babel component transform and text color.
  expect(chat).toMatch(
    /Platform\.OS === 'web' \|\| searchHighlightQuery\s*\?\s*\(\s*<Text style=\{styles\.codeText\}/,
  );
});

it('adapts the shared image through Unistyles before forwarding styles to Expo', () => {
  const unistyles = require('react-native-unistyles');
  const adapter = jest.spyOn(unistyles, 'withUnistyles');
  const { Image } = require('../components/ui/Image');
  expect(adapter).toHaveBeenCalledWith(require('expo-image').Image);
  expect(Image).toBeDefined();
  adapter.mockRestore();
});
