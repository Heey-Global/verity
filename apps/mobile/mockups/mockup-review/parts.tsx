import { Image, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../../components/Icon';
import { Text } from '../../components/ui';

export type ScreenState =
  { kind: 'approved' } | { kind: 'comment'; text: string } | { kind: 'open' };

export interface MockupScreenSample {
  name: string;
  image: number;
  /** Width over height of the rendered screen. */
  ratio: number;
  state: ScreenState;
}

/** Sample review: open screens first, as the real list will sort them. */
export const SAMPLE_SCREENS: readonly MockupScreenSample[] = [
  {
    name: 'Spec · desktop',
    image: require('./assets/spec-desktop.png') as number,
    ratio: 1440 / 900,
    state: { kind: 'open' },
  },
  {
    name: 'Spec',
    image: require('./assets/spec.png') as number,
    ratio: 393 / 852,
    state: { kind: 'comment', text: 'Put the decision above the criteria.' },
  },
  {
    name: 'Home',
    image: require('./assets/home.png') as number,
    ratio: 393 / 852,
    state: { kind: 'approved' },
  },
];

const STATE_ICON: Record<ScreenState['kind'], IconName> = {
  approved: 'check-circle',
  comment: 'message-circle',
  open: 'circle',
};

/**
 * A row of screen thumbnails with name and state; a tap opens the full-screen
 * review at that screen. Design-system gap: no thumbnail component exists yet;
 * the compact Home item uses it; the session shows the full-width pager.
 */
export function MockupThumbs({ screens }: { screens: readonly MockupScreenSample[] }) {
  const { theme } = useUnistyles();
  const height = 132;
  // A landscape screen gets a wider tile but never one taller than its image, so
  // it fills the frame instead of floating in empty bars.
  const maxWidth = 210;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      // Phone and desktop tiles differ in height; each keeps its caption under its image.
    >
      {screens.map((screen) => {
        const tone =
          screen.state.kind === 'approved'
            ? theme.colors.success
            : screen.state.kind === 'comment'
              ? theme.colors.action
              : theme.colors.textFaint;
        const width = Math.min(height * screen.ratio, maxWidth);
        return (
          <Pressable
            key={screen.name}
            accessibilityRole="button"
            accessibilityLabel={`Open ${screen.name} mockup`}
            // Each tile takes the screen's own shape, so a desktop screen is not
            // squeezed into a phone-sized frame.
            style={[styles.tile, { width }]}
          >
            <Image
              source={screen.image}
              resizeMode="contain"
              style={[styles.thumb, { height: Math.min(height, width / screen.ratio) }]}
              accessibilityIgnoresInvertColors
            />
            <View style={styles.caption}>
              <Icon name={STATE_ICON[screen.state.kind]} size={12} color={tone} />
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

/** Position dots under a swipeable set of screens, as in the full-screen review. */
export function PageDots({ count, index }: { count: number; index: number }) {
  return (
    <View style={styles.dots}>
      {Array.from({ length: count }, (_, dot) => (
        <View key={dot} style={[styles.dot, dot === index ? styles.dotOn : null]} />
      ))}
    </View>
  );
}

/**
 * One screen at full width with its name, state and position dots; swipe for
 * the next. The frame keeps one height for every screen, so the chat does not
 * jump while swiping between phone and desktop screens.
 */
export function MockupPager({
  screens,
  index,
}: {
  screens: readonly MockupScreenSample[];
  index: number;
}) {
  const { theme } = useUnistyles();
  const screen = screens[index]!;
  const tone =
    screen.state.kind === 'approved'
      ? theme.colors.success
      : screen.state.kind === 'comment'
        ? theme.colors.action
        : theme.colors.textFaint;
  return (
    <View style={styles.pager}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${screen.name} mockup`}>
        <Image
          source={screen.image}
          resizeMode="contain"
          style={styles.page}
          accessibilityIgnoresInvertColors
        />
      </Pressable>
      <View style={styles.caption}>
        <Icon name={STATE_ICON[screen.state.kind]} size={12} color={tone} />
        <Text variant="caption" numberOfLines={1} style={styles.flex}>
          {screen.name} · {String(index + 1)} of {String(screens.length)}
        </Text>
      </View>
      <PageDots count={screens.length} index={index} />
    </View>
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
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.sm,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.border },
  dotOn: { backgroundColor: theme.colors.action },
  row: { gap: theme.spacing.sm, alignItems: 'flex-start' },
  tile: { gap: theme.spacing.xs },
  thumb: {
    width: '100%',
    borderRadius: theme.radius.tile,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  caption: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
}));
