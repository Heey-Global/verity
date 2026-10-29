import { useState } from 'react';
import { Alert, Platform } from 'react-native';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { TextField } from './TextField';

/** Retain the native iOS prompt and provide the same edit action on Android and web. */
export function useTextPrompt() {
  const [request, setRequest] = useState<{
    title: string;
    message: string;
    onSave: (value: string) => void;
  } | null>(null);
  const [value, setValue] = useState('');
  const prompt = (
    title: string,
    message: string,
    onSave: (value: string) => void,
    _type: 'plain-text',
    initial = '',
  ) => {
    if (Platform.OS === 'ios') {
      Alert.prompt(title, message, onSave, 'plain-text', initial);
      return;
    }
    setValue(initial);
    setRequest({ title, message, onSave });
  };
  const dialog = request ? (
    <Sheet
      visible
      title={request.title}
      onClose={() => setRequest(null)}
      footer={
        <Button
          label="Save"
          onPress={() => {
            request.onSave(value);
            setRequest(null);
          }}
        />
      }
    >
      <Text variant="subtitle">{request.message}</Text>
      <TextField label={request.title} value={value} onChangeText={setValue} />
    </Sheet>
  ) : null;
  return { prompt, dialog };
}
