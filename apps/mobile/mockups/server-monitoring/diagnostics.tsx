import { DiagnosticsScreen, Fill } from './parts';

/**
 * Settings › Diagnostics: the new "Server monitoring" section sits on top of
 * the existing diagnostics, with detail mode currently running.
 */
export default function DiagnosticsMockup() {
  return (
    <Fill>
      <DiagnosticsScreen detailActive />
    </Fill>
  );
}
