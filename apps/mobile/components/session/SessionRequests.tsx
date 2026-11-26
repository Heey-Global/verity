import {
  parseProjectInquiryAnswerTurn,
  type ProjectInquiry,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useProjectInquiries } from '../../hooks/useProjectInquiries';
import {
  useReopenableSecretApprovals,
  type ReopenableSecretApprovals,
} from '../../hooks/useReopenableSecretApprovals';
import { DismissedInquiryCards, SessionInquiryRow } from '../project/ProjectInquiryCards';
import { SecretApprovalCard } from '../SecretApprovalCard';
import { Button, Card, CardHead, StatusTag, Text } from '../ui';

/**
 * Requests in a session live in its transcript. A request still waiting for
 * the user is pinned above the composer until its X hides it; hiding decides
 * nothing, it moves the request to the end of the chat with the same buttons.
 * Settled requests stay where they happened: a secret card offers "Review
 * again" when the server can reopen it, and a project answer reads as a card.
 */
export interface SessionRequests {
  client: VerityClient;
  sessionId: string;
  inquiries: ReturnType<typeof useProjectInquiries>;
  secrets: ReopenableSecretApprovals;
  /** Waiting requests the user hid from above the composer, by id. */
  dismissed: ReadonlySet<string>;
  dismiss: (ids: readonly string[]) => void;
  /** The last decision's outcome message until its X or the next request hides it. */
  notice: string | undefined;
  dismissNotice: () => void;
}

export function useSessionRequests(
  client: VerityClient,
  sessionId: string,
  /** Secret history belongs to project sessions only. */
  inProject: boolean,
  pendingPermissionId: string | undefined,
  decisionMessage: string | undefined,
): SessionRequests {
  const inquiries = useProjectInquiries(client, sessionId);
  const secrets = useReopenableSecretApprovals(client, sessionId, inProject, pendingPermissionId);
  const [hidden, setHidden] = useState<{ sessionId: string; ids: ReadonlySet<string> }>();
  const dismissed = useMemo(
    () => (hidden?.sessionId === sessionId ? hidden.ids : new Set<string>()),
    [hidden, sessionId],
  );
  const dismiss = useCallback(
    (ids: readonly string[]) => setHidden({ sessionId, ids: new Set([...dismissed, ...ids]) }),
    [dismissed, sessionId],
  );
  const [notice, dismissNotice] = useDecisionNotice(decisionMessage, pendingPermissionId);
  return { client, sessionId, inquiries, secrets, dismissed, dismiss, notice, dismissNotice };
}

/**
 * Shows a decision's outcome until the user dismisses it or a different
 * request starts waiting; a message for a prompt still waiting stays up. Each
 * decision clears the model's message first, so a repeated failure with the
 * same words is a new message here and shows again after an earlier X.
 */
export function useDecisionNotice(
  message: string | undefined,
  pendingId: string | undefined,
): [string | undefined, () => void] {
  const [seen, setSeen] = useState<{ message: string; pendingId?: string; hidden: boolean }>();
  if (message === undefined ? seen !== undefined : seen?.message !== message)
    setSeen(
      message === undefined
        ? undefined
        : { message, ...(pendingId === undefined ? {} : { pendingId }), hidden: false },
    );
  const visible =
    message !== undefined &&
    seen?.message === message &&
    !seen.hidden &&
    (pendingId === undefined || pendingId === seen.pendingId);
  const dismiss = useCallback(
    () => setSeen((current) => current && { ...current, hidden: true }),
    [],
  );
  return [visible ? message : undefined, dismiss];
}

/** What transcript rows read. Kept apart from the composer-side state, and
 *  memoised on its parts, so streaming does not re-render every row. */
interface RowRequests {
  sessionId: string;
  inquiries: readonly ProjectInquiry[] | undefined;
  secrets: ReopenableSecretApprovals;
}
const RowRequestsContext = createContext<RowRequests | undefined>(undefined);
const TailContext = createContext<{ requests: SessionRequests; tail: ReactNode } | undefined>(
  undefined,
);

