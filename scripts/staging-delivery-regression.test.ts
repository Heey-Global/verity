import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/mobile-native-build.yml', 'utf8')) as {
  jobs: { build: { steps: { run?: string }[] } };
};
const buildStep = workflow.jobs.build.steps.find((step) => step.run?.includes('next_build='))!.run!;
const extraction = /next_build="\$\(python3 - "\$ipa" <<'PYTHON'\n([\s\S]*?)\nPYTHON\n\)"/.exec(
  buildStep,
)?.[1];

it.each(['binary', 'xml'])(
  'reads the iOS build from a %s IPA with nested Watch and extension plists',
  (format) => {
    expect(extraction).toBeTruthy();
    const result = spawnSync(
      'python3',
      [
        '-c',
        `
import pathlib, plistlib, subprocess, sys, tempfile, zipfile
with tempfile.TemporaryDirectory() as root:
    ipa = pathlib.Path(root) / 'app.ipa'
    fmt = plistlib.FMT_BINARY if sys.argv[2] == 'binary' else plistlib.FMT_XML
    with zipfile.ZipFile(ipa, 'w') as archive:
        for name, version in [('Payload/Verity Staging.app/Info.plist', '79'), ('Payload/Verity Staging.app/Watch/VerityWatch.app/Info.plist', '999'), ('Payload/Verity Staging.app/PlugIns/Widget.appex/Info.plist', '888')]:
            archive.writestr(name, plistlib.dumps({'CFBundleVersion':version}, fmt=fmt))
    result = subprocess.run([sys.executable, '-c', sys.argv[1], str(ipa)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout == '79\\n', repr(result.stdout)
`,
        extraction!,
        format,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
  },
);

it.each(['missing', 'ambiguous', 'duplicate', 'invalid', 'corrupt'])(
  'rejects an IPA with %s application metadata before upload',
  (scenario) => {
    expect(extraction).toBeTruthy();
    const result = spawnSync(
      'python3',
      [
        '-c',
        `
import pathlib, plistlib, subprocess, sys, tempfile, zipfile
with tempfile.TemporaryDirectory() as root:
    ipa = pathlib.Path(root) / 'app.ipa'
    scenario = sys.argv[2]
    with zipfile.ZipFile(ipa, 'w') as archive:
        if scenario != 'missing':
            content = b'broken plist' if scenario == 'corrupt' else plistlib.dumps({'CFBundleVersion': 'oops' if scenario == 'invalid' else '79'})
            archive.writestr('Payload/Main.app/Info.plist', content)
            if scenario in ['ambiguous', 'duplicate']:
                name = 'Other' if scenario == 'ambiguous' else 'Main'
                archive.writestr('Payload/' + name + '.app/Info.plist', content)
    result = subprocess.run([sys.executable, '-c', sys.argv[1], str(ipa)], capture_output=True, text=True)
    assert result.returncode != 0
    assert result.stdout == ''
`,
        extraction!,
        scenario,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
  },
);

it('retries a truncated runtime download and still verifies its checksum', () => {
  const dockerfile = readFileSync('deploy/gvisor-ci.Dockerfile', 'utf8').replace(/\\\n\s*/g, ' ');
  const download = /curl --fail[\s\S]*?--output "\$install_path"/.exec(dockerfile)?.[0];
  expect(download).toBeTruthy();
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import hashlib, http.server, pathlib, shlex, subprocess, sys, tempfile, threading
payload = b'verified runtime fixture'
class Handler(http.server.BaseHTTPRequestHandler):
    attempts = 0
    def log_message(self, *args): pass
    def do_GET(self):
        Handler.attempts += 1
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload[:3] if Handler.attempts == 1 else payload)
        self.close_connection = True
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory() as root:
        output = pathlib.Path(root) / 'runsc'
        args = shlex.split(sys.argv[1])
        args = [('http://127.0.0.1:' + str(server.server_port) + '/runsc') if arg.startswith('https://') else str(output) if arg == '$install_path' else arg for arg in args]
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        assert Handler.attempts == 2, Handler.attempts
        assert hashlib.sha512(output.read_bytes()).digest() == hashlib.sha512(payload).digest()
finally:
    server.shutdown()
`,
      download!,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(dockerfile).toContain('sha512sum --check --status');
  expect(download).toContain('--retry-max-time');
  expect(download).toContain('--max-time');
}, 25_000);
