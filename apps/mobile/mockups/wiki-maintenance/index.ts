import type { MockupSpec } from '../types';
import ChatCardMockup from './chat-card';
import DeleteMockup from './delete';
import EmptyMockup from './empty';
import HowItWorksMockup from './how-it-works';
import NoOverviewMockup from './no-overview';
import ProjectContentMockup from './project-content';
import ProposalMockup from './proposal';
import SetupMockup from './setup';
import StartMockup from './start';
import WalkthroughMockup from './walkthrough';

/**
 * The Wiki explains itself, is set up with you, and changes only through
 * proposals you confirm. Sample content only; nothing here talks to a server.
 */
export const wikiMaintenanceSpec: MockupSpec = {
  id: 'wiki-maintenance',
  title: 'Wiki setup and confirmed maintenance',
  screens: {
    empty: { title: 'Wiki', Component: EmptyMockup },
    'no-overview': { title: 'Wiki', Component: NoOverviewMockup },
    setup: { title: 'Set up Wiki', Component: SetupMockup },
    start: { title: 'Wiki', Component: StartMockup },
    'how-it-works': { title: 'Wiki', Component: HowItWorksMockup },
    'project-content': { title: 'verity', Component: ProjectContentMockup },
    proposal: { title: 'Proposal', Component: ProposalMockup },
    walkthrough: { title: 'Review', Component: WalkthroughMockup },
    'chat-card': { title: 'Crash fix', Component: ChatCardMockup },
    delete: { title: 'Sessions', Component: DeleteMockup },
  },
};
