import { writeFileSync } from 'node:fs';
import { jsonSchemas } from './schemas.ts';

writeFileSync(
  new URL('./wire-schemas.json', import.meta.url),
  JSON.stringify(jsonSchemas(), null, 2) + '\n',
);
