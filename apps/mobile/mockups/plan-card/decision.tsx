import { DecisionStepper, PlanCard, PlanSummary, SAMPLE_DECISIONS, SessionWithPlan } from './parts';

/** The first of three open decisions, right under the title; the recommendation is preselected. */
export default function DecisionMockup() {
  return (
    <SessionWithPlan
      card={
        <PlanCard
          body={
            <>
              <PlanSummary steps={false} />
              <DecisionStepper
                index={0}
                answers={SAMPLE_DECISIONS.map((decision) => decision.recommended)}
              />
            </>
          }
          primary="Send answers (3)"
        />
      }
    />
  );
}
