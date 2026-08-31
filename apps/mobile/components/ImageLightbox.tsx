// Full-screen image lightbox with pinch-to-zoom.
//
// Every image the transcript shows inline is rendered small and letterboxed into a
// fixed-height slot, which is fine for spotting *that* there is an image but useless
// for reading one — an architectural plan, a screenshot, a chart. Tapping an image
// opens it here: pinch to zoom, drag to pan, double-tap to toggle between fit and a
// 3× view centred on the tapped point.
//
// Closing: the × badge always closes. A single tap closes while the image sits at
// fit scale; once zoomed in, a single tap instead springs back to fit, so an
// accidental tap while inspecting a detail can't dismiss the whole viewer.
//
// Gestures use react-native-gesture-handler + reanimated so the transform runs on
// the UI thread (the JS thread is busy streaming transcript events). The content is
// wrapped in its own GestureHandlerRootView because a RN `Modal` renders into a
// separate native view hierarchy that the app-root one doesn't cover.
import { Image as ExpoImage, type ImageLoadEventData, type ImageSource } from 'expo-image';
import { useCallback, useEffect } from 'react';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Zoom level a double-tap jumps to — enough to read plan labels without hunting. */
const DOUBLE_TAP_SCALE = 3;
/** Treat anything this close to fit as "not zoomed" (float noise from a pinch). */
const FIT_EPSILON = 0.01;

/** Keep the image from being dragged past its own edges: at scale s an axis has
 * (content * s - viewport) / 2 of overflow available on each side, and nothing
 * while the scaled content still fits. `content` is the size the image actually
 * occupies, NOT the viewport — with `contentFit="contain"` a wide image leaves tall
 * letterbox margins, and clamping against the viewport would let it be dragged that
 * far off screen on the short axis. */
export function clampOffset(
  value: number,
  scale: number,
  viewport: number,
  content: number,
): number {
  'worklet';
  const limit = Math.max(0, (content * scale - viewport) / 2);
  return Math.min(limit, Math.max(-limit, value));
}

/** The box `contentFit="contain"` renders the image into: its intrinsic aspect
 * ratio scaled down to fit the viewport. Falls back to the full viewport until the
 * image reports its size (onLoad). */
export function containedSize(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { width: number; height: number } {
  'worklet';
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: viewportWidth, height: viewportHeight };
  }
  const fit = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight);
  return { width: naturalWidth * fit, height: naturalHeight * fit };
}

