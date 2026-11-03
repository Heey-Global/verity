import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capabilityArguments, capabilityVariants } from './agent-capabilities.js';
import { AGENT_CAPABILITIES } from './mcp-gateway.js';
describe('canonical capabilities', () => {
  it('keeps the shipped inventory aligned with runtime operations and aliases', () => {
    const root = fileURLToPath(new URL('../../../agent/tools/', import.meta.url));
    const rows = readdirSync(root).flatMap(
      (domain) =>
        JSON.parse(readFileSync(`${root}/${domain}/capabilities.json`, 'utf8')) as {
          name: string;
          title: string;
          compatibility: Record<string, unknown>;
        }[],
    );
    expect(rows.map((row) => row.name).sort()).toEqual(
      AGENT_CAPABILITIES.map((entry) => entry.name).sort(),
    );
    for (const entry of AGENT_CAPABILITIES) {
      const row = rows.find((candidate) => candidate.name === entry.name)!;
      expect(row.title).toBe(entry.title);
      expect(row.compatibility).toEqual({
        name: entry.legacyName,
        ...(entry.discriminator ? { [entry.discriminator]: entry.value } : {}),
      });
    }
  });
  it('documents only advertised focused tools in built-in Skills', () => {
    const root = fileURLToPath(new URL('../../../agent/skills/', import.meta.url));
    const names = new Set(AGENT_CAPABILITIES.map((entry) => entry.name));
    for (const skill of readdirSync(root)) {
      const body = readFileSync(`${root}/${skill}/SKILL.md`, 'utf8');
      for (const match of body.matchAll(/\bverity_[a-z_]+\b/g)) {
        expect(names.has(match[0]), `${skill} refers to unadvertised tool ${match[0]}`).toBe(true);
      }
    }
  });
  it('derives distinct focused tools and their required fields from the union', () => {
    const entries = capabilityVariants('verity_tasks', {
      anyOf: [
        { type: 'object', properties: { action: { const: 'list' } }, required: ['action'] },
        {
          type: 'object',
          properties: { action: { const: 'complete' }, id: { type: 'string' } },
          required: ['action', 'id'],
        },
      ],
    });
    expect(entries.map((entry) => entry.name)).toEqual([
      'verity_tasks_list',
      'verity_tasks_complete',
    ]);
    expect(entries[1]!.inputSchema.required).toEqual(['id']);
    expect(capabilityArguments(entries[1]!, { id: 't1' })).toEqual({
      action: 'complete',
      id: 't1',
    });
    expect(() => capabilityArguments(entries[1]!, { action: 'drop' })).toThrow();
  });
  it('covers real contracts with unique machine names and readable titles', () => {
    expect(new Set(AGENT_CAPABILITIES.map((entry) => entry.name)).size).toBe(
      AGENT_CAPABILITIES.length,
    );
    for (const entry of AGENT_CAPABILITIES) {
      expect(entry.name).toMatch(/^verity_[a-z]+(?:_[a-z0-9]+)+$/);
      expect(entry.title).not.toContain('_');
      expect(entry.inputSchema).not.toHaveProperty('oneOf');
      expect(entry.inputSchema).not.toHaveProperty('anyOf');
    }
    expect(
      AGENT_CAPABILITIES.some((entry) => entry.name === 'verity_knowledge_record_decision'),
    ).toBe(true);
  });
});
