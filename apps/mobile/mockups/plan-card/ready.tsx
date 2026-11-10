import { PlanCard, PlanSummary, SessionWithPlan } from './parts';

/** No open decisions left: the plan can be implemented. */
export default function ReadyMockup() {
  return (
    <SessionWithPlan
      reply="Ich habe den Plan mit deinen drei Antworten überarbeitet."
      card={<PlanCard counts="8 steps · 6 criteria" body={<PlanSummary />} primary="Implement" />}
    />
  );
}
