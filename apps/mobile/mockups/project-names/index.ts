import type { MockupSpec } from '../types';
import Create from './create';
import EditDescription from './edit-description';
import EditName from './edit-name';
import Hero from './hero';
import HeroEmpty from './hero-empty';
import Home from './home';
import Settings from './settings';

export const projectNamesSpec: MockupSpec = {
  id: 'project-names',
  title: 'Projects with their own name',
  screens: {
    hero: { title: 'Verity Plattform', Component: Hero },
    'hero-empty': { title: 'Kundenportal', Component: HeroEmpty },
    'edit-name': { title: 'Verity Plattform', Component: EditName },
    'edit-description': { title: 'Verity Plattform', Component: EditDescription },
    create: { title: 'New project', Component: Create },
    settings: { title: 'Project settings', Component: Settings },
    home: { title: 'Projects', Component: Home },
  },
};
