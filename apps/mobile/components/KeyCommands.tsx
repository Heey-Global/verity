import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { ComponentType, ReactNode } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

import type { FontZoomDirection } from '../lib/fontZoom';

interface ZoomEvent {
  nativeEvent: { direction: FontZoomDirection };
}

interface NativeKeyCommandsProps extends ViewProps {
  onZoom?: (event: ZoomEvent) => void;
  onSearch?: (event: { nativeEvent: { action: 'context' | 'global' | 'close' } }) => void;
}

// Resolve the native ⌘-shortcut view once. It only exists on iOS builds that
// bundled native/VerityKeyCommands.swift; everywhere else this is a plain View so
// the app renders unchanged (Android, web, older OTA-only binaries).
let NativeKeyCommands: ComponentType<NativeKeyCommandsProps> | null = null;
if (Platform.OS === 'ios' && requireOptionalNativeModule('VerityKeyCommands')) {
  NativeKeyCommands = requireNativeViewManager('VerityKeyCommands');
}

/** Wraps the app so ⌘+ / ⌘− / ⌘0 reach `onZoom`. A transparent passthrough when
 * the native module is absent. */
export function KeyCommands({
  children,
  onZoom,
  onSearch,
  ...viewProps
}: ViewProps & {
  children: ReactNode;
  onZoom: (direction: FontZoomDirection) => void;
  onSearch?: (action: 'context' | 'global' | 'close') => void;
}) {
  if (!NativeKeyCommands) return <View {...viewProps}>{children}</View>;
  return (
    <NativeKeyCommands
      {...viewProps}
      onZoom={(event) => onZoom(event.nativeEvent.direction)}
      onSearch={(event) => onSearch?.(event.nativeEvent.action)}
    >
      {children}
    </NativeKeyCommands>
  );
}
