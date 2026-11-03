import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('verifies the disposable egress observer and broker boundaries without namespaces', () => {
  execFileSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'scripts/egress-experiment', '-p', 'test_*.py'],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 15_000, stdio: 'pipe' },
  );
}, 20_000);
