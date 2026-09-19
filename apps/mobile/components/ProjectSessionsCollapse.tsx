import type { ReactNode } from 'react';
import { View } from 'react-native';

// Project rows settle immediately. The list uses this value to keep its
// post-drag native anchoring lock aligned with the row transition.
export const PROJECT_SESSIONS_COLLAPSE_DURATION_MS = 0;

/** Keep session rows mounted while deriving their visibility from one state. */
export function ProjectSessionsCollapse({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{ display: collapsed ? 'none' : 'flex' }}
      pointerEvents={collapsed ? 'none' : 'auto'}
      accessibilityElementsHidden={collapsed}
      importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
    >
      {children}
    </View>
  );
}
