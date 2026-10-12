import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from '@babel/core';

// Native rendering stays green when shared components lose their web style bindings:
// on web, route styles passed to an untransformed component never reach the DOM
// (the composer rendered black text inside the browser's default focus outline).
// Every design-system building block is shared by definition, so the whole
// folder is covered: a new component cannot silently miss the transform.
const uiComponents = readdirSync(resolve(__dirname, '../components/ui'))
  .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
  .map((file) => `ui/${file}`);

it('finds the design-system building blocks', () => {
  expect(uiComponents.length).toBeGreaterThan(0);
});

it.each([
  'settings/SettingsChrome.tsx',
  'settings/SettingsDisclosure.tsx',
  'PromptComposerInput.tsx',
  ...uiComponents,
])('transforms shared component styles in %s', (name) => {
  const filename = resolve(__dirname, '../components', name);
  const config = require('../babel.config.js')({ cache: () => undefined });
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let output;
  try {
    output = transformSync(readFileSync(filename, 'utf8'), {
      ...config,
      filename,
      cwd: resolve(__dirname, '..'),
      configFile: false,
      babelrc: false,
    });
  } finally {
    process.env.NODE_ENV = previous;
  }
  expect(output?.code).toContain('react-native-unistyles/components/native');
});
