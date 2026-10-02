import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import type { AttachAnchor } from '../lib/attachMenu';

export function useAttachmentMenuAnchor(
  button: RefObject<View | null>,
  onOpen: (anchor: AttachAnchor) => void,
) {
  const request = useRef(0);
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      request.current++;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [button, onOpen],
  );

  return useCallback(() => {
    const current = ++request.current;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    // Presenting the modal dismisses the keyboard after the anchor was measured,
    // leaving the menu floating at the composer's old, raised position.
    void KeyboardController.dismiss().then(() => {
      if (current !== request.current) return;
      // Let the keyboard-driven padding reset commit and native layout settle
      // before measuring screen coordinates for the modal.
      frame.current = requestAnimationFrame(() => {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          button.current?.measureInWindow((x, y, width, height) => {
            if (current === request.current) onOpen({ x, y, width, height });
          });
        });
      });
    });
  }, [button, onOpen]);
}
