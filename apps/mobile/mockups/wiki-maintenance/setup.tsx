import { Group, Row, Text } from '../../components/ui';
import { Session, UserMessage, VerityMessage } from './parts';

/**
 * The setup session: two questions, then a proposed structure that Verity
 * writes only after you confirm it in the chat. No team question: this project
 * has one member, so Verity takes the team from the project.
 */
export default function SetupMockup() {
  return (
    <Session placeholder="Reply to Verity…">
      <VerityMessage>
        <Text variant="body">I found 99 pages and 34 decisions. Two questions first:</Text>
        <Text variant="body">1. What is this project for, and for whom?</Text>
        <Text variant="body">2. What matters most right now?</Text>
      </VerityMessage>
      <UserMessage>
        A self-hosted assistant for small teams. Right now: Home, meetings and the Wiki itself.
      </UserMessage>
      <VerityMessage>
        <Text variant="body">I would structure the Wiki like this:</Text>
        <Group>
          <Row
            leading={{ icon: 'layers' }}
            title="Verity at a glance"
            subtitle="Idea, users, direction"
          />
          <Row
            leading={{ icon: 'layers' }}
            title="Home and navigation"
            subtitle="12 existing pages"
          />
          <Row leading={{ icon: 'layers' }} title="Meetings" subtitle="9 existing pages" />
          <Row
            leading={{ icon: 'layers' }}
            title="Knowledge and Wiki"
            subtitle="6 existing pages"
          />
          <Row
            leading={{ icon: 'layers' }}
            title="Engineering reference"
            subtitle="Builds, releases, security · 72 pages"
          />
        </Group>
        <Text variant="bodySmall" tone="muted">
          Gap: nothing yet on who the users are; I will mark it.
        </Text>
        <Text variant="body">Shall I write it like this, or change something?</Text>
      </VerityMessage>
    </Session>
  );
}
