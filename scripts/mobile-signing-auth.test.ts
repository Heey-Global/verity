import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

const workflow = readFileSync('.github/workflows/mobile-native-build.yml', 'utf8');
const build = workflow
  .split('      - name: Build native release and upload staging only')[1]!
  .split('      - name:')[0];
const setup = build
  .split('          set -euo pipefail\n')[1]!
  .split('          mint_asc_jwt()')[0]
  .replace(/^ {10}/gm, '');

function probe(overrides = {}, failure = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-signing-'));
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -eu\n${setup}\nnode -e 'const a=require("node:assert/strict"); const f=require("node:fs"); a.equal(process.env.EXPO_ASC_KEY_ID,"fixture"); a.equal(process.env.EXPO_ASC_ISSUER_ID,"issuer"); a.equal(process.env.EXPO_APPLE_TEAM_ID,"team"); a.equal(f.readFileSync(process.env.EXPO_ASC_API_KEY_PATH,"utf8"),"fake-key"); a.equal(f.statSync(process.env.EXPO_ASC_API_KEY_PATH).mode & 511,384);'\nexit ${failure ? 7 : 0}`,
      ],
      {
        env: {
          ...process.env,
          RUNNER_TEMP: dir,
          ASC_KEY_ID: 'fixture',
          ASC_ISSUER_ID: 'issuer',
          ASC_KEY_P8: 'fake-key',
          APPLE_TEAM_ID: 'team',
          EXPO_APPLE_TEAM_TYPE: 'COMPANY_OR_ORGANIZATION',
          ...overrides,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(existsSync(join(dir, 'app-store-connect/AuthKey_fixture.p8')), false);
    assert.equal(result.stdout.includes('fake-key') || result.stderr.includes('fake-key'), false);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('actual build setup exports Apple auth and removes the private key on success and failure', () => {
  assert.equal(probe().status, 0);
  assert.equal(probe({}, true).status, 7);
});
test('missing Apple inputs and unverified team type fail before credentials are written', () => {
  for (const name of [
    'ASC_KEY_ID',
    'ASC_ISSUER_ID',
    'ASC_KEY_P8',
    'APPLE_TEAM_ID',
    'EXPO_APPLE_TEAM_TYPE',
  ])
    assert.notEqual(probe({ [name]: '' }).status, 0, name);
  assert.notEqual(probe({ EXPO_APPLE_TEAM_TYPE: 'unknown' }).status, 0);
});
test('upload recreates its own key and cleans both temporary copies', () => {
  const upload = workflow
    .split('      - name: Upload and verify staging build')[1]!
    .split('      - name:')[0];
  assert.ok(upload.includes('ASC_KEY_P8: ${{ secrets.ASC_KEY_P8 }}'));
  assert.ok(upload.includes('printf \'%s\' "$ASC_KEY_P8" > "$key_path"'));
  assert.ok(
    upload.includes(
      'trap \'rm -f "$key_path" "$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"\' EXIT',
    ),
  );
  assert.ok(build.includes('EXPO_APPLE_TEAM_TYPE: ${{ vars.APPLE_TEAM_TYPE }}'));
  assert.ok(build.includes('secrets.STAGING_ASC_APP_ID'));
});
