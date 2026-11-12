import type { MockupSpec } from '../types';
import Accept from './accept';
import AcceptInvalid from './accept-invalid';
import Connections from './connections';
import Instances from './instances';
import Invite from './invite';
import Member from './member';
import InviteCreated from './invite-created';
import Landing from './landing';
import Session from './session';
import SessionStates from './session-states';
import Team from './team';
import Welcome from './welcome';

export const teamInvitationsSpec: MockupSpec = {
  id: 'team-invitations',
  title: 'Project team invitations',
  screens: {
    team: { title: 'Team', Component: Team },
    member: { title: 'Team', Component: Member },
    invite: { title: 'Invite', Component: Invite },
    'invite-created': { title: 'Invitation', Component: InviteCreated },
    landing: { title: 'verity.build', Component: Landing },
    welcome: { title: 'Welcome', Component: Welcome },
    accept: { title: 'Join project', Component: Accept },
    'accept-invalid': { title: 'Invitation', Component: AcceptInvalid },
    connections: { title: 'Connections', Component: Connections },
    instances: { title: 'Switch', Component: Instances },
    session: { title: 'Session', Component: Session },
    'session-states': { title: 'Session', Component: SessionStates },
  },
};
