import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const require = createRequire(import.meta.url);
let cliManifest: string | undefined;
try {
  cliManifest = require.resolve('@expo/cli/package.json');
} catch (error) {
  // Server-only installs omit Expo; the full mobile CI job must exercise this guard.
  if (process.env.VERITY_REQUIRE_MOBILE_NATIVE === '1') throw error;
}
let cliRequire: NodeJS.Require;
let PluginSchema: unknown;
let DevToolsPluginOutputSchema: unknown;
let validate: (schema: unknown, data: unknown) => void;
let createMCPDevToolsExtensionSchema: (plugin: unknown, zod: typeof z) => z.ZodObject;

// A major-version override must retain the CLI's plugin and MCP contracts.
describe.skipIf(cliManifest === undefined)('Expo CLI Zod override', () => {
  beforeAll(() => {
    cliRequire = createRequire(cliManifest!);
    ({ PluginSchema, DevToolsPluginOutputSchema } = cliRequire(
      './build/src/start/server/devtools/DevToolsPlugin.schema.js',
    ) as { PluginSchema: unknown; DevToolsPluginOutputSchema: unknown });
    ({ createMCPDevToolsExtensionSchema } = cliRequire(
      './build/src/start/server/mcp/createMCPDevToolsExtensionSchema.js',
    ) as { createMCPDevToolsExtensionSchema: (plugin: unknown, zod: typeof z) => z.ZodObject });
    ({ validate } = cliRequire('@expo/schema-utils') as { validate: typeof validate });
  });
  it('resolves the root Zod and excludes the vulnerable nested copy', () => {
    expect(cliRequire.resolve('zod')).toBe(require.resolve('zod'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    expect(lock.packages['node_modules/@expo/cli/node_modules/zod']).toBeUndefined();
  });

  it('validates plugin metadata and strict MCP arguments', () => {
    const plugin = {
      packageName: 'fixture',
      packageRoot: '/fixture',
      cliExtensions: {
        description: 'Fixture',
        entryPoint: 'index.js',
        commands: [
          {
            name: 'inspect',
            title: 'Inspect',
            environments: ['mcp'],
            parameters: [{ name: 'count', type: 'number' }],
          },
        ],
      },
    };
    expect(() => validate(PluginSchema, plugin)).not.toThrow();
    expect(() => validate(PluginSchema, { ...plugin, packageName: '' })).toThrow();
    const schema = createMCPDevToolsExtensionSchema(plugin, z);
    expect(schema.safeParse({ command: 'inspect', count: 1 }).success).toBe(true);
    for (const input of [
      { command: 'missing' },
      { command: 'inspect', count: '1' },
      { command: 'inspect', extra: true },
    ]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
    const server = new McpServer({ name: 'fixture', version: '1.0.0' });
    expect(
      server.registerTool('fixture', { inputSchema: { parameters: schema } }, async () => ({
        content: [],
      })),
    ).toBeDefined();
  });

  it('accepts plugin output variants and rejects invalid output', () => {
    expect(() =>
      validate(DevToolsPluginOutputSchema, [
        { type: 'text', text: 'ok', level: 'info' },
        { type: 'image', url: 'https://example.com/image' },
        { type: 'audio', url: 'https://example.com/audio' },
      ]),
    ).not.toThrow();
    for (const output of [
      [{ type: 'image', url: 'invalid' }],
      [{ type: 'text', text: 'missing level' }],
      [{ type: 'video', url: 'https://example.com/video' }],
    ]) {
      expect(() => validate(DevToolsPluginOutputSchema, output)).toThrow();
    }
  });
});
