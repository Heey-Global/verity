import { Text } from '../../components/ui';
import { Line, SERVER_AUTH, SessionWithLine, UserMessage } from './parts';

/** One collaborator: the row names the other session, and one tap opens it. */
export default function SingleCollaboratorMockup() {
  return (
    <SessionWithLine line={<Line entries={[SERVER_AUTH]} />}>
      <UserMessage>Check with the Server project whether the token refresh is done.</UserMessage>
      <Text variant="body">
        I asked the session “Auth refactor” in the Server project. I will continue here once it
        answers.
      </Text>
    </SessionWithLine>
  );
}
