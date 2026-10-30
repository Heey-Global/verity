import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('staging CPU diagnostic distribution', () => {
  it.each(['valid', 'map', 'commit', 'ota', 'duplicate', 'missing'])(
    'checks the archived IPA against the retained map: %s',
    (scenario) => {
      execFileSync(
        'python3',
        [
          '-c',
          `
import hashlib, importlib.util, json, pathlib, plistlib, sys, tempfile, zipfile
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('retain', 'scripts/retain-mobile-profile-map.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = sys.argv[1]
commit = 'a' * 40
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    maps = root / 'build' / 'profiling-artifacts'
    maps.mkdir(parents=True)
    content = b'{"version":3}'
    identity = {'schema':1, 'commit':commit, 'mapSha256':hashlib.sha256(content).hexdigest()}
    (maps / 'main.jsbundle.map').write_bytes(content if scenario != 'map' else b'changed')
    (maps / 'manifest.json').write_text(json.dumps(identity))
    if scenario == 'duplicate':
        other = root / 'other' / 'profiling-artifacts'
        other.mkdir(parents=True)
        for path in maps.iterdir(): (other / path.name).write_bytes(path.read_bytes())
    ipa = root / 'app.ipa'
    with zipfile.ZipFile(ipa, 'w') as archive:
        if scenario != 'missing': archive.writestr('Payload/App.app/verity-profile-map.json', json.dumps(identity))
        archive.writestr('Payload/App.app/Info.plist', plistlib.dumps({'CFBundleVersion':'42', 'VerityProfileCommit':commit if scenario != 'commit' else 'b'*40}))
        archive.writestr('Payload/App.app/Expo.plist', plistlib.dumps({'EXUpdatesEnabled':scenario == 'ota'}))
    try:
        module.retain(root, ipa, commit, root / 'retained')
    except ValueError:
        assert scenario != 'valid'
        assert not (root / 'retained').exists()
    else:
        assert scenario == 'valid', 'Invalid build accepted: ' + scenario
        assert (root / 'retained' / 'main.jsbundle.map').read_bytes() == content
        assert json.loads((root / 'retained' / 'build.json').read_text())['buildNumber'] == '42'
`,
          scenario,
        ],
        { stdio: 'pipe' },
      );
    },
  );

  it.each(['valid', 'bundle', 'ota'])(
    'retains regular staging with exact archived bytecode: %s',
    (scenario) => {
      execFileSync(
        'python3',
        [
          '-c',
          `
import hashlib, importlib.util, json, pathlib, plistlib, sys, tempfile, zipfile
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('retain', 'scripts/retain-mobile-profile-map.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
scenario = sys.argv[1]; commit = 'a'*40
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp); maps = root/'build'/'profiling-artifacts'; maps.mkdir(parents=True)
    data = b'{"version":3}'; bundle = b'compiled Hermes'
    identity = {'schema':2,'commit':commit,'mapSha256':hashlib.sha256(data).hexdigest(),'bundleSha256':hashlib.sha256(bundle).hexdigest()}
    (maps/'manifest.json').write_text(json.dumps(identity)); (maps/'main.jsbundle.map').write_bytes(data)
    ipa = root/'app.ipa'
    with zipfile.ZipFile(ipa, 'w') as archive:
        archive.writestr('Payload/App.app/verity-profile-map.json', json.dumps(identity))
        archive.writestr('Payload/App.app/main.jsbundle', bundle if scenario != 'bundle' else b'other build')
        archive.writestr('Payload/App.app/Info.plist', plistlib.dumps({'CFBundleVersion':'33','VerityCPUProfiling':True}))
        archive.writestr('Payload/App.app/Expo.plist', plistlib.dumps({'EXUpdatesEnabled':scenario != 'ota'}))
    try: module.retain(root, ipa, commit, root/'retained', 'staging')
    except ValueError: assert scenario != 'valid'
    else: assert scenario == 'valid'
`,
          scenario,
        ],
        { stdio: 'pipe' },
      );
    },
  );
  it('uploads recoverable OTA maps before channel delivery', () => {
    const workflow = parse(readFileSync('.github/workflows/mobile-ota.yml', 'utf8'));
    const jobs = Object.values(workflow.jobs) as {
      steps: { run?: string; uses?: string; with?: Record<string, unknown> }[];
    }[];
    const steps = jobs.flatMap((job) => job.steps);
    const prepare = steps.findIndex((step) =>
      step.run?.includes('mobile-ota-release.ts stage-map '),
    );
    const retain = steps.findIndex(
      (step) =>
        typeof step.with?.path === 'string' && step.with.path.includes('profiling-artifacts/ota-'),
    );
    const deliver = steps.findIndex((step) => step.run?.includes('mobile-ota-release.ts stage '));
    expect(prepare).toBeGreaterThan(-1);
    expect(retain).toBeGreaterThan(prepare);
    expect(deliver).toBeGreaterThan(retain);
    expect(steps[retain].with?.overwrite).toBe(true);
    expect(steps[retain].with?.['if-no-files-found']).toBe('error');
  });
  it('retains the validated map before upload and isolates diagnostics from release evidence', () => {
    const workflow = parse(readFileSync('.github/workflows/mobile-native-build.yml', 'utf8'));
    const job = workflow.jobs.build;
    const steps = job.steps as {
      name?: string;
      if?: string;
      run?: string;
      with?: Record<string, unknown>;
    }[];
    const collect = steps.findIndex((step) => step.name === 'Collect exact profiling source map');
    const retain = steps.findIndex(
      (step) => step.name === 'Retain exact profiling source map before upload',
    );
    const upload = steps.findIndex((step) => step.name === 'Upload and verify staging build');
    expect(collect).toBeGreaterThan(0);
    expect(retain).toBeGreaterThan(collect);
    expect(upload).toBeGreaterThan(retain);
    expect(steps[retain].with?.['if-no-files-found']).toBe('error');
    expect(job.env.NATIVE_PROFILE).toContain("inputs.profile-source != '' && 'profiling'");
    expect(job.env.VERITY_APP_VARIANT).toContain("&& 'staging'");
    expect(job.concurrency['cancel-in-progress']).toBe(false);
    expect(steps.find((step) => step.name === 'Require merged profiling source')?.run).toContain(
      'git merge-base --is-ancestor HEAD origin/main',
    );
    for (const name of ['Sign staging build evidence', 'Record exact native candidate']) {
      expect(steps.find((step) => step.name === name)?.if).toContain("inputs.profile-source == ''");
    }
  });
});
