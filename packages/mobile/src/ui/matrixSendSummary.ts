export interface MatrixSendSummary {
  accountId: string;
  endpoint: string;
  roomId: string;
  roomName: string;
  bindingVersion: number;
  body: string;
}

export function matrixSendSummary(input: unknown): MatrixSendSummary | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    value['action'] !== 'send' ||
    typeof value['accountId'] !== 'string' ||
    typeof value['endpoint'] !== 'string' ||
    typeof value['roomId'] !== 'string' ||
    typeof value['roomName'] !== 'string' ||
    typeof value['body'] !== 'string' ||
    typeof value['bindingVersion'] !== 'number' ||
    !Number.isInteger(value['bindingVersion']) ||
    value['bindingVersion'] < 1
  )
    return null;
  return {
    accountId: value['accountId'],
    endpoint: value['endpoint'],
    roomId: value['roomId'],
    roomName: value['roomName'],
    bindingVersion: value['bindingVersion'],
    body: value['body'],
  };
}
