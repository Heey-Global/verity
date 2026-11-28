import { HomeEnd } from './home-phone';

/** Collapsed, as Home opens: one row with CPU, memory and disk. */
export default function HomeCollapsedMockup() {
  return <HomeEnd expanded={false} />;
}
