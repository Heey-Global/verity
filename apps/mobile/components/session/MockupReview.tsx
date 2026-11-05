// Mockup review (design module): after an accepted plan the agent presents
// rendered screens and the build waits until the user approves each one or
// comments on it. The round arrives as the agent's chat message (MockupPager),
// a slim bar above the composer keeps the review reachable while the chat goes
// on (MockupReviewBar), and the full-screen review decides one screen at a time
// (MockupReviewSheet).
import type { MockupBarView, MockupReviewScreen, MockupScreenView } from '@verity/mobile';
import { reviewOrder } from '@verity/mobile';
import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAttachmentImageSource } from '../../hooks/useAttachmentImageSource';
import { Icon, type IconName } from '../Icon';
import { Button, IconButton, StatusTag, Text, TextField } from '../ui';
import { Image } from '../ui/Image';
import { SessionBar, SessionBarContent, SessionBarTarget } from '../ui/SessionBar';

type Verdict = MockupReviewScreen['verdict'];

const STATE_ICON: Record<Verdict, IconName> = {
  approved: 'check-circle',
  comment: 'message-circle',
  open: 'circle',
};

const STATE_LABEL: Record<Verdict, string> = {
  approved: 'Approved',
  comment: 'Commented',
  open: 'Open',
};

function MockupPicture({
  screen,
  style,
}: {
  screen: Pick<MockupScreenView, 'attachment' | 'mediaType' | 'name'>;
  style: object | object[];
}) {
  const source = useAttachmentImageSource({ id: screen.attachment, mediaType: screen.mediaType });
  return (
    <Image
      source={source}
      style={style}
      contentFit="contain"
      accessibilityLabel={`${screen.name} mockup`}
    />
  );
}

/** Which page a horizontal pager settled on. */
function pageOf(event: NativeSyntheticEvent<NativeScrollEvent>, width: number): number {
  return width > 0 ? Math.round(event.nativeEvent.contentOffset.x / width) : 0;
}

/**
 * One round in the chat: one screen at full width with its name, state and
 * position dots; swipe for the next. Every screen gets the same frame height, so
 * the chat does not jump while swiping between phone and desktop screens. A tap
 * opens the full-screen review at that screen while the round is under review.
 */
export function MockupPager({
  screens,
  current,
  onOpen,
}: {
  screens: readonly MockupScreenView[];
  /** False for a round a later presentation replaced. */
  current: boolean;
  onOpen: (name: string) => void;
}) {
  const { theme } = useUnistyles();
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const screen = screens[Math.min(index, screens.length - 1)]!;
  const tone =
    screen.verdict === 'approved'
      ? theme.colors.success
      : screen.verdict === 'comment'
        ? theme.colors.action
        : theme.colors.textFaint;
  return (
    <View
      style={styles.pager}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) => setIndex(pageOf(event, width))}
      >
        {screens.map((entry) => (
          <Pressable
            key={entry.name}
            accessibilityRole="button"
            accessibilityLabel={current ? `Review ${entry.name}` : `${entry.name} mockup`}
            accessibilityHint={current ? 'Opens the full-screen review' : undefined}
            disabled={!current}
            onPress={() => onOpen(entry.name)}
            style={{ width }}
          >
            <MockupPicture screen={entry} style={styles.page} />
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.caption}>
        {screen.verdict !== undefined ? (
          <Icon name={STATE_ICON[screen.verdict]} size={12} color={tone} />
        ) : null}
        <Text variant="caption" numberOfLines={1} style={styles.flex}>
          {screen.name} · {String(index + 1)} of {String(screens.length)}
          {current ? '' : ' · earlier round'}
        </Text>
      </View>
      {screens.length > 1 ? <PageDots count={screens.length} index={index} /> : null}
    </View>
  );
}

function PageDots({ count, index }: { count: number; index: number }) {
  return (
    <View style={styles.dots} accessible={false}>
      {Array.from({ length: count }, (_, dot) => (
        <View key={dot} style={[styles.dot, dot === index ? styles.dotOn : null]} />
      ))}
    </View>
  );
}

const THUMB_HEIGHT = 132;
const THUMB_MAX_WIDTH = 210;

/**
 * The screens as a row of thumbnails with name and state, for the Home item. Each
 * tile takes its screen's own shape, so a desktop screen is not squeezed into a
 * phone-sized frame; a tap opens the full-screen review.
 */
