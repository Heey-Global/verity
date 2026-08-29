// A stable (non-pulsing) blue dot shown left of a session name when the agent has
// FINISHED and there are unread messages — "done, new messages for you". The pulsing
// magenta WorkingDot takes over while the agent is working; once everything is read
// and the agent is idle, neither shows. Lives in the same dot column as WorkingDot.
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export function UnreadDot({ size = 9 }: { size?: number }) {
  const { theme } = useUnistyles();
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="Unread messages"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.colors.tone.active,
      }}
    />
  );
}
