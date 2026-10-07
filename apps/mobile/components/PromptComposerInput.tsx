import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { ComponentType, Ref } from 'react';
import {
  Platform,
  TextInput,
  type TextInputProps,
  View,
  type ViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface NativeComposerKeysProps extends ViewProps {
  enabled: boolean;
  onSubmit: () => void;
}

let NativeComposerKeys: ComponentType<NativeComposerKeysProps> | null = null;
if (Platform.OS === 'ios' && requireOptionalNativeModule('VerityComposerKeys')) {
  NativeComposerKeys = requireNativeViewManager('VerityComposerKeys');
}

/** Native key commands distinguish hardware Return from Shift+Return. Older
 * binaries without this module keep Return as a newline until a native update. */
export function PromptComposerInput({
  ref,
  submitOnReturn,
  containerStyle,
  onSend,
  ...inputProps
}: TextInputProps & {
  ref?: Ref<TextInput>;
  submitOnReturn: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  onSend: () => void;
}) {
  const input = <TextInput {...inputProps} ref={ref} multiline submitBehavior="newline" />;
  if (!NativeComposerKeys) return <View style={containerStyle}>{input}</View>;
  const enabled =
    Platform.OS === 'ios' && Platform.isPad && submitOnReturn && inputProps.editable !== false;
  return (
    <NativeComposerKeys
      style={containerStyle}
      enabled={enabled}
      onSubmit={() => enabled && onSend()}
    >
      {input}
    </NativeComposerKeys>
  );
}
