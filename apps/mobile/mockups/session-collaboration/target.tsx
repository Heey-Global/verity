import { Text } from '../../components/ui';
import { Line, NOW, SessionWithLine } from './parts';

/** The other side: the asked session shows who asked it, and a tap leads back. */
export default function TargetSessionMockup() {
  return (
    <SessionWithLine
      line={
        <Line
          entries={[
            {
              sessionId: 'header-concept',
              sessionName: 'Header concept',
              projectId: 'verity',
              projectName: 'Verity',
              direction: 'askedBy',
              state: 'working',
              updatedAt: new Date(NOW - 4 * 60_000).toISOString(),
              section: 'current',
            },
          ]}
        />
      }
    >
      <Text variant="bodySmall" tone="muted">
        Question from Verity · Header concept
      </Text>
      <Text variant="body">
        Is the token refresh rebuilt yet? It is needed for the new view in the session header.
      </Text>
      <Text variant="body">
        Yes, since yesterday. The refresh now runs in the background and renews the token five
        minutes before it expires.
      </Text>
    </SessionWithLine>
  );
}
