import { pressHomeTab } from './pressHomeTab';
import type { HomeTab } from './HomeTabBar';

function navigation(tab: HomeTab) {
  return {
    tab,
    setTab: jest.fn(),
    projectOpen: true,
    verityOpen: true,
    closeProject: jest.fn(),
    closeVerity: jest.fn(),
    scrollProjects: jest.fn(),
    scrollHome: jest.fn(),
  };
}

it.each(['home', 'projects'] as const)(
  'preserves nested pages and scroll when switching to %s',
  (tab) => {
    const state = navigation(tab === 'home' ? 'projects' : 'home');
    pressHomeTab(tab, state);
    expect(state.setTab).toHaveBeenCalledWith(tab);
    expect(state.closeProject).not.toHaveBeenCalled();
    expect(state.closeVerity).not.toHaveBeenCalled();
    expect(state.scrollProjects).not.toHaveBeenCalled();
    expect(state.scrollHome).not.toHaveBeenCalled();
  },
);

it('returns from a project to Projects, then scrolls on the next press', () => {
  const state = navigation('projects');
  pressHomeTab('projects', state);
  expect(state.closeProject).toHaveBeenCalledTimes(1);
  expect(state.scrollProjects).not.toHaveBeenCalled();
  state.projectOpen = false;
  pressHomeTab('projects', state);
  expect(state.scrollProjects).toHaveBeenCalledTimes(1);
  expect(state.closeVerity).not.toHaveBeenCalled();
  expect(state.scrollHome).not.toHaveBeenCalled();
});

it('returns from Verity to Home, then scrolls on the next press', () => {
  const state = navigation('home');
  pressHomeTab('home', state);
  expect(state.closeVerity).toHaveBeenCalledTimes(1);
  expect(state.scrollHome).not.toHaveBeenCalled();
  state.verityOpen = false;
  pressHomeTab('home', state);
  expect(state.scrollHome).toHaveBeenCalledTimes(1);
  expect(state.closeProject).not.toHaveBeenCalled();
  expect(state.scrollProjects).not.toHaveBeenCalled();
});
