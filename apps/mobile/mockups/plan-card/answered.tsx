import { DecisionStepper, PlanCard, PlanSummary, SAMPLE_DECISIONS, SessionWithPlan } from './parts';

/** The last decision, answered differently from the recommendation; all three go out together. */
export default function AnsweredMockup() {
  const answers = SAMPLE_DECISIONS.map((decision) => decision.recommended);
  answers[2] = 'Nur wöchentlich';
  return (
    <SessionWithPlan
      card={
        <PlanCard
          body={
            <>
              <PlanSummary steps={false} />
              <DecisionStepper index={2} answers={answers} />
            </>
          }
          footnote="All 3 decisions answered. The agent revises the plan from your answers."
          primary="Send answers (3)"
        />
      }
    />
  );
}
