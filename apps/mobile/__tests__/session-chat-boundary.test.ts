import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps overview publications outside the unchanged chat render boundary', () => {
  const source = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
  // Parent overview updates must not execute the whole chat merely because
  // the selected session remains mounted beside the sidebar.
  expect(source).toMatch(/export const SessionChat = memo\(function SessionChat\(/);
});
