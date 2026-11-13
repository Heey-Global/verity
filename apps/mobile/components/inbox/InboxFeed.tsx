import {
  createPushReplyPerformer,
  formatChoiceAnswer,
  alsoWaiting,
  type InboxAction,
  type InboxItem,
  type PushReplyAction,
  type VerityClient,
} from '@verity/mobile';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MockupThumbs } from '../session/MockupReview';
import { AnswerButtons, AnswerSheet, answerId } from '../project/AnswerSheet';
import { Button, Card, CardHead, StatusTag, Text, TileMark } from '../ui';
import { Disclosure } from '../ui/Disclosure';

/**
 * The inbox mechanics shared by every work list (Home, a project's page, a
 * project card): what waits on the operator, how it is answered or dismissed,
 * and how a decision that needs reading is drawn. Home and a project differ only
 * in which items they feed in.
 */

/** What Resume sends: a crashed session continues by taking a new turn. */
export const RESUME_PROMPT = 'Continue where you stopped.';
const TAG_INTENT = {
  attention: 'needsSetup',
  action: 'action',
  success: 'ready',
  neutral: 'optional',
} as const;

export type InboxFeed = ReturnType<typeof useInboxFeed>;

/**
 * The state behind an inbox list, shared by Home and a project's page: which
 * items show, which wait dismissed, and what an answer or an X does.
 *
 * Answers reuse the push-reply performer: the same idempotent routes and the
 * same optimistic status updates a notification action uses. A tapped item
 * hides at once and stays hidden until its source stops reporting it, so a slow
 * poll cannot bring it back for a second tap.
 *
 * The X dismisses an item for the operator on all their devices (a meeting's X
 * is its Skip). It hides at once and is saved after; if saving fails the card
 * returns with a message. Dismissed items wait folded at the bottom to restore.
 */
