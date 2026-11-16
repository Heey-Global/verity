import type { ProjectDesignLevel } from '@verity/mobile';

/** When an accepted plan stops for mockups, in picker order. */
export const DESIGN_LEVELS: readonly {
  level: ProjectDesignLevel;
  title: string;
  subtitle: string;
}[] = [
  { level: 'off', title: 'Off', subtitle: 'Plans go straight to implementation' },
  {
    level: 'on_request',
    title: 'On request',
    subtitle: 'Mockups when you ask for them or the agent suggests them',
  },
  {
    level: 'required',
    title: 'Required for UI changes',
    subtitle: 'Every plan that changes the interface waits for approved mockups',
  },
];

/** The level's title for the settings overview. Absent means the default. */
export function designLevelLabel(level: ProjectDesignLevel | undefined): string {
  return DESIGN_LEVELS.find((entry) => entry.level === (level ?? 'on_request'))!.title;
}