export function ImageLightbox({
  source,
  label,
  onClose,
}: {
  source: ImageSource;
  label?: string;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  // Gesture-start snapshots (the `saved…` pattern): a gesture reports its total
  // delta since it began, so each update is applied to the state at that moment.
  // Pinch and pan keep SEPARATE snapshots — they can be recognised in the same
  // touch sequence, and a shared snapshot would be re-armed under the other's feet.
  const pinchStartScale = useSharedValue(1);
  const pinchStartX = useSharedValue(0);
  const pinchStartY = useSharedValue(0);
  const pinchStartFocalX = useSharedValue(0);
  const pinchStartFocalY = useSharedValue(0);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  // Intrinsic pixel size, reported once the image decodes. Kept as shared values so
  // the pan bounds can be derived on the UI thread (and so a late onLoad doesn't
  // have to re-create the gestures).
  const naturalWidth = useSharedValue(0);
  const naturalHeight = useSharedValue(0);

  // Re-apply the pan bounds to the CURRENT offsets. Needed whenever the bounds
  // themselves move: the image decodes (its real, letterboxed size replaces the
  // viewport-sized fallback) or the device rotates. Without this a zoom performed
  // before either can leave the image parked outside its own edges.
  const clampToBounds = useCallback(() => {
    const content = containedSize(naturalWidth.value, naturalHeight.value, width, height);
    offsetX.value = clampOffset(offsetX.value, scale.value, width, content.width);
    offsetY.value = clampOffset(offsetY.value, scale.value, height, content.height);
  }, [naturalWidth, naturalHeight, offsetX, offsetY, scale, width, height]);

  const onLoad = useCallback(
    (e: ImageLoadEventData) => {
      naturalWidth.value = e.source.width;
      naturalHeight.value = e.source.height;
      clampToBounds();
    },
    [naturalWidth, naturalHeight, clampToBounds],
  );

  useEffect(clampToBounds, [clampToBounds]);

  const resetToFit = () => {
    'worklet';
    scale.value = withTiming(1);
    offsetX.value = withTiming(0);
    offsetY.value = withTiming(0);
  };

  // Pinch owns BOTH the scale and the two-finger drag: tracking the focal point
  // keeps the pinched detail under the fingers, which already moves the image when
  // the fingers move together. (Hence pan below is single-finger only — a second
  // handler adding its own translation on top would double every two-finger drag.)
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      pinchStartScale.value = scale.value;
      pinchStartX.value = offsetX.value;
      pinchStartY.value = offsetY.value;
      pinchStartFocalX.value = e.focalX - width / 2;
      pinchStartFocalY.value = e.focalY - height / 2;
    })
    .onUpdate((e) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale.value * e.scale));
      // Keep the point that was under the fingers under the fingers: with the image
      // point p at screen offset f = scale * p + offset, solving for the new offset
      // at the current focal point gives offset = f - next * (f0 - offset0) / scale0.
      const focalX = e.focalX - width / 2;
      const focalY = e.focalY - height / 2;
      const px = (pinchStartFocalX.value - pinchStartX.value) / pinchStartScale.value;
      const py = (pinchStartFocalY.value - pinchStartY.value) / pinchStartScale.value;
      const content = containedSize(naturalWidth.value, naturalHeight.value, width, height);
      scale.value = next;
      offsetX.value = clampOffset(focalX - next * px, next, width, content.width);
      offsetY.value = clampOffset(focalY - next * py, next, height, content.height);
    })
    .onEnd(() => {
      if (scale.value <= MIN_SCALE + FIT_EPSILON) resetToFit();
    });

  const pan = Gesture.Pan()
    // One finger only: two-finger drags belong to the pinch above, and capping the
    // pointer count also keeps this handler from fighting it for the offsets.
    .maxPointers(1)
    .onStart(() => {
      panStartX.value = offsetX.value;
      panStartY.value = offsetY.value;
    })
    .onUpdate((e) => {
      // At fit scale the clamp collapses to 0, so this is a no-op rather than a
      // drag that slides the image off the backdrop.
      const content = containedSize(naturalWidth.value, naturalHeight.value, width, height);
      offsetX.value = clampOffset(
        panStartX.value + e.translationX,
        scale.value,
        width,
        content.width,
      );
      offsetY.value = clampOffset(
        panStartY.value + e.translationY,
        scale.value,
        height,
        content.height,
      );
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd((e) => {
      if (scale.value > MIN_SCALE + FIT_EPSILON) {
        resetToFit();
        return;
      }
      // Zoom in on the tapped point: from fit (scale 1, no offset) the point under
      // the tap stays put when the new offset is f * (1 - target).
      const focalX = e.x - width / 2;
      const focalY = e.y - height / 2;
      const content = containedSize(naturalWidth.value, naturalHeight.value, width, height);
      scale.value = withTiming(DOUBLE_TAP_SCALE);
      offsetX.value = withTiming(
        clampOffset(focalX * (1 - DOUBLE_TAP_SCALE), DOUBLE_TAP_SCALE, width, content.width),
      );
      offsetY.value = withTiming(
        clampOffset(focalY * (1 - DOUBLE_TAP_SCALE), DOUBLE_TAP_SCALE, height, content.height),
      );
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (scale.value > MIN_SCALE + FIT_EPSILON) resetToFit();
      else runOnJS(onClose)();
    });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: offsetX.value },
      { translateY: offsetY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.backdrop}>
          <GestureDetector gesture={gesture}>
            <Animated.View style={styles.stage} collapsable={false}>
              <Animated.View style={[styles.imageFrame, imageStyle]}>
                <ExpoImage
                  source={source}
                  style={styles.image}
                  contentFit="contain"
                  onLoad={onLoad}
                  accessibilityLabel={label ?? 'Image'}
                  accessibilityHint="Pinch to zoom, drag to pan, double tap to zoom in"
                />
              </Animated.View>
            </Animated.View>
          </GestureDetector>
          {label !== undefined && label.length > 0 ? (
            <Text style={styles.label} numberOfLines={2}>
              {label}
            </Text>
          ) : null}
          <Pressable
            style={styles.close}
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close image"
          >
            <Text style={styles.closeGlyph}>×</Text>
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.94)',
  },
  // Fills the backdrop so the gesture area is the whole screen, not just the
  // letterboxed image — a pinch that starts on the black margin still zooms.
  stage: {
    flex: 1,
  },
  imageFrame: {
    flex: 1,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  label: {
    position: 'absolute',
    left: theme.spacing.lg,
    right: theme.spacing.lg,
    bottom: 48,
    color: '#fff',
    fontSize: theme.text.sm,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 8,
  },
  close: {
    position: 'absolute',
    top: 56,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  closeGlyph: {
    color: '#fff',
    fontSize: theme.text.lg,
    fontWeight: '700',
    lineHeight: 24 * theme.fontScale,
  },
}));
