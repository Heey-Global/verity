import { Text } from './ui';

export function SecretApprovalWaitNote() {
  return (
    <Text tone="muted" variant="subtitle">
      This request stays open until you decide. Once approved, the exact request can resume for five
      minutes. Session and project permissions keep their selected lifetime.
    </Text>
  );
}
