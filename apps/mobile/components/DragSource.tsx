import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { ComponentType, ReactNode } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

import type { ClickModifiers, DragFileItem } from '../lib/fileSelection';

interface DragBeginEvent {
  nativeEvent: { count: number };
}

interface DragEndEvent {
  nativeEvent: { delivered: boolean };
}

interface ModifiersEvent {
  nativeEvent: ClickModifiers;
}

interface NativeDragZoneProps extends ViewProps {
  enabled: boolean;
  items: DragFileItem[];
  authorization: string;
  tlsPin: string;
  origin: string;
  onDragBegin?: (event: DragBeginEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onModifiers?: (event: ModifiersEvent) => void;
}

let NativeDragZone: ComponentType<NativeDragZoneProps> | null = null;
if (Platform.OS === 'ios' && requireOptionalNativeModule('VerityDragZone')) {
  NativeDragZone = requireNativeViewManager('VerityDragZone');
}

/** True when this build can drag files out to Finder / another app. False on
 * Android and web, and on an iOS build made before the native module existed —
 * OTA updates ship JS only, so a stale native shell must not advertise it. */
export const DRAG_OUT_SUPPORTED = NativeDragZone !== null;

/**
 * Wraps one file-browser row as a drag source. `items` is what THIS row drags —
 * the row alone, or the whole selection when the row belongs to one; see
 * `dragItemsForRow`. Each item is fetched lazily by the native side when the
 * drag is dropped, so passing a long selection costs nothing until it lands.
 */
export function DragSource({
  children,
  enabled,
  items,
  authorization,
  tlsPin,
  origin,
  onDelivered,
  onModifiers,
  ...viewProps
}: ViewProps & {
  children: ReactNode;
  enabled: boolean;
  items: DragFileItem[];
  /** `Bearer …` header value for the download the drop triggers. */
  authorization: string;
  /** Public-key pin required for the direct self-hosted HTTPS endpoint. */
  tlsPin: string;
  /** Expected control-plane origin; native pinning rejects redirects elsewhere. */
  origin: string;
  onDelivered?: () => void;
  /** Modifier keys held at touch down, reported before this row's own `onPress`
   * so the press can read them. Never fires without a hardware keyboard, and
   * never in a build whose native shell predates the drag module. A shell that
   * has the drag module but not this event — one running an OTA update newer
   * than itself — drops the prop as an unknown view attribute, so every press
   * reads as a plain tap, which is what that build did before. */
  onModifiers?: (modifiers: ClickModifiers) => void;
}) {
  if (!NativeDragZone) return <View {...viewProps}>{children}</View>;
  return (
    <NativeDragZone
      {...viewProps}
      enabled={enabled && items.length > 0}
      items={items}
      authorization={authorization}
      tlsPin={tlsPin}
      origin={origin}
      onModifiers={
        onModifiers
          ? (event) => {
              onModifiers(event.nativeEvent);
            }
          : undefined
      }
      // A touch that became a drag will never reach `onPress`, so its report has
      // to be withdrawn — otherwise it stays standing for whatever presses next.
      onDragBegin={
        onModifiers
          ? () => {
              onModifiers({ shift: false, command: false });
            }
          : undefined
      }
      onDragEnd={(event) => {
        if (event.nativeEvent.delivered) onDelivered?.();
      }}
    >
      {children}
    </NativeDragZone>
  );
}
