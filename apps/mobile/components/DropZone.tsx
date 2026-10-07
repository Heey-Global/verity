import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { type ComponentType, type ReactNode, useEffect, useRef } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

import type { DroppedFileDescriptor } from '../lib/attachments';
import { acceptWebDrop, webDroppedItems } from '../lib/webDrop';

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

type DropZoneProps = ViewProps & {
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
};

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** Browser drop target with the same limits and callbacks as the native one. */
function WebDropZone({
  children,
  enabled,
  maxFiles,
  maxFileBytes,
  maxTotalBytes,
  onFiles,
  onRejected,
  onActiveChange,
  ...viewProps
}: DropZoneProps) {
  const ref = useRef<View>(null);
  const latest = useRef({
    enabled,
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    onFiles,
    onRejected,
    onActiveChange,
  });
  latest.current = {
    enabled,
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    onFiles,
    onRejected,
    onActiveChange,
  };
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    // dragenter/dragleave fire for every child crossed, so only the outermost pair toggles.
    let depth = 0;
    const accepting = () => latest.current.enabled && latest.current.maxFiles > 0;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (depth === 1 && accepting()) latest.current.onActiveChange(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Without this the browser opens the file in place of the app.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = accepting() ? 'copy' : 'none';
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event) || depth === 0) return;
      depth -= 1;
      if (depth === 0) latest.current.onActiveChange(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event) || !event.dataTransfer) return;
      event.preventDefault();
      depth = 0;
      latest.current.onActiveChange(false);
      if (!accepting()) return;
      const { files, errors } = acceptWebDrop(webDroppedItems(event.dataTransfer), latest.current);
      if (files.length > 0) latest.current.onFiles(files);
      if (errors.length > 0) latest.current.onRejected(errors);
    };
    node.addEventListener('dragenter', enter);
    node.addEventListener('dragover', over);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop', drop);
    return () => {
      node.removeEventListener('dragenter', enter);
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
    };
  }, []);
  return (
    <View ref={ref} {...viewProps}>
      {children}
    </View>
  );
}

export function DropZone(props: DropZoneProps) {
  if (Platform.OS === 'web') return <WebDropZone {...props} />;
  return <NativeDropZoneHost {...props} />;
}

function NativeDropZoneHost({
  children,
  enabled,
  maxFiles,
  maxFileBytes,
  maxTotalBytes,
  onFiles,
  onRejected,
  onActiveChange,
  ...viewProps
}: DropZoneProps) {
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
