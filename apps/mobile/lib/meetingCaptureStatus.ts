let captureActive = () => false;

// The recorder owns its state. Expose a read-only guard without importing native
// recording modules into client construction and the onboarding gate.
export function registerMeetingCaptureStatus(read: () => boolean): void {
  captureActive = read;
}

export function hasActiveMeetingCapture(): boolean {
  return captureActive();
}
