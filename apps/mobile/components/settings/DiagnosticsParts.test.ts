import { completeness, formatReportTime, testName } from './DiagnosticsParts';

const now = new Date(2026, 10, 4, 21, 30);
const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

it('names a report without a start time instead of showing a raw placeholder', () => {
  expect(formatReportTime(null, now)).toBe('Earlier test');
  expect(formatReportTime('not a date', now)).toBe('Earlier test');
});
it('uses local relative days and drops the year only within the current year', () => {
  expect(formatReportTime(at(2026, 10, 4, 20, 34), now)).toBe('Today, 20:34');
  expect(formatReportTime(at(2026, 10, 3, 8, 5), now)).toBe('Yesterday, 08:05');
  expect(formatReportTime(at(2026, 9, 15, 19, 34), now)).toBe('15 Oct, 19:34');
  expect(formatReportTime(at(2025, 9, 15, 19, 34), now)).toBe('15 Oct 2025, 19:34');
});
it('names exactly the missing sources of an incomplete report', () => {
  const sources = { app: true, core: false, uplink: false };
  expect(completeness({ complete: false, sources })).toBe(
    'Incomplete – Core and Uplink data missing',
  );
  expect(completeness({ complete: false, sources: { app: true, core: true, uplink: true } })).toBe(
    'Incomplete – some details could not be confirmed',
  );
  expect(completeness({ complete: true, sources })).toBe('Complete');
});
it('names report types from older versions instead of rendering undefined', () => {
  expect(testName('quick_test')).toBe('Quick test');
  expect(testName('problem_recording')).toBe('Long test');
  expect(testName('something_older')).toBe('Connection test');
});
