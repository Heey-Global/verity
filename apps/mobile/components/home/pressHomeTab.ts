import type { HomeTab } from './HomeTabBar';

/** Switching preserves each tab; reselecting returns to its root before scrolling. */
export function pressHomeTab(
  next: HomeTab,
  navigation: {
    tab: HomeTab;
    setTab: (tab: HomeTab) => void;
    projectOpen: boolean;
    sharedKnowledgeOpen: boolean;
    closeProject: () => void;
    closeSharedKnowledge: () => void;
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
    if (navigation.sharedKnowledgeOpen) navigation.closeSharedKnowledge();
    else navigation.scrollHome();
  }
}
