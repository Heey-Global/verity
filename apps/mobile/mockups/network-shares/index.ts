import type { MockupSpec } from '../types';
import AddAccess from './add-access';
import AddChooseShare from './add-choose-share';
import ChooseFolder from './choose-folder';
import ConnectShare from './connect-share';
import Connections from './connections';
import FolderAccess from './folder-access';
import ProjectNetworkShares from './project-network-shares';

export const networkSharesSpec: MockupSpec = {
  id: 'network-shares',
  title: 'Network shares',
  screens: {
    connections: { title: 'Network shares', Component: Connections },
    'connect-share': { title: 'Add network share', Component: ConnectShare },
    'project-network-shares': { title: 'Network shares', Component: ProjectNetworkShares },
    'folder-access': { title: 'Folder access', Component: FolderAccess },
    'add-choose-share': { title: 'Add folder', Component: AddChooseShare },
    'choose-folder': { title: 'Choose folder', Component: ChooseFolder },
    'add-access': { title: 'Folder access', Component: AddAccess },
  },
};
