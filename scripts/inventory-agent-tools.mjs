import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// Runtime inventory uses the built gateway. Keep its inventory projection independent
// of workspace declarations: CI lints before referenced packages are built.
const gatewayModulePath = '../packages/server/dist/mcp-gateway.js';
const gatewayModule = /** @type {unknown} */ (await import(gatewayModulePath));
const { AGENT_CAPABILITIES } =
  /** @type {{ AGENT_CAPABILITIES: readonly { name: string; title: string; legacyName: string; discriminator?: 'action' | 'operation'; value?: string }[] }} */ (
    gatewayModule
  );
const check = process.argv.includes('--check');
/** @type {Map<string, unknown[]>} */
const domains = new Map();
for (const capability of AGENT_CAPABILITIES) {
  const domain = capability.name.split('_')[1] ?? 'unknown';
  const skill =
    domain === 'knowledge'
      ? capability.value === 'lookup_decisions'
        ? 'knowledge-query'
        : 'knowledge-ingest'
      : domain === 'wiki'
        ? 'wiki-maintain'
        : domain === 'memory'
          ? 'memory-curate'
          : domain === 'planning'
            ? 'planning'
            : domain === 'tasks'
              ? 'tasks'
              : domain === 'app'
                ? 'app-help'
                : null;
  /** @type {Record<string, string>} */
  const connectors = {
    gmail: 'gmail',
    calendar: 'calendar',
    contacts: 'contacts',
    drive: 'drive',
    docs: 'docs',
    sheets: 'sheets',
    slides: 'slides',
    matrix: 'matrix',
    scheduling: 'calendar',
  };
  const connector = connectors[domain] ?? null;
  const row = {
    name: capability.name,
    title: capability.title,
    entryPoint: 'tool',
    scope: 'authenticated-session',
    connector,
    skill,
    compatibility: {
      name: capability.legacyName,
      ...(capability.discriminator ? { [capability.discriminator]: capability.value } : {}),
    },
  };
  domains.set(domain, [...(domains.get(domain) ?? []), row]);
}
for (const [domain, rows] of domains) {
  const target = `agent/tools/${domain}/capabilities.json`;
  const output = JSON.stringify(rows, null, 2) + '\n';
  if (check) {
    if (readFileSync(target, 'utf8') !== output)
      throw new Error(`Stale capability inventory: ${domain}`);
  } else {
    mkdirSync(`agent/tools/${domain}`, { recursive: true });
    writeFileSync(target, output);
  }
}
