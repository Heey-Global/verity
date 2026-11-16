import type { MockupSpec } from '../types';
import Short from './short';
import Long from './long';
import Sheet from './sheet';
import Review from './review';
export const homeAnswersSpec: MockupSpec = {
  id: 'home-answers',
  title: 'Home answers and review recovery',
  screens: {
    short: { title: 'Verity', Component: Short },
    long: { title: 'Verity', Component: Long },
    sheet: { title: 'Verity', Component: Sheet },
    review: { title: 'Mockup review', Component: Review },
  },
};
