// Mockup review (design module): the agent presents rendered screens and the user
// marks each one approved or discarded, then explains in the chat. Marks start
// nothing; the user tells the agent in the chat when to build. The round arrives
// as the agent's chat message (MockupPager), a slim bar above the composer keeps
// the review reachable while the chat goes on (MockupReviewBar), and the
// full-screen review marks one screen at a time (MockupReviewSheet).
import type { MockupBarView, MockupReviewScreen, MockupScreenView } from '@verity/mobile';
import { useEffect, useState } from 'react';
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
import { Button, IconButton, StatusTag, Text } from '../ui';
import { Image } from '../ui/Image';
import { SessionBar, SessionBarContent, SessionBarTarget } from '../ui/SessionBar';

type Verdict = MockupReviewScreen['verdict'];

const STATE_ICON: Record<Verdict, IconName> = {
  approved: 'check-circle',
  discarded: 'x-circle',
  open: 'circle',
};

const STATE_LABEL: Record<Verdict, string> = {
  approved: 'Approved',
  discarded: 'Discarded',
  open: 'Open',
};

/** The tone a mark is drawn in: success, attention, or faint while unmarked. */
function verdictTone(
  verdict: Verdict | undefined,
  colors: { success: string; attention: string; textFaint: string },
): string {
  return verdict === 'approved'
    ? colors.success
    : verdict === 'discarded'
      ? colors.attention
      : colors.textFaint;
}

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
  const tone = verdictTone(screen.verdict, theme.colors);
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
        const tone = verdictTone(screen.verdict, theme.colors);
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

/** The slim bar above the composer while the review is open. */
export function MockupReviewBar({ view, onReview }: { view: MockupBarView; onReview: () => void }) {
  const { theme } = useUnistyles();
  return (
    <SessionBar
      trailing={
        view.action === 'review' ? (
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
 * Full-screen review: one screen large, swipe for the next, and two equal marks
 * at the bottom. Tapping Discard or Approve marks the screen, tapping the chosen
 * one again takes the mark back; nothing is sent to the agent and no work starts.
 * The screens keep the order they were presented in.
 */
export function MockupReviewSheet({
  visible,
  screens,
  title,
  initialScreen,
  deciding,
  error,
  onDecide,
  onComplete,
  onClose,
}: {
  visible: boolean;
  screens: readonly MockupReviewScreen[];
  /** The plan's title, shown under the screen name. */
  title: string;
  initialScreen: string | undefined;
  deciding: boolean;
  error: string | undefined;
  onDecide: (screen: string, decision: { verdict: Verdict }) => Promise<boolean>;
  onComplete: () => Promise<void>;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState(0);
  const [scroller, setScroller] = useState<ScrollView | null>(null);

  useEffect(() => {
    if (!visible) return;
    const at =
      initialScreen === undefined ? -1 : screens.findIndex((s) => s.name === initialScreen);
    setIndex(Math.max(0, at));
    // Only on opening: `screens` changes with every mark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialScreen]);

  useEffect(() => {
    if (scroller !== null && width > 0) scroller.scrollTo({ x: index * width, animated: false });
    // Reopening a retained modal must align its picture with the mark target.
  }, [scroller, width, index, visible]);

  const current = screens[Math.min(index, screens.length - 1)];
  const mark = (verdict: Exclude<Verdict, 'open'>) => {
    if (current === undefined) return;
    void onDecide(current.name, { verdict: current.verdict === verdict ? 'open' : verdict });
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
              {title} · {String(Math.min(index + 1, screens.length))} of {String(screens.length)}
            </Text>
          </View>
          {current !== undefined && current.verdict !== 'open' ? (
            <StatusTag
              intent={current.verdict === 'approved' ? 'ready' : 'needsSetup'}
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
            onMomentumScrollEnd={(event) => setIndex(pageOf(event, width))}
          >
            {screens.map((screen) => (
              <View key={screen.name} style={[styles.stage, { width }]}>
                <View style={[styles.flex, screen.verdict === 'discarded' ? styles.dimmed : null]}>
                  <MockupPicture screen={screen} style={styles.image} />
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
        {screens.length > 1 ? <PageDots count={screens.length} index={index} /> : null}
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, theme.spacing.md) }]}>
          {error !== undefined ? (
            <Text variant="bodySmall" tone="attention">
              {error}
            </Text>
          ) : null}
          {current === undefined ? null : (
            <View style={styles.actions}>
              <View style={styles.mark}>
                <Button
                  label={current.verdict === 'discarded' ? 'Discarded' : 'Discard'}
                  icon="x"
                  size="compact"
                  variant={current.verdict === 'discarded' ? 'destructive' : 'secondary'}
                  fullWidth
                  disabled={deciding}
                  accessibilityHint={
                    current.verdict === 'discarded' ? 'Takes the mark back' : undefined
                  }
                  onPress={() => mark('discarded')}
                />
              </View>
              <View style={styles.mark}>
                <Button
                  label={current.verdict === 'approved' ? 'Approved' : 'Approve'}
                  icon="check"
                  size="compact"
                  variant={current.verdict === 'approved' ? 'primary' : 'secondary'}
                  fullWidth
                  disabled={deciding}
                  accessibilityHint={
                    current.verdict === 'approved' ? 'Takes the mark back' : undefined
                  }
                  onPress={() => mark('approved')}
                />
              </View>
            </View>
          )}
          <Text variant="bodySmall" tone="muted">
            Already implemented? End this review to remove it from Home and Needs you. Images and
            marks stay in the chat. This does not start implementation.
          </Text>
          <Button
            label="End review"
            size="compact"
            variant="secondary"
            fullWidth
            disabled={deciding}
            onPress={() => void onComplete()}
          />
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
  actions: { flexDirection: 'row', justifyContent: 'center', gap: theme.spacing.sm },
  // Two equal, quiet marks rather than a dominant call to action.
  mark: { width: 150 },
  dimmed: { opacity: 0.4 },
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
