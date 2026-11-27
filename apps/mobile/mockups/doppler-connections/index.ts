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
import ReviewMember from './review-member';
import ReviewAdmin from './review-admin';
import ReviewToken from './review-token';
import ReviewProjectError from './review-project-error';
import ReviewConfigError from './review-config-error';
import ReviewLocked from './review-locked';
import ReviewOnboarding from './review-onboarding';

export const dopplerConnectionsSpec: MockupSpec = {
  id: 'doppler-connections',
  title: 'Doppler connections and bindings',
  screens: {
    'review-onboarding': { title: 'Setup', Component: ReviewOnboarding },
    'review-locked': { title: 'Doppler', Component: ReviewLocked },
    'review-config-error': { title: 'Services', Component: ReviewConfigError },
    'review-project-error': { title: 'Services', Component: ReviewProjectError },
    'review-token': { title: 'Services', Component: ReviewToken },
    'review-admin': { title: 'Services', Component: ReviewAdmin },
    'review-member': { title: 'Services', Component: ReviewMember },
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
