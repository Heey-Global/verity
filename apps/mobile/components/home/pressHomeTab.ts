import type { HomeTab } from './HomeTabBar';

/** Switching preserves each tab; reselecting returns to its root before scrolling. */
export function pressHomeTab(
  next: HomeTab,
  navigation: {
    tab: HomeTab;
    setTab: (tab: HomeTab) => void;
    projectOpen: boolean;
    verityOpen: boolean;
    closeProject: () => void;
    closeVerity: () => void;
    scrollProjects: () => void;
    scrollHome: () => void;
  },
) {
  if (next !== navigation.tab) {
    navigation.setTab(next);
    return;
  }
  if (next === 'projects') {
    if (navigation.projectOpen) navigation.closeProject();
    else navigation.scrollProjects();
  } else {
    if (navigation.verityOpen) navigation.closeVerity();
    else navigation.scrollHome();
  }
}
