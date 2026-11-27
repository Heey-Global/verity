import { HandoffCard, Mine, Reply, SAMPLE, VeritySheet } from './parts';

/** The handoff card when the session reports the outcome as not yet delivered, with a blocker. */
export default function PanelOpenMockup() {
  return (
    <VeritySheet>
      <Mine text={SAMPLE.ask} />
      <Reply text={SAMPLE.handedOver} />
      <HandoffCard state="open" summary={SAMPLE.openSummary} blocker={SAMPLE.blocker} at="14:32" />
    </VeritySheet>
  );
}