export function MockupThumbs({
  screens,
  onOpen,
}: {
  screens: readonly MockupReviewScreen[];
  onOpen: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {screens.map((screen) => {
        const ratio = screen.width / screen.height;
        const width = Math.min(THUMB_HEIGHT * ratio, THUMB_MAX_WIDTH);
        const tone =
          screen.verdict === 'approved'
            ? theme.colors.success
            : screen.verdict === 'comment'
              ? theme.colors.action
              : theme.colors.textFaint;
        return (
          <Pressable
            key={screen.name}
            accessibilityRole="button"
            accessibilityLabel={`Review ${screen.name}, ${STATE_LABEL[screen.verdict].toLowerCase()}`}
            onPress={onOpen}
            style={[styles.tile, { width }]}
          >
            <MockupPicture
              screen={screen}
              style={[styles.thumb, { height: Math.min(THUMB_HEIGHT, width / ratio) }]}
            />
            <View style={styles.caption}>
              <Icon name={STATE_ICON[screen.verdict]} size={12} color={tone} />
              <Text variant="caption" numberOfLines={1} style={styles.flex}>
                {screen.name}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** The slim bar above the composer while the build waits for the review. */
export function MockupReviewBar({
  view,
  busy,
  onReview,
  onSend,
}: {
  view: MockupBarView;
  busy: boolean;
  onReview: () => void;
  onSend: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <SessionBar
      trailing={
        view.action === 'send' ? (
          <Button label="Send" size="compact" loading={busy} onPress={onSend} />
        ) : view.action === 'review' ? (
          <Button label="Review" size="compact" onPress={onReview} />
        ) : undefined
      }
    >
      {view.action === undefined ? (
        <SessionBarContent
          color={theme.colors.textFaint}
          title={view.title}
          subtitle={view.subtitle}
        />
      ) : (
        <SessionBarTarget accessibilityLabel="Review mockups" onPress={onReview}>
          <SessionBarContent
            color={theme.colors.action}
            title={view.title}
            subtitle={view.subtitle}
          />
        </SessionBarTarget>
      )}
    </SessionBar>
  );
}

/**
 * Full-screen review: one screen large, swipe for the next, Comment and Approve
 * side by side at the bottom. Screens still to decide come first; the order is
 * fixed while the review is open so a verdict does not move the screen away.
 */
export function MockupReviewSheet({
  visible,
  screens,
  title,
  initialScreen,
  deciding,
  error,
  onDecide,
  onSend,
  onClose,
}: {
  visible: boolean;
  screens: readonly MockupReviewScreen[];
  /** The plan's title, shown under the screen name. */
  title: string;
  initialScreen: string | undefined;
  deciding: boolean;
  error: string | undefined;
  onDecide: (
    screen: string,
    decision: { verdict: 'approved' | 'open' } | { verdict: 'comment'; comment: string },
  ) => Promise<boolean>;
  onSend: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [order, setOrder] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState(0);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [scroller, setScroller] = useState<ScrollView | null>(null);

  // Fix the order when the review opens; later verdicts update states in place.
  useEffect(() => {
    if (!visible) return;
    const names = reviewOrder(screens).map((screen) => screen.name);
    setOrder(names);
    setIndex(Math.max(0, initialScreen === undefined ? 0 : names.indexOf(initialScreen)));
    setDraft(undefined);
    // Only on opening: `screens` changes with every verdict.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialScreen]);

  useEffect(() => {
    if (scroller !== null && width > 0) scroller.scrollTo({ x: index * width, animated: false });
    // Jump only when the page size or the opening position changes, not while swiping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, width]);

  const byName = useMemo(() => new Map(screens.map((screen) => [screen.name, screen])), [screens]);
  const ordered = order
    .map((name) => byName.get(name))
    .filter((screen): screen is MockupReviewScreen => screen !== undefined);
  const current = ordered[Math.min(index, ordered.length - 1)];
  const open = screens.some((screen) => screen.verdict === 'open');
  const comments = screens.some((screen) => screen.verdict === 'comment');

  const goNext = () => {
    const next = ordered.findIndex((screen, at) => at > index && screen.verdict === 'open');
    if (next >= 0 && scroller !== null) {
      scroller.scrollTo({ x: next * width, animated: true });
      setIndex(next);
    }
  };

  const approve = async () => {
    if (current === undefined) return;
    if (await onDecide(current.name, { verdict: 'approved' })) goNext();
  };
  const saveComment = async () => {
    if (current === undefined || draft === undefined || draft.trim() === '') return;
    if (await onDecide(current.name, { verdict: 'comment', comment: draft.trim() }))
      setDraft(undefined);
  };
  const reopen = () => {
    if (current !== undefined) void onDecide(current.name, { verdict: 'open' });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingTop: insets.top }]}>
        <View style={styles.head}>
          <View style={styles.flex}>
            <Text variant="row" numberOfLines={1}>
              {current?.name ?? 'Mockups'}
            </Text>
            <Text variant="subtitle" numberOfLines={1}>
              {title} · {String(Math.min(index + 1, ordered.length))} of {String(ordered.length)}
            </Text>
          </View>
          {current !== undefined && current.verdict !== 'open' ? (
            <StatusTag
              intent={current.verdict === 'approved' ? 'ready' : 'optional'}
              label={STATE_LABEL[current.verdict]}
            />
          ) : null}
          <IconButton icon="x" accessibilityLabel="Close review" onPress={onClose} />
        </View>
        <View
          style={styles.flex}
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        >
          <ScrollView
            ref={setScroller}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(event) => {
              setIndex(pageOf(event, width));
              setDraft(undefined);
            }}
          >
            {ordered.map((screen) => (
              <View key={screen.name} style={[styles.stage, { width }]}>
                <MockupPicture screen={screen} style={styles.image} />
              </View>
            ))}
          </ScrollView>
        </View>
        {ordered.length > 1 ? <PageDots count={ordered.length} index={index} /> : null}
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, theme.spacing.md) }]}>
          {error !== undefined ? (
            <Text variant="bodySmall" tone="attention">
              {error}
            </Text>
          ) : null}
          {draft !== undefined ? (
            <>
              <TextField
                label="Comment"
                value={draft}
                onChangeText={setDraft}
                placeholder="What should change on this screen?"
                multiline
                autoFocus
                maxLength={4000}
              />
              <View style={styles.actions}>
                <View style={styles.flex}>
                  <Button
                    label="Cancel"
                    variant="secondary"
                    fullWidth
                    onPress={() => setDraft(undefined)}
                  />
                </View>
                <View style={styles.flex}>
                  <Button
                    label="Save comment"
                    fullWidth
                    loading={deciding}
                    disabled={draft.trim() === ''}
                    onPress={() => void saveComment()}
                  />
                </View>
              </View>
            </>
          ) : current === undefined ? null : (
            <>
              {current.verdict === 'comment' && current.comment !== undefined ? (
                <Text variant="bodySmall" tone="muted">
                  Your comment: “{current.comment}”
                </Text>
              ) : null}
              <View style={styles.actions}>
                <View style={styles.flex}>
                  {current.verdict === 'approved' ? (
                    <Button
                      label="Undo approval"
                      variant="secondary"
                      fullWidth
                      disabled={deciding}
                      onPress={reopen}
                    />
                  ) : (
                    <Button
                      label={current.verdict === 'comment' ? 'Edit comment' : 'Comment'}
                      variant="secondary"
                      fullWidth
                      disabled={deciding}
                      onPress={() => setDraft(current.comment ?? '')}
                    />
                  )}
                </View>
                <View style={styles.flex}>
                  <Button
                    label={current.verdict === 'approved' ? 'Approved' : 'Approve'}
                    fullWidth
                    loading={deciding}
                    disabled={current.verdict === 'approved'}
                    onPress={() => void approve()}
                  />
                  {!open && comments ? (
                    <Button
                      label="Send comments"
                      fullWidth
                      loading={deciding}
                      onPress={() => void onSend().then((sent) => sent && onClose())}
                    />
                  ) : null}
                </View>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  pager: { gap: theme.spacing.xs },
  page: {
    width: '100%',
    height: 380,
    borderRadius: theme.radius.tile,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  caption: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.sm,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.border },
  dotOn: { backgroundColor: theme.colors.action },
  sheet: { flex: 1, backgroundColor: theme.colors.background },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  stage: { flex: 1, paddingHorizontal: theme.spacing.lg },
  image: {
    flex: 1,
    width: '100%',
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bar: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  row: { gap: theme.spacing.sm, alignItems: 'flex-start' },
  tile: { gap: theme.spacing.xs },
  thumb: {
    width: '100%',
    borderRadius: theme.radius.tile,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
}));
