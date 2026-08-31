import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { useCallback, type ComponentType } from 'react';
import { Platform, StyleSheet, type ViewProps } from 'react-native';

import {
  windowControlsInset,
  type WindowControlMargins,
  type WindowControlsInset,
} from '../lib/windowControls';

interface NativeWindowControlsProps extends ViewProps {
  onMarginsChange?: (event: { nativeEvent: WindowControlMargins }) => void;
}

// Resolve the native measuring view once. It only exists on iOS builds that
// bundled native/VerityWindowControls.swift; everywhere else — Android, web, and
// binaries older than the one that added it — the probe renders nothing and the
// header keeps the padding it always had.
//
// iPad only, deliberately, even though the measurement itself is universal: the
// window controls are an iPad and iPad-on-Mac feature, so anywhere else the only
// thing the corner-adapted margins can report is a rounded corner the header was
// never in danger from. Measuring there could only produce a phantom nudge.
let NativeWindowControls: ComponentType<NativeWindowControlsProps> | null = null;
if (
  Platform.OS === 'ios' &&
  Platform.isPad &&
  requireOptionalNativeModule('VerityWindowControls')
) {
  NativeWindowControls = requireNativeViewManager('VerityWindowControls');
}

/**
 * Reports how much room iPadOS 26's window controls take out of the top of the
 * window (see lib/windowControls.ts). The measurement is of the window, not of
 * this view — placing the probe elsewhere would not scope it to that part of the
 * screen, it would only change when it re-measures. Which is why it renders an
 * invisible view filling its parent rather than nothing at all: being laid out
 * with the row it reports for is what makes a window resize re-measure. It takes
 * no touches — the native view turns its own interaction off.
 */
export function WindowControlsProbe({
  onInset,
}: {
  onInset: (inset: WindowControlsInset) => void;
}) {
  // Kept stable so a header re-render doesn't re-set the native event prop; the
  // hook runs unconditionally because the early return below is decided at module
  // load, not per render.
  const handleMargins = useCallback(
    (event: { nativeEvent: WindowControlMargins }) =>
      onInset(windowControlsInset(event.nativeEvent)),
    [onInset],
  );
  if (!NativeWindowControls) return null;
  return <NativeWindowControls style={StyleSheet.absoluteFill} onMarginsChange={handleMargins} />;
}
