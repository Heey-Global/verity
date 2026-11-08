import { PlanCard, SessionWithPlan } from './parts';

/** Collapsed after a message: one line with the title, the chat stays visible. */
export default function CollapsedMockup() {
  return (
    <SessionWithPlan
      reply="Ich habe den Plan mit deinen drei Antworten überarbeitet."
      card={<PlanCard expanded={false} counts="8 steps" primary="Implement" />}
    />
  );
}
