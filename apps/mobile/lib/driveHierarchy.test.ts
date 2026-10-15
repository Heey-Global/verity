import type { ProjectDriveFolder } from '@verity/mobile';
import { driveOverview, singleDriveFolderPath } from './driveHierarchy';
const folder = (id: string, accountId: string): ProjectDriveFolder => ({
  id,
  accountId,
  accountEmail: `${accountId}@example.test`,
  accountName: null,
  folderId: `folder-${id}`,
  projectId: 'p',
  name: id,
  accessMode: 'read-only',
});
it('lists folders directly when they belong to one account', () => {
  expect(driveOverview([folder('one', 'a'), folder('two', 'a')]).map((item) => item.id)).toEqual([
    'link:one',
    'link:two',
  ]);
});
it('groups mixed-account folders by email and only opens the selected account', () => {
  const folders = [folder('one', 'a'), folder('two', 'b'), folder('three', 'a')];
  expect(driveOverview(folders).map((item) => item.name)).toEqual([
    'a@example.test',
    'b@example.test',
  ]);
  expect(driveOverview(folders, 'a').map((item) => item.id)).toEqual(['link:one', 'link:three']);
});

it('skips the overview only for exactly one linked folder', () => {
  expect(singleDriveFolderPath([folder('one', 'a')])).toEqual([{ id: 'link:one', name: 'one' }]);
  expect(singleDriveFolderPath([folder('one', 'a'), folder('two', 'b')])).toEqual([]);
  expect(singleDriveFolderPath([])).toEqual([]);
});
