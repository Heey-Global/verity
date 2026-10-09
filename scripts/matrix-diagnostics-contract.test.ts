import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { integrationImportCodes } from '../packages/store/src/integrations.js';

it('keeps connector and mobile failure codes compatible with persisted Matrix diagnostics', () => {
  // A new code must not silently turn into "unknown" in the worker or reject an entire app response.
  const connector = readFileSync('connectors/matrix/src/main.rs', 'utf8');
  const variants = connector.match(
    /#\[serde\(rename_all = "snake_case"\)\]\s*enum ImportCode\s*\{([^}]+)\}/u,
  )?.[1];
  expect(variants).toBeDefined();
  const workerCodes = [...(variants ?? '').matchAll(/\b([A-Z][A-Za-z]+)\s*,/gu)].map(([, name]) =>
    name!.replace(/([a-z])([A-Z])/gu, '$1_$2').toLowerCase(),
  );
  const mobile = readFileSync('packages/mobile/src/api.ts', 'utf8');
  const mobileEnum = mobile.match(
    /const matrixImportDiagnosticSchema[\s\S]*?code: z\.enum\(\[([\s\S]*?)\]\)/u,
  )?.[1];
  expect(mobileEnum).toBeDefined();
  const mobileCodes = [...(mobileEnum ?? '').matchAll(/'([^']+)'/gu)].map(([, code]) => code);
  expect(workerCodes.toSorted()).toEqual([...integrationImportCodes].toSorted());
  expect(mobileCodes.toSorted()).toEqual([...integrationImportCodes].toSorted());
});
