import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Platform, ScrollView, type ScrollViewProps } from 'react-native';

import { attachInvertedWheel } from '../lib/invertedWheel';

export const TranscriptScrollView = forwardRef<ScrollView, ScrollViewProps>((props, ref) => {
  const scrollRef = useRef<ScrollView>(null);
  useImperativeHandle(ref, () => scrollRef.current!);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = (
      scrollRef.current as unknown as { getScrollableNode(): HTMLElement } | null
    )?.getScrollableNode();
    if (node) return attachInvertedWheel(node);
  }, []);
  return <ScrollView {...props} ref={scrollRef} />;
});
TranscriptScrollView.displayName = 'TranscriptScrollView';
