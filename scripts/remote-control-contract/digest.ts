import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const bundle = Object.fromEntries(
  ['lifecycle-fixtures.json', 'wire-fixtures.json', 'wire-schemas.json'].map((name) => [
    name,
    JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as unknown,
  ]),
);
process.stdout.write(createHash('sha256').update(canonical(bundle)).digest('hex') + '\n');
