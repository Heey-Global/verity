import { ConnectionStrip, DesktopFrame } from './parts';

/** iPad, Home + session while the server updates: one strip, no local error cards. */
export default function HomeUpdatingMockup() {
  return <DesktopFrame strip={<ConnectionStrip state="updating" />} />;
}
