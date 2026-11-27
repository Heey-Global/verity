import { HandoffCard, Mine, Reply, SAMPLE, VeritySheet } from './parts';

/** The handoff card once the session published a delivered result. */
export default function PanelDoneMockup() {
  return (
    <VeritySheet>
      <Mine text={SAMPLE.ask} />
      <Reply text={SAMPLE.handedOver} />
      <HandoffCard state="done" summary={SAMPLE.doneSummary} at="14:32" />
    </VeritySheet>
  );
}
