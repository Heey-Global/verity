import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { ComponentType, ReactNode } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

import type { DroppedFileDescriptor } from '../lib/attachments';

interface DropFilesEvent {
  nativeEvent: { files: DroppedFileDescriptor[]; errors: string[] };
}

interface DropActiveEvent {
  nativeEvent: { active: boolean };
}

interface NativeDropZoneProps extends ViewProps {
  enabled: boolean;
  maxFiles: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  onDropFiles?: (event: DropFilesEvent) => void;
  onDropActive?: (event: DropActiveEvent) => void;
}

let NativeDropZone: ComponentType<NativeDropZoneProps> | null = null;
if (Platform.OS === 'ios' && requireOptionalNativeModule('VerityDropZone')) {
  NativeDropZone = requireNativeViewManager('VerityDropZone');
}

export function DropZone({
  children,
  enabled,
  maxFiles,
  maxFileBytes,
  maxTotalBytes,
  onFiles,
  onRejected,
  onActiveChange,
  ...viewProps
}: ViewProps & {
  children: ReactNode;
  enabled: boolean;
  maxFiles: number;
  /** Per-file ceiling. Omitted, the native side applies the composer's
   * attachment cap; surfaces that stream a drop to disk pass their own. */
  maxFileBytes?: number;
  /** Ceiling across the whole drop. Files are copied to a temporary directory
   * concurrently, so a surface raising `maxFileBytes` should bound the total
   * scratch space one drop can take. */
  maxTotalBytes?: number;
  onFiles: (files: DroppedFileDescriptor[]) => void;
  onRejected: (errors: string[]) => void;
  onActiveChange: (active: boolean) => void;
}) {
  if (!NativeDropZone) return <View {...viewProps}>{children}</View>;
  return (
    <NativeDropZone
      {...viewProps}
      enabled={enabled}
      maxFiles={maxFiles}
      {...(maxFileBytes === undefined ? {} : { maxFileBytes })}
      {...(maxTotalBytes === undefined ? {} : { maxTotalBytes })}
      onDropFiles={(event) => {
        if (event.nativeEvent.files.length > 0) onFiles(event.nativeEvent.files);
        if (event.nativeEvent.errors.length > 0) onRejected(event.nativeEvent.errors);
      }}
      onDropActive={(event) => onActiveChange(event.nativeEvent.active)}
    >
      {children}
    </NativeDropZone>
  );
}