export function useInboxFeed({
  client,
  all,
  serverHidden,
  onOpenSession,
  onOpenProject,
  onRepairProject,
  onSaved,
}: {
  client: VerityClient;
  /** Every item in inbox order, dismissed ones included. */
  all: readonly InboxItem[];
  /** The keys the server reports dismissed for this person; memoised by the caller. */
  serverHidden: ReadonlySet<string>;
  /** `mockups` opens the session with its mockup review in front. */
  onOpenSession: (sessionId: string, options?: { mockups?: boolean }) => void;
  onOpenProject?: ((projectId: string) => void) | undefined;
  onRepairProject: (projectId: string) => void;
  /** After an answer or a dismissal is saved, for a screen that does not poll. */
  onSaved?: ((item: InboxItem) => void) | undefined;
}) {
  const perform = useMemo(() => createPushReplyPerformer(client), [client]);
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  // Item key → the answer being sent for it. Per item, so a slow answer (a merge
  // waiting on the code host) never locks the answers of every other item.
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(() => new Map());
  // One reply id per item until it is delivered: a second tap after a `retry`
  // (whose first request may have landed) reuses it, so the server's idempotency
  // key turns it into the same reply instead of a second prompt.
  const replyIds = useRef(new Map<string, string>());
  // State re-renders too late to stop a fast double tap; the ref does not.
  const running = useRef(new Set<string>());
  const release = useCallback((key: string) => {
    running.current.delete(key);
    setPending((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  // A dismissal or restore shows before it is saved: `true` hides, `false` shows,
  // until the synced lists agree or the item is gone.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    setOverrides((current) => {
      if (current.size === 0) return current;
      const live = new Set(all.map((item) => item.key));
      const next = new Map(
        [...current].filter(([key, hidden]) => live.has(key) && serverHidden.has(key) !== hidden),
      );
      return next.size === current.size ? current : next;
    });
  }, [all, serverHidden]);
  // Forget a settled key once its source no longer reports it, so the same kind
  // of item can come back later (a new permission reuses nothing).
  useEffect(() => {
    setSettled((current) => {
      if (current.size === 0) return current;
      const live = new Set(all.map((item) => item.key));
      const next = new Set([...current].filter((key) => live.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [all]);
  const isHidden = useCallback(
    (item: InboxItem) => overrides.get(item.key) ?? serverHidden.has(item.key),
    [overrides, serverHidden],
  );
  // Both lists keep the inbox order, so a restored item returns to its place.
  const ordered = useMemo(() => all.filter((item) => !settled.has(item.key)), [all, settled]);
  const items = useMemo(() => ordered.filter((item) => !isHidden(item)), [ordered, isHidden]);
  const hidden = useMemo(() => ordered.filter(isHidden), [ordered, isHidden]);
  // Fold the list again once it empties, so the next dismissal starts folded.
  useEffect(() => {
    if (hidden.length === 0) setShowHidden(false);
  }, [hidden.length]);

  const setDismissed = useCallback(
    (item: InboxItem, dismissed: boolean) => {
      const save =
        item.dismiss === 'session' && item.sessionId !== undefined
          ? () => client.setSessionInboxDismissed(item.sessionId!, item.key, dismissed)
          : item.dismiss === 'project' && item.projectId !== undefined
            ? () => client.setProjectInboxDismissed(item.projectId!, item.key, dismissed)
            : undefined;
      if (save === undefined) return;
      setOverrides((current) => new Map(current).set(item.key, dismissed));
      void Promise.resolve()
        .then(save)
        .then(
          // Outside the failure branch: the save landed whatever the follow-up does.
          () => onSaved?.(item),
          () => {
            setOverrides((current) => {
              const next = new Map(current);
              next.delete(item.key);
              return next;
            });
            Alert.alert(
              dismissed ? 'Not hidden' : 'Not restored',
              'Verity could not save this. Try again in a moment.',
            );
          },
        );
    },
    [client, onSaved],
  );

  const run = useCallback(
    async (item: InboxItem, action: InboxAction) => {
      if (action.kind === 'open_session') return onOpenSession(action.sessionId);
      if (action.kind === 'review_mockups')
        return onOpenSession(action.sessionId, { mockups: true });
      if (action.kind === 'open_project') {
        if (onOpenProject) onOpenProject(action.projectId);
        else router.push({ pathname: '/project/[id]', params: { id: action.projectId } });
        return;
      }
      if (action.kind === 'repair_project') return onRepairProject(action.projectId);
      const reply = replyFor(action);
      if (reply === null) return;
      if (running.current.has(item.key)) return;
      running.current.add(item.key);
      setPending((current) => new Map(current).set(item.key, answerId(action)));
      const replyKey = `${item.key}:${action.kind}:${action.label}`;
      const replyId = replyIds.current.get(replyKey) ?? randomUUID();
      replyIds.current.set(replyKey, replyId);
      try {
        const outcome = await perform(reply, replyId);
        if (outcome === 'retry') {
          Alert.alert('Not sent', 'Verity could not reach the server. Try again in a moment.');
          return;
        }
        // `stale` means someone answered first; either way the item is done.
        replyIds.current.delete(replyKey);
        setSettled((current) => new Set(current).add(item.key));
        onSaved?.(item);
      } finally {
        release(item.key);
      }
    },
    [onOpenSession, onOpenProject, onRepairProject, onSaved, perform, release],
  );
  const dismiss = useCallback(
    (item: InboxItem) => {
      if (item.dismiss === 'meeting') {
        const skip = item.actions.find((action) => action.kind === 'skip_meeting');
        if (skip)
          run(item, skip).catch(() => {
            release(item.key);
            Alert.alert('Not sent', 'Something went wrong. Try again in a moment.');
          });
        return;
      }
      setDismissed(item, true);
    },
    [run, setDismissed, release],
  );

  return {
    items,
    hidden,
    pending,
    showHidden,
    toggleHidden: useCallback(() => setShowHidden((shown) => !shown), []),
    run,
    dismiss,
    restore: useCallback((item: InboxItem) => setDismissed(item, false), [setDismissed]),
  };
}

/** The fold of dismissed items under a work list, each restorable. */
export function InboxHiddenFold({ feed }: { feed: InboxFeed }) {
  const { hidden, showHidden, toggleHidden, restore } = feed;
  if (hidden.length === 0) return null;
  return (
    <>
      <View style={styles.hiddenToggle}>
        <Button
          label={`${String(hidden.length)} hidden`}
          variant="text"
          size="compact"
          onPress={toggleHidden}
        />
      </View>
      {showHidden
        ? hidden.map((item) => (
            <InboxCard
              key={item.key}
              item={item}
              selected={false}
              pending={false}
              disabled={false}
              onRestore={() => restore(item)}
              onAction={() => undefined}
            />
          ))
        : null}
    </>
  );
}

/** One inbox item as a card, wired to its feed's answers and dismissal. */
export function FeedCard({
  feed,
  item,
  selected,
  unread,
  also,
}: {
  feed: InboxFeed;
  item: InboxItem;
  selected: boolean;
  unread?: boolean | undefined;
  also?: readonly InboxItem[] | undefined;
}) {
  return (
    <InboxCard
      item={item}
      unread={unread}
      also={also}
      selected={selected}
      pending={feed.pending.get(item.key) ?? false}
      disabled={feed.pending.has(item.key)}
      onDismiss={item.dismiss !== undefined ? () => feed.dismiss(item) : undefined}
      onAction={(action) => {
        // `perform` reports failures as outcomes; anything it throws is
        // unexpected, but the operator still has to learn the answer was not sent.
        feed.run(item, action).catch(() => {
          Alert.alert('Not sent', 'Something went wrong. Open the session and try again.');
        });
      }}
    />
  );
}

/** One inbox item with its answers; exported for the design-system catalog. */
export function InboxCard({
  item,
  selected,
  pending,
  disabled,
  onAction,
  onDismiss,
  onRestore,
  unread = false,
  also,
}: {
  item: InboxItem;
  selected: boolean;
  /** The session has messages the operator has not read; marked in the head. */
  unread?: boolean;
  /** The session's other open items, named under this one so a session stays one card. */
  also?: readonly InboxItem[] | undefined;
  /** The {@link answerId} of the answer being sent, which shows the spinner. */
  pending: string | false;
  disabled: boolean;
  onAction: (action: InboxAction) => void;
  /** Shows the X that sets the item aside. */
  onDismiss?: (() => void) | undefined;
  /** Draws a dismissed item: muted, with Restore as its only answer. */
  onRestore?: (() => void) | undefined;
}) {
  const restoring = onRestore !== undefined;
  const [answering, setAnswering] = useState(false);
  const answers = item.actions.filter((action) => action.kind === 'answer');
  const otherActions = item.actions.filter((action) => action.kind !== 'answer');
  const ownAnswer = otherActions.find((action) => action.kind === 'open_session');
  // Labels can stay the same while the underlying answer or question changes.
  const answerKey = JSON.stringify([item.key, item.title, item.message, answers]);
  useEffect(() => setAnswering(false), [answerKey, restoring, disabled]);
  return (
    <View testID={restoring ? `inbox-hidden-${item.kind}` : `inbox-item-${item.kind}`}>
      <Card stacked selected={selected} muted={restoring}>
        <CardHead
          title={item.title}
          subtitle={item.context}
          trailing={
            <View style={styles.headTrailing}>
              {unread ? (
                <View accessibilityRole="image" accessibilityLabel="Unread messages">
                  <TileMark tone="action" />
                </View>
              ) : null}
              <StatusTag intent={TAG_INTENT[item.tone]} label={item.tag} />
            </View>
          }
          onDismiss={restoring || disabled ? undefined : onDismiss}
        />
        {item.message ? (
          <Text variant="bodySmall" tone="muted" numberOfLines={3}>
            {item.message}
          </Text>
        ) : null}
        {item.mockups !== undefined && item.mockups.length > 0 ? (
          <MockupThumbs
            screens={item.mockups}
            onOpen={() => {
              const review = item.actions.find((action) => action.kind === 'review_mockups');
              if (review) onAction(review);
            }}
          />
        ) : null}
        {item.lines?.map((line, index) => (
          <Text
            key={index}
            variant={line.kind === 'code' ? 'code' : 'bodySmall'}
            tone={line.kind === 'code' ? undefined : 'muted'}
            selectable
            testID={`inbox-line-${line.kind}`}
          >
            {line.text}
          </Text>
        ))}
        {item.request === undefined ? null : item.requestOpen === true ? (
          // The words leave part of the input unsaid (a file's content, a field no
          // summary knows), so it is the thing to read and is shown whole; Allow
          // must never stand next to text the operator cannot read in full.
          <Text variant="code" testID="inbox-request" selectable>
            {item.request}
          </Text>
        ) : (
          // Read in words first; the complete input stays one tap away, never
          // clipped, so Allow is never decided from a summary that could not be
          // checked against it.
          <Disclosure title="Full request">
            <Text variant="code" testID="inbox-request" selectable>
              {item.request}
            </Text>
          </Disclosure>
        )}
        {also !== undefined && also.length > 0 ? (
          <Text variant="caption" tone="muted" testID="inbox-also">
            {alsoWaiting(also)}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {restoring ? (
            <Button label="Restore" size="compact" variant="secondary" onPress={onRestore} />
          ) : null}
          {restoring ? null : (
            <AnswerButtons
              answers={answers}
              pending={pending}
              disabled={disabled}
              onAnswer={onAction}
              onMore={() => setAnswering(true)}
            />
          )}
          {(restoring ? [] : otherActions).map((action, index) => (
            <Button
              key={`${String(index)}:${action.kind}:${action.label}`}
              label={action.label}
              size={item.kind === 'permission' ? 'compact' : 'small'}
              variant={item.kind === 'permission' && index === 0 ? 'primary' : 'secondary'}
              loading={pending === answerId(action)}
              disabled={disabled}
              onPress={() => onAction(action)}
            />
          ))}
        </View>
      </Card>
      <AnswerSheet
        item={answering && !restoring && !disabled ? item : null}
        answers={answers}
        onAnswer={(action) => {
          setAnswering(false);
          onAction(action);
        }}
        onOpenSession={
          ownAnswer === undefined
            ? undefined
            : () => {
                setAnswering(false);
                onAction(ownAnswer);
              }
        }
        onClose={() => setAnswering(false)}
      />
    </View>
  );
}

/** The network reply an answer becomes; navigation actions have none. */
export function replyFor(action: InboxAction): PushReplyAction | null {
  switch (action.kind) {
    case 'allow':
    case 'deny':
      return {
        type: 'decide-permission',
        sessionId: action.sessionId,
        toolUseId: action.toolUseId,
        decision: { behavior: action.kind },
      };
    case 'answer':
      return {
        type: 'send-turn',
        sessionId: action.sessionId,
        prompt: formatChoiceAnswer([action.answer]),
      };
    case 'resume':
      return { type: 'send-turn', sessionId: action.sessionId, prompt: RESUME_PROMPT };
    case 'merge':
      return {
        type: 'merge-pull-request',
        sessionId: action.sessionId,
        pullRequestNumber: action.number,
      };
    case 'join_meeting':
      return { type: 'join-calendar-meeting', eventKey: action.eventKey };
    case 'skip_meeting':
      return { type: 'skip-calendar-meeting', eventKey: action.eventKey };
    default:
      return null;
  }
}

const styles = StyleSheet.create((theme) => ({
  hiddenToggle: { alignItems: 'center', marginTop: theme.spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  headTrailing: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
}));
