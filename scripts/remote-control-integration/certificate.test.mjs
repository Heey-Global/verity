import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('./create-certificate.sh', import.meta.url), 'utf8');
function checkCertificate(script = source) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-cert-'));
  try {
    const config = join(directory, 'host.cnf');
    // Runner-installed OpenSSL configuration must not silently inject certificate extensions.
    writeFileSync(
      config,
      '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=host_extensions\n[dn]\nCN=Host default\n[host_extensions]\nbasicConstraints=critical,CA:false\nsubjectAltName=DNS:unexpected.invalid\n',
    );
    const generator = join(directory, 'generate.sh');
    writeFileSync(generator, script);
    execFileSync('bash', [generator, directory], {
      env: { ...process.env, OPENSSL_CONF: config },
      stdio: 'pipe',
      timeout: 10000,
    });
    const ca = new X509Certificate(readFileSync(join(directory, 'ca.pem')));
    const leaf = new X509Certificate(readFileSync(join(directory, 'leaf.pem')));
    assert.equal(ca.ca, true);
    assert.equal(leaf.ca, false);
    assert.equal(leaf.verify(ca.publicKey), true);
    assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(leaf.checkHost('core.test'), 'core.test');
    assert.equal(leaf.checkHost('unexpected.invalid'), undefined);
    for (const name of ['ca', 'leaf']) {
      const parsed = execFileSync('openssl', ['asn1parse', '-in', join(directory, `${name}.pem`)], {
        encoding: 'utf8',
      });
      const extensions = parsed.slice(parsed.indexOf('cons: cont [ 3 ]'));
      const identifiers = [...extensions.matchAll(/d=5\s+.*prim: OBJECT\s+:([^\n]+)/gu)].map(
        (match) => match[1],
      );
      assert.ok(identifiers.length >= 3, 'Certificate extensions must be present');
      assert.equal(
        new Set(identifiers).size,
        identifiers.length,
        'Apple rejects duplicate extension identifiers',
      );
    }
    execFileSync(
      'openssl',
      [
        'verify',
        '-CAfile',
        join(directory, 'ca.pem'),
        '-purpose',
        'sslserver',
        '-verify_ip',
        '127.0.0.1',
        join(directory, 'leaf.pem'),
      ],
      { stdio: 'pipe' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void test('generates trusted fixture certificates with unique extensions despite host defaults', () => {
  checkCertificate();
});

void test('detects accidental reliance on the host certificate configuration', () => {
  const broken = source.replace('-config "$directory/ca.cnf"', '');
  assert.notEqual(broken, source);
  assert.throws(() => checkCertificate(broken), {
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
  });
});
