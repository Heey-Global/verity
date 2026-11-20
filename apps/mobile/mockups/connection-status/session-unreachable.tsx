import { ConnectionSheet, ConnectionStrip, DesktopFrame } from './parts';

/** iPad, server unreachable, bar tapped: the details sheet; raw output only at its end. */
export default function SessionUnreachableMockup() {
  return (
    <DesktopFrame strip={<ConnectionStrip state="unreachable" />} overlay={<ConnectionSheet />} />
  );
}
