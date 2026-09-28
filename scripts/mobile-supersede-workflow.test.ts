import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

it('routes the native supersession request through the mobile release train', () => {
  const requestPath = '.release/mobile-supersede.json';
  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
    draft: string;
    next: string;
  };
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const selector = workflow.jobs['release-please'].steps.find(
    (step) => step.id === 'release-trains',
  );

  expect(selector?.run).toContain(`${requestPath})`);
  expect(selector?.run).toContain('supersede_changed=true');
  expect(request.draft).toMatch(/^mobile-v\d+\.\d+\.0$/);
  expect(request.next).toMatch(/^mobile-v\d+\.\d+\.0$/);
  const current = request.draft.match(/^mobile-v(\d+)\.(\d+)\.0$/)!;
  expect(request.next).toBe(`mobile-v${current[1]}.${Number(current[2]) + 1}.0`);
});
