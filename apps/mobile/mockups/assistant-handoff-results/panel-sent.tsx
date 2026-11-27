import { HandoffCard, Mine, Reply, SAMPLE, VeritySheet } from './parts';

/** Before any result: the handoff card as it is today. */
export default function PanelSentMockup() {
  return (
    <VeritySheet>
      <Mine text={SAMPLE.ask} />
      <Reply text={SAMPLE.handedOver} />
      <HandoffCard state="sent" />
    </VeritySheet>
  );
}