/** Makes the requests readable to the transcript's rows and its end. */
export function SessionRequestsProvider({
  requests,
  tail,
  children,
}: {
  requests: SessionRequests;
  /** A hidden waiting permission prompt, drawn at the end of the chat. */
  tail: ReactNode;
  children: ReactNode;
}) {
  const { sessionId, secrets } = requests;
  const inquiries = requests.inquiries.data;
  const rows = useMemo(() => ({ sessionId, inquiries, secrets }), [sessionId, inquiries, secrets]);
  return (
    <RowRequestsContext.Provider value={rows}>
      <TailContext.Provider value={{ requests, tail }}>{children}</TailContext.Provider>
    </RowRequestsContext.Provider>
  );
}

/** The waiting project requests above the composer, with the X that hides them. */
export function PinnedProjectRequests({ requests }: { requests: SessionRequests }) {
  return (
    <SessionInquiryRow
      client={requests.client}
      resource={requests.inquiries}
      sessionId={requests.sessionId}
      dismissed={requests.dismissed}
      onDismiss={requests.dismiss}
    />
  );
}

/** The newest end of the transcript: requests hidden from above the composer. */
export function TranscriptRequestTail({ style }: { style: StyleProp<ViewStyle> }) {
  const context = useContext(TailContext);
  if (context === undefined) return null;
  const { requests, tail } = context;
  const inquiries = (
    <DismissedInquiryCards
      client={requests.client}
      resource={requests.inquiries}
      sessionId={requests.sessionId}
      dismissed={requests.dismissed}
    />
  );
  return (
    <View style={[styles.tail, style]}>
      {tail}
      {inquiries}
    </View>
  );
}

type SecretRequest = ComponentProps<typeof SecretApprovalCard>['request'] & {
  id: string;
  decision: NonNullable<ComponentProps<typeof SecretApprovalCard>['decision']>;
};

/** A decided secret request in the transcript, reopenable where the server allows it. */
export function TranscriptSecretApproval({ request }: { request: SecretRequest }) {
  const secrets = useContext(RowRequestsContext)?.secrets;
  const status = secrets?.statuses.get(request.id);
  return (
    <SecretApprovalCard
      request={request}
      decision={request.decision}
      reopen={
        secrets && status
          ? {
              status,
              working: secrets.reopening === request.id,
              disabled: secrets.reopening !== undefined,
              error: secrets.error?.id === request.id ? secrets.error.text : undefined,
              onPress: () => secrets.reopen(request.id),
            }
          : undefined
      }
    />
  );
}

/**
 * The turn that carries a project's answer into the asking session, drawn as
 * a card. Only a request the server lists for this session, under the same
 * title, becomes a card, and the card shows the server's answer; any other
 * prompt, including one that only quotes the format, stays the bubble given.
 */
export function InquiryAnswerTurn({ text, children }: { text: string; children: ReactNode }) {
  const requests = useContext(RowRequestsContext);
  const turn = parseProjectInquiryAnswerTurn(text);
  const inquiry =
    turn === null
      ? undefined
      : requests?.inquiries?.find(
          (item) =>
            item.id === turn.inquiryId &&
            item.title === turn.title &&
            item.sourceSessionId === requests.sessionId &&
            item.status === 'answered',
        );
  if (inquiry === undefined) return <>{children}</>;
  return <InquiryAnswerCard inquiry={inquiry} />;
}

export function InquiryAnswerCard({ inquiry }: { inquiry: ProjectInquiry }) {
  const target = inquiry.targetProjectName ?? inquiry.targetProjectId;
  return (
    <Card stacked>
      <CardHead
        title={`Answer from ${target}`}
        subtitle={
          inquiry.kind === 'question' ? 'To your question · read-only' : 'To your change request'
        }
        leading={{ icon: 'corner-down-left', intent: 'ready' }}
        trailing={<StatusTag intent="ready" label="Answered" />}
      />
      <Text variant="subtitle">{inquiry.title}</Text>
      <Text selectable>{inquiry.answer ?? ''}</Text>
      <Button
        label="Open target session"
        variant="text"
        size="small"
        icon="arrow-up-right"
        onPress={() =>
          router.push({ pathname: '/session/[id]', params: { id: inquiry.targetSessionId } })
        }
      />
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  tail: { gap: theme.spacing.lg },
}));
