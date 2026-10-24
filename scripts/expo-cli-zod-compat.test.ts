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
let PluginSchema: z.ZodType;
let DevToolsPluginOutputSchema: z.ZodType;
let createMCPDevToolsExtensionSchema: (plugin: unknown) => z.ZodObject;

// A major-version override must retain the CLI's plugin and MCP contracts.
describe.skipIf(cliManifest === undefined)('Expo CLI Zod override', () => {
  beforeAll(() => {
    cliRequire = createRequire(cliManifest!);
    ({ PluginSchema, DevToolsPluginOutputSchema } = cliRequire(
      './build/src/start/server/DevToolsPlugin.schema.js',
    ) as { PluginSchema: z.ZodType; DevToolsPluginOutputSchema: z.ZodType });
    ({ createMCPDevToolsExtensionSchema } = cliRequire(
      './build/src/start/server/createMCPDevToolsExtensionSchema.js',
    ) as { createMCPDevToolsExtensionSchema: (plugin: unknown) => z.ZodObject });
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
    expect(PluginSchema.safeParse(plugin).success).toBe(true);
    expect(PluginSchema.safeParse({ ...plugin, packageName: '' }).success).toBe(false);
    const schema = createMCPDevToolsExtensionSchema(plugin);
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
    expect(
      DevToolsPluginOutputSchema.safeParse([
        { type: 'text', text: 'ok', level: 'info' },
        { type: 'image', url: 'https://example.com/image' },
        { type: 'audio', url: 'https://example.com/audio' },
      ]).success,
    ).toBe(true);
    expect(DevToolsPluginOutputSchema.safeParse([{ type: 'image', url: 'invalid' }]).success).toBe(
      false,
    );
  });
});
