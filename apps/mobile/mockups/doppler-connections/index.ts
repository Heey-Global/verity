import type { MockupSpec } from '../types';
import AddBinding from './add-binding';
import BindingMenu from './binding-menu';
import ConnectToken from './connect-token';
import ConnectionMenu from './connection-menu';
import AddConnection from './add-connection';
import Bindings from './bindings';
import Empty from './connections-empty';
import Multiple from './connections-multiple';
import Single from './connections-single';
import DeleteConnection from './delete-connection';
import PersonalTokens from './personal-tokens';

export const dopplerConnectionsSpec: MockupSpec = {
  id: 'doppler-connections',
  title: 'Doppler connections and bindings',
  screens: {
    'connections-empty': { title: 'Doppler', Component: Empty },
    'connections-single': { title: 'Doppler', Component: Single },
    'connections-multiple': { title: 'Doppler', Component: Multiple },
    'add-connection': { title: 'Doppler', Component: AddConnection },
    'delete-connection': { title: 'Doppler', Component: DeleteConnection },
    bindings: { title: 'Services', Component: Bindings },
    'add-binding': { title: 'Services', Component: AddBinding },
    'personal-tokens': { title: 'Services', Component: PersonalTokens },
    'connection-menu': { title: 'Doppler', Component: ConnectionMenu },
    'binding-menu': { title: 'Services', Component: BindingMenu },
    'connect-token': { title: 'Services', Component: ConnectToken },
  },
};
