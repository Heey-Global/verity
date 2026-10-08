import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { resetDemoData } from './demoTransport';
import { resetVeritySettingsStore } from './settingsStore';
import { hasActiveMeetingCapture } from './meetingCaptureStatus';
import { getSavedVerityBaseUrl } from './client';
import { restoreUnprotectedAuthToken } from './authToken';

const STORAGE_KEY = 'verity.demoMode.v1';
let enabled = false;
let entering = false;
let revision = 0;
const listeners = new Set<() => void>();

export function isDemoMode(): boolean {
  return enabled;
}

export function isEnteringDemoMode(): boolean {
  return entering;
}

function publish(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Screens memoize their client. Remount the routed tree when switching transports
// or resetting fixtures so stale clients and live streams cannot survive the switch.
export function useDemoRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision,
  );
}

export async function hydrateDemoMode(): Promise<void> {
  enabled = false;
  try {
    enabled = (await AsyncStorage.getItem(STORAGE_KEY)) === '1';
  } catch {
    // A missing demo preference must not hide the normal connection flow.
  }
  resetDemoData();
}

export async function enterDemoMode(): Promise<void> {
  if (entering) return;
  entering = true;
  try {
    if (hasActiveMeetingCapture()) {
      throw new Error('End the current meeting before entering the demo.');
    }
    await AsyncStorage.setItem(STORAGE_KEY, '1');
    resetDemoData();
    resetVeritySettingsStore();
    enabled = true;
    publish();
  } finally {
    entering = false;
  }
}

export async function exitDemoMode(): Promise<void> {
  await restoreUnprotectedAuthToken(getSavedVerityBaseUrl());
  await AsyncStorage.removeItem(STORAGE_KEY);
  resetDemoData();
  resetVeritySettingsStore();
  enabled = false;
  publish();
}

export function restartDemoMode(): void {
  if (!enabled) return;
  resetDemoData();
  resetVeritySettingsStore();
  publish();
}
