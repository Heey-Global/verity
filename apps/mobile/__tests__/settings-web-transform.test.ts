import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from '@babel/core';

// Native rendering stays green when shared components lose their web style bindings.
it.each(['SettingsChrome.tsx', 'SettingsDisclosure.tsx'])(
  'transforms shared settings styles in %s',
  (name) => {
    const filename = resolve(__dirname, '../components/settings', name);
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
  },
);
