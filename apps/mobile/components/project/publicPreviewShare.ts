import { getRandomValues } from 'expo-crypto';

export const PUBLIC_PREVIEW_DURATIONS = [
  { label: '1 h', a11y: '1 hour', seconds: 3600 },
  { label: '24 h', a11y: '24 hours', seconds: 86400 },
  { label: '7 days', a11y: '7 days', seconds: 604800 },
  { label: '30 days', a11y: '30 days', seconds: 2592000 },
] as const;

export function validPreviewPin(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

export function generatePreviewPin(): string {
  const values = getRandomValues(new Uint32Array(1));
  return String(values[0]! % 1_000_000).padStart(6, '0');
}
